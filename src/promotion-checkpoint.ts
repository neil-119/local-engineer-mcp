/** Host-private promotion checkpoints. Neither the ledger nor its Git object store is worker-mounted. */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertCanonicalPathSafe,
  git,
  parseIndex,
  safeRepositoryPath,
  validateRepositoryChanges,
  type RepositoryChanges,
  type RepositorySnapshot,
} from './repository-snapshot.js';

/** Only this typed error proves the manager never entered its host-write phase. */
export class PromotionPreflightError extends Error {}

export interface PromotionCheckpoint {
  tree: string;
  parentWorktree: Record<string, string>;
  parentIndex: Record<string, string>;
}
export interface PromotionLedger {
  schema_version: 1;
  phase: 'applying' | 'complete';
  revision: number;
  digest: string;
  repositories: Record<string, PromotionCheckpoint>;
}

export function loadPromotionLedger(state: string): PromotionLedger | undefined {
  const path = join(state, 'promotion-checkpoint.json');
  if (!existsSync(path)) return;
  const ledger = JSON.parse(readFileSync(path, 'utf8')) as PromotionLedger;
  if (
    ledger.schema_version !== 1 ||
    !['applying', 'complete'].includes(ledger.phase) ||
    !Number.isSafeInteger(ledger.revision) ||
    ledger.revision < 1 ||
    !/^sha256:[a-f0-9]{64}$/.test(ledger.digest) ||
    !ledger.repositories ||
    typeof ledger.repositories !== 'object' ||
    Array.isArray(ledger.repositories)
  ) {
    throw new Error('PROMOTION_CHECKPOINT_INVALID');
  }
  for (const checkpoint of Object.values(ledger.repositories)) {
    if (
      !checkpoint ||
      !/^[a-f0-9]{40,64}$/.test(checkpoint.tree) ||
      !checkpoint.parentWorktree ||
      typeof checkpoint.parentWorktree !== 'object' ||
      Array.isArray(checkpoint.parentWorktree) ||
      !checkpoint.parentIndex ||
      typeof checkpoint.parentIndex !== 'object' ||
      Array.isArray(checkpoint.parentIndex)
    ) {
      throw new Error('PROMOTION_CHECKPOINT_INVALID');
    }
    for (const [path, fingerprint] of Object.entries(checkpoint.parentWorktree)) {
      safeRepositoryPath(state, path);
      if (typeof fingerprint !== 'string' || !/^file:\d+:[a-f0-9]{64}$/.test(fingerprint)) {
        throw new Error('PROMOTION_CHECKPOINT_INVALID');
      }
    }
    for (const [path, index] of Object.entries(checkpoint.parentIndex)) {
      safeRepositoryPath(state, path);
      if (typeof index !== 'string' || !/^\d{6} [a-f0-9]{40,64} [0-3]$/.test(index)) {
        throw new Error('PROMOTION_CHECKPOINT_INVALID');
      }
    }
  }
  return ledger;
}

export function savePromotionLedger(state: string, ledger: PromotionLedger): void {
  const temporary = join(state, `promotion-checkpoint-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(ledger, null, 2), { mode: 0o600, flag: 'wx', flush: true });
    renameSync(temporary, join(state, 'promotion-checkpoint.json'));
  } finally {
    if (existsSync(temporary)) rmSync(temporary);
  }
}

/** Reconstruct the reviewed tree using only the immutable baseline and bounded captured patch, never worker .git. */
export async function preparePromotion(
  snapshot: RepositorySnapshot,
  full: RepositoryChanges,
  checkpoint?: PromotionCheckpoint,
): Promise<{ snapshot: RepositorySnapshot; changes: RepositoryChanges; tree: string }> {
  await validateRepositoryChanges(snapshot, full);
  const temporary = mkdtempSync(join(tmpdir(), 'le-promotion-index-'));
  const env = { GIT_INDEX_FILE: join(temporary, 'index') };
  try {
    await git(snapshot.snapshotPath, ['read-tree', snapshot.baselineCommit], undefined, env);
    if (full.patch.trim())
      await git(snapshot.snapshotPath, ['apply', '--cached', '--binary', '--whitespace=nowarn', '-'], full.patch, env);
    const tree = (await git(snapshot.snapshotPath, ['write-tree'], undefined, env)).trim();
    const base = checkpoint?.tree ?? snapshot.baselineCommit;
    const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', base, tree];
    const patch = await git(snapshot.snapshotPath, [...args, '--binary', '--full-index']);
    if (Buffer.byteLength(patch) > 16 * 1024 * 1024) throw new Error('CONTAINER_PATCH_TOO_LARGE');
    const names = await git(snapshot.snapshotPath, [...args, '--name-only', '-z']);
    const numstat = await git(snapshot.snapshotPath, [...args, '--numstat']);
    let additions = 0;
    let deletions = 0;
    for (const line of numstat.split('\n')) {
      const [added, removed] = line.split('\t');
      if (added && /^\d+$/.test(added)) additions += Number(added);
      if (removed && /^\d+$/.test(removed)) deletions += Number(removed);
    }
    return {
      snapshot: {
        ...snapshot,
        baselineCommit: base,
        parentWorktree: checkpoint?.parentWorktree ?? snapshot.parentWorktree,
        parentIndex: checkpoint?.parentIndex ?? snapshot.parentIndex,
      },
      changes: {
        patch,
        patchDigest: `sha256:${createHash('sha256').update(patch).digest('hex')}`,
        changedPaths: names.split('\0').filter(Boolean),
        additions,
        deletions,
      },
      tree,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Verify applied bytes before recording their exact fingerprint. Only Windows checkout CRLF conversion is tolerated. */
export async function checkpointPromotion(
  snapshot: RepositorySnapshot,
  changes: RepositoryChanges,
  tree: string,
): Promise<PromotionCheckpoint> {
  if ((await git(snapshot.parentPath, ['rev-parse', '--verify', 'HEAD'])).trim() !== snapshot.parentHead) {
    throw new Error('PROMOTION_PARENT_HEAD_CHANGED');
  }
  const index = parseIndex(await git(snapshot.parentPath, ['ls-files', '--stage', '-z']));
  const parentWorktree = { ...snapshot.parentWorktree };
  for (const path of changes.changedPaths) {
    assertCanonicalPathSafe(snapshot.parentPath, path);
    if (index[path] !== snapshot.parentIndex[path]) throw new Error(`PROMOTION_PARENT_INDEX_CHANGED:${path}`);
    const file = safeRepositoryPath(snapshot.parentPath, path);
    const entry = (await git(snapshot.snapshotPath, ['--literal-pathspecs', 'ls-tree', tree, '--', path])).trim();
    if (!entry) {
      if (existsSync(file)) throw new Error(`PROMOTION_APPLIED_CONTENT_MISMATCH:${path}`);
      delete parentWorktree[path];
      continue;
    }
    const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t/.exec(entry);
    if (!match || !existsSync(file) || !lstatSync(file).isFile())
      throw new Error(`PROMOTION_APPLIED_CONTENT_MISMATCH:${path}`);
    const expected = execFileSync('git', ['-C', snapshot.snapshotPath, 'cat-file', 'blob', match[2]!], {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    const stat = lstatSync(file);
    const actual = readFileSync(file);
    const windowsText =
      process.platform === 'win32' &&
      !expected.includes(0) &&
      !actual.includes(0) &&
      Buffer.from(expected.toString('utf8')).equals(expected);
    const crlf = windowsText ? Buffer.from(expected.toString('utf8').replace(/\r?\n/g, '\r\n')) : expected;
    if (
      (!actual.equals(expected) && !actual.equals(crlf)) ||
      (process.platform !== 'win32' && Boolean(stat.mode & 0o111) !== (match[1] === '100755'))
    ) {
      throw new Error(`PROMOTION_APPLIED_CONTENT_MISMATCH:${path}`);
    }
    // Hash the same bytes that were verified, not a second read that could bless a concurrent external edit.
    parentWorktree[path] = `file:${stat.mode & 0o777}:${createHash('sha256').update(actual).digest('hex')}`;
  }
  // Pin the tree so routine Git garbage collection cannot discard a persisted checkpoint.
  await git(snapshot.snapshotPath, ['update-ref', `refs/local-engineer/promoted-trees/${tree}`, tree]);
  return { tree, parentWorktree, parentIndex: { ...snapshot.parentIndex } };
}
