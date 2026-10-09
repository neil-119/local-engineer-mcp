/**
 * Repository Snapshotting & Safe Review Promotion
 *
 * Implements isolated snapshotting of host repositories and conflict-checked promotion of reviewed changes:
 * - Creates an isolated, ephemeral snapshot of the parent repository checkout.
 * - If the host repository has uncommitted changes, folds them into an ephemeral commit
 *   so the container agent begins with the user's exact working state without modifying host Git history.
 * - Tracks exact index hashes and file byte/mode fingerprints to detect
 *   and overlapping host modifications during review promotion.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { hasNtfsShortNameAlias, isManagedDependencyPath } from './dependency-mount.js';

export interface RepositorySnapshot {
  parentPath: string;
  snapshotPath: string;
  parentHead: string;
  baselineCommit: string;
  baselineKind: 'clean_head' | 'ephemeral_dirty_snapshot';
  ignoredPaths: string[];
  parentWorktree: Record<string, string>;
  parentIndex: Record<string, string>;
}

export interface RepositoryChanges {
  patch: string;
  patchDigest: string;
  changedPaths: string[];
  additions: number;
  deletions: number;
}

/**
 * Creates an isolated snapshot of a host Git repository for container staging:
 * - Captures tracked, untracked, and ignored paths.
 * - If dirty, creates an ephemeral baseline commit capturing uncommitted changes.
 * - Fingerprints the parent index and working tree to guard against concurrent promotion conflicts.
 */
export async function createRepositorySnapshot(parentPath: string, snapshotPath: string): Promise<RepositorySnapshot> {
  const parent = realpathSync.native(parentPath);
  const topLevel = realpathSync.native((await git(parent, ['rev-parse', '--show-toplevel'])).trim());
  // A caller may intentionally scope a worker to a project directory inside a
  // larger checkout. Snapshot the actual checkout so Git state and promotion
  // checks remain correct; the container working directory is handled by the
  // caller separately.
  const repositoryRoot = topLevel;
  let parentHead: string;
  try {
    parentHead = (await git(repositoryRoot, ['rev-parse', '--verify', 'HEAD'])).trim();
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith('GIT_COMMAND_FAILED:rev-parse --verify HEAD:')) {
      throw new Error('REPOSITORY_HEAD_REQUIRED');
    }
    throw cause;
  }
  if (!/^[0-9a-f]{40,64}$/i.test(parentHead)) throw new Error('REPOSITORY_HEAD_INVALID');
  if ((await git(repositoryRoot, ['diff', '--name-only', '--diff-filter=U'])).trim())
    throw new Error('REPOSITORY_HAS_UNMERGED_PATHS');
  const dirty = (await git(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).length > 0;
  const trackedPaths = nulPaths(await git(repositoryRoot, ['ls-files', '-z']));
  const untrackedPaths = nulPaths(await git(repositoryRoot, ['ls-files', '-z', '--others', '--exclude-standard']));
  const ignoredPaths = copyRoots(
    nulPaths(
      await git(repositoryRoot, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']),
    ),
  );
  for (const path of [...trackedPaths, ...untrackedPaths]) assertNoNestedRepository(repositoryRoot, path);
  for (const path of ignoredPaths) safeRepositoryPath(repositoryRoot, path);
  const parentWorktree = Object.fromEntries(
    [...new Set([...trackedPaths, ...untrackedPaths])]
      .filter((path) => existsSync(safeRepositoryPath(repositoryRoot, path)))
      .map((path) => [path, worktreeFingerprint(safeRepositoryPath(repositoryRoot, path))]),
  );
  const parentIndex = parseIndex(await git(repositoryRoot, ['ls-files', '--stage', '-z']));
  if (existsSync(snapshotPath)) throw new Error('SNAPSHOT_PATH_EXISTS');
  mkdirSync(dirname(snapshotPath), { recursive: true });
  await git(dirname(snapshotPath), ['clone', '--no-hardlinks', '--no-checkout', repositoryRoot, snapshotPath]);
  const autoCrlf = await gitOptional(repositoryRoot, ['config', '--get', 'core.autocrlf']);
  const coreEol = await gitOptional(repositoryRoot, ['config', '--get', 'core.eol']);
  if (autoCrlf.trim()) await git(snapshotPath, ['config', 'core.autocrlf', autoCrlf.trim()]);
  if (coreEol.trim()) await git(snapshotPath, ['config', 'core.eol', coreEol.trim()]);
  await git(snapshotPath, ['checkout', '--detach', parentHead]);

  for (const path of trackedPaths) {
    const source = safeRepositoryPath(repositoryRoot, path);
    const destination = safeRepositoryPath(snapshotPath, path);
    if (!existsSync(source)) {
      rmSync(destination, { force: true });
      continue;
    }
    if (!lstatSync(source).isFile()) throw new Error('SNAPSHOT_TRACKED_NON_FILE_UNSUPPORTED');
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  for (const path of untrackedPaths) {
    const source = safeRepositoryPath(repositoryRoot, path);
    const destination = safeRepositoryPath(snapshotPath, path);
    if (!lstatSync(source).isFile()) throw new Error('SNAPSHOT_UNTRACKED_NON_FILE_UNSUPPORTED');
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }

  if (dirty) {
    await git(snapshotPath, ['config', 'user.name', 'Local Engineer Snapshot']);
    await git(snapshotPath, ['config', 'user.email', 'snapshot@local-engineer.invalid']);
    await git(snapshotPath, ['config', 'commit.gpgSign', 'false']);
    await git(snapshotPath, ['config', 'core.hooksPath', '.local-engineer-no-hooks']);
    await git(snapshotPath, ['add', '-A']);
    await git(snapshotPath, [
      'commit',
      '--no-verify',
      '--no-gpg-sign',
      '-m',
      'Local Engineer ephemeral workspace baseline',
    ]);
  }
  const baselineCommit = (await git(snapshotPath, ['rev-parse', 'HEAD'])).trim();
  return {
    parentPath: repositoryRoot,
    snapshotPath: realpathSync.native(snapshotPath),
    parentHead,
    baselineCommit,
    baselineKind: dirty ? 'ephemeral_dirty_snapshot' : 'clean_head',
    ignoredPaths,
    parentWorktree,
    parentIndex,
  };
}

/**
 * Rebuild snapshot metadata from a retained private Git snapshot. This is used
 * only after an STDIO MCP process is replaced; the snapshot itself remains the
 * authoritative baseline for later promotion checks.
 */
export async function recoverRepositorySnapshot(
  parentPath: string,
  snapshotPath: string,
  parentHead: string,
  baselineCommit: string,
  baselineKind: RepositorySnapshot['baselineKind'],
): Promise<RepositorySnapshot> {
  if (!existsSync(snapshotPath)) throw new Error('SNAPSHOT_PATH_NOT_FOUND');
  const parent = realpathSync.native(parentPath);
  const repositoryRoot = realpathSync.native((await git(parent, ['rev-parse', '--show-toplevel'])).trim());
  const snapshot = realpathSync.native(snapshotPath);
  const trackedPaths = nulPaths(await git(snapshot, ['ls-files', '-z']));
  const parentWorktree = Object.fromEntries(
    trackedPaths
      .filter((path) => existsSync(safeRepositoryPath(snapshot, path)))
      .map((path) => [path, worktreeFingerprint(safeRepositoryPath(snapshot, path))]),
  );
  return {
    parentPath: repositoryRoot,
    snapshotPath: snapshot,
    parentHead,
    baselineCommit,
    baselineKind,
    ignoredPaths: [],
    parentWorktree,
    parentIndex: parseIndex(await git(snapshot, ['ls-files', '--stage', '-z'])),
  };
}

export async function captureRepositoryChanges(snapshot: RepositorySnapshot): Promise<RepositoryChanges> {
  await git(snapshot.snapshotPath, ['add', '-A']);
  const patch = await git(snapshot.snapshotPath, [
    'diff',
    '--cached',
    '--binary',
    '--full-index',
    '--no-renames',
    snapshot.baselineCommit,
  ]);
  const changedPaths = nulPaths(
    await git(snapshot.snapshotPath, [
      'diff',
      '--cached',
      '--name-only',
      '-z',
      '--no-renames',
      snapshot.baselineCommit,
    ]),
  );
  const numstat = await git(snapshot.snapshotPath, [
    'diff',
    '--cached',
    '--numstat',
    '--no-renames',
    snapshot.baselineCommit,
  ]);
  let additions = 0;
  let deletions = 0;
  for (const line of numstat.split(/\r?\n/)) {
    if (!line) continue;
    const [added, deleted] = line.split('\t');
    if (added && /^\d+$/.test(added)) additions += Number(added);
    if (deleted && /^\d+$/.test(deleted)) deletions += Number(deleted);
  }
  return {
    patch,
    patchDigest: `sha256:${createHash('sha256').update(patch).digest('hex')}`,
    changedPaths,
    additions,
    deletions,
  };
}

/**
 * Unquotes and decodes Git C-style quoted pathnames (e.g. \156 to n, octal escapes, \", etc.).
 */
export function unquoteGitPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"') || trimmed.length < 2) return trimmed;
  const inner = trimmed.slice(1, -1);
  return inner.replace(/\\(?:([0-7]{1,3})|([abtnvfr"\\]))/g, (_match, octal, char) => {
    if (octal) return String.fromCharCode(parseInt(octal, 8));
    switch (char) {
      case 'a':
        return '\x07';
      case 'b':
        return '\b';
      case 't':
        return '\t';
      case 'n':
        return '\n';
      case 'v':
        return '\v';
      case 'f':
        return '\f';
      case 'r':
        return '\r';
      case '"':
        return '"';
      case '\\':
        return '\\';
      default:
        return char;
    }
  });
}

/**
 * Parses source and destination paths from a raw diff --git header line, decoding C-style quoting.
 */
export function parseDiffGitHeader(line: string): [string, string] | null {
  if (!line.startsWith('diff --git ')) return null;
  const rest = line.slice('diff --git '.length).trim();
  let partA: string | undefined;
  let partB: string | undefined;
  if (rest.startsWith('"')) {
    let i = 1;
    while (i < rest.length) {
      if (rest[i] === '\\') i += 2;
      else if (rest[i] === '"') break;
      else i++;
    }
    partA = rest.slice(0, i + 1);
    partB = rest.slice(i + 1).trim();
  } else {
    if (rest.startsWith('a/')) {
      const withoutA = rest.slice(2);
      const halfLen = (withoutA.length - 3) / 2;
      if (
        halfLen > 0 &&
        Number.isInteger(halfLen) &&
        withoutA.slice(halfLen, halfLen + 3) === ' b/' &&
        withoutA.slice(0, halfLen) === withoutA.slice(halfLen + 3)
      ) {
        partA = 'a/' + withoutA.slice(0, halfLen);
        partB = 'b/' + withoutA.slice(halfLen + 3);
      }
    }
    if (!partA) {
      if (rest.endsWith('"')) {
        const qIdx = rest.indexOf(' "');
        if (qIdx !== -1) {
          partA = rest.slice(0, qIdx);
          partB = rest.slice(qIdx + 1).trim();
        }
      }
      if (!partA) {
        const bIdx = rest.lastIndexOf(' b/');
        if (bIdx !== -1) {
          partA = rest.slice(0, bIdx);
          partB = rest.slice(bIdx + 1).trim();
        } else {
          const match = rest.match(/^(a\/\S+)\s+(.+)$/);
          if (!match) return null;
          partA = match[1]!;
          partB = match[2]!;
        }
      }
    }
  }
  if (!partA || !partB) return null;
  const unquotedA = unquoteGitPath(partA);
  const unquotedB = unquoteGitPath(partB);
  const cleanA = unquotedA.startsWith('a/') ? unquotedA.slice(2) : unquotedA;
  const cleanB = unquotedB.startsWith('b/') ? unquotedB.slice(2) : unquotedB;
  return [cleanA, cleanB];
}

/**
 * Parses path from directives like "rename from ", "--- ", etc., decoding C-style quoting.
 */
export function parsePathFromDirective(line: string, directive: string): string | null {
  if (!line.startsWith(directive)) return null;
  const raw = line.slice(directive.length).trim();
  const unquoted = unquoteGitPath(raw);
  if (unquoted === '/dev/null') return null;
  if (unquoted.startsWith('a/')) return unquoted.slice(2);
  if (unquoted.startsWith('b/')) return unquoted.slice(2);
  return unquoted;
}

/**
 * Independently extracts all affected relative paths from a unified diff patch.
 * Uses trusted temporary index seeded from baselineCommit with --no-renames when available,
 * as well as git apply --numstat -z, git apply --summary, and raw header inspection with C-style unquoting.
 */
export async function extractPatchPaths(
  repositoryPath: string,
  patch: string,
  baselineCommit?: string,
): Promise<string[]> {
  if (!patch || !patch.trim()) return [];
  const paths = new Set<string>();

  // 1. Authoritative delta via trusted temporary index seeded from baselineCommit with --no-renames
  if (baselineCommit) {
    const tempIndexDir = mkdtempSync(join(tmpdir(), 'git-temp-index-'));
    const tempIndexFile = join(tempIndexDir, 'index');
    const env = { GIT_INDEX_FILE: tempIndexFile };
    try {
      await git(repositoryPath, ['read-tree', baselineCommit], undefined, env);
      await git(repositoryPath, ['apply', '--cached', '--binary', '--whitespace=nowarn', '-'], patch, env);
      const output = await git(
        repositoryPath,
        ['diff-index', '--cached', '--name-only', '-z', '--no-renames', baselineCommit],
        undefined,
        env,
      );
      for (const p of output.split('\0').filter(Boolean)) {
        paths.add(p);
      }
      return [...paths];
    } finally {
      try {
        rmSync(tempIndexDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  }

  // 2. Parse git apply --numstat -z
  try {
    const output = await git(repositoryPath, ['apply', '--numstat', '-z', '-'], patch);
    for (const record of output.split('\0').filter(Boolean)) {
      const parts = record.split('\t');
      if (parts.length >= 3) {
        const p = parts.slice(2).join('\t');
        if (p) paths.add(p);
      }
    }
  } catch {
    // ignore
  }

  // 3. Parse git apply --summary for decoded rename/copy/create/delete paths
  try {
    const summary = await gitOptional(repositoryPath, ['apply', '--summary', '-'], patch);
    if (summary) {
      for (const line of summary.split(/\r?\n/)) {
        const renameMatch = line.match(/^\s*(?:rename|copy)\s+(.+?)\s+=>\s+(.+?)(?:\s+\(\d+%\))?$/);
        if (renameMatch) {
          if (renameMatch[1]) paths.add(renameMatch[1].trim());
          if (renameMatch[2]) paths.add(renameMatch[2].trim());
        }
      }
    }
  } catch {
    // ignore
  }

  // 4. Raw header parsing with Git C-style unquoting, tracking header vs hunk state
  let inHeader = false;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      inHeader = true;
      const diffHdr = parseDiffGitHeader(line);
      if (diffHdr) {
        if (diffHdr[0]) paths.add(diffHdr[0]);
        if (diffHdr[1]) paths.add(diffHdr[1]);
      }
      continue;
    }
    if (line.startsWith('@@')) {
      inHeader = false;
      continue;
    }
    if (inHeader) {
      for (const directive of ['rename from ', 'rename to ', 'copy from ', 'copy to ', '--- ', '+++ ']) {
        const p = parsePathFromDirective(line, directive);
        if (p) paths.add(p);
      }
    }
  }

  return [...paths];
}

/**
 * Verifies that the host repository's HEAD, index, and affected working tree files
 * have not diverged since the snapshot was taken, and tests that the patch applies cleanly.
 */
export async function validateRepositoryChanges(
  snapshot: RepositorySnapshot,
  changes: RepositoryChanges,
): Promise<void> {
  // 1. If patch has content, enforce add/update/delete patch contract (no renames/copies)
  if (changes.patch && changes.patch.trim()) {
    const summary = await gitOptional(snapshot.snapshotPath, ['apply', '--summary', '-'], changes.patch);
    if (summary) {
      for (const line of summary.split(/\r?\n/)) {
        const renameMatch = line.match(/^\s*(?:rename|copy)\s+(.+?)\s+=>\s+(.+?)(?:\s+\(\d+%\))?$/);
        if (renameMatch) {
          const src = renameMatch[1]?.trim() ?? '';
          const dst = renameMatch[2]?.trim() ?? '';
          if (isManagedDependencyPath(src) || hasNtfsShortNameAlias(src)) {
            throw new Error(`PROMOTION_MANAGED_DEPENDENCY_PATH_NOT_PERMITTED:${src}`);
          }
          if (isManagedDependencyPath(dst) || hasNtfsShortNameAlias(dst)) {
            throw new Error(`PROMOTION_MANAGED_DEPENDENCY_PATH_NOT_PERMITTED:${dst}`);
          }
          throw new Error('PROMOTION_PATCH_RENAME_NOT_PERMITTED');
        }
      }
    }

    let inHeader = false;
    for (const line of changes.patch.split(/\r?\n/)) {
      if (line.startsWith('diff --git ')) {
        inHeader = true;
        const diffHdr = parseDiffGitHeader(line);
        if (diffHdr) {
          if (isManagedDependencyPath(diffHdr[0]) || hasNtfsShortNameAlias(diffHdr[0])) {
            throw new Error(`PROMOTION_MANAGED_DEPENDENCY_PATH_NOT_PERMITTED:${diffHdr[0]}`);
          }
          if (isManagedDependencyPath(diffHdr[1]) || hasNtfsShortNameAlias(diffHdr[1])) {
            throw new Error(`PROMOTION_MANAGED_DEPENDENCY_PATH_NOT_PERMITTED:${diffHdr[1]}`);
          }
          if (diffHdr[0] !== diffHdr[1]) {
            throw new Error('PROMOTION_PATCH_RENAME_NOT_PERMITTED');
          }
        }
        continue;
      }
      if (line.startsWith('@@')) {
        inHeader = false;
        continue;
      }
      if (inHeader) {
        for (const directive of ['rename from ', 'rename to ', 'copy from ', 'copy to ']) {
          const p = parsePathFromDirective(line, directive);
          if (p) {
            if (isManagedDependencyPath(p) || hasNtfsShortNameAlias(p)) {
              throw new Error(`PROMOTION_MANAGED_DEPENDENCY_PATH_NOT_PERMITTED:${p}`);
            }
            throw new Error('PROMOTION_PATCH_RENAME_NOT_PERMITTED');
          }
        }
        for (const directive of ['--- ', '+++ ']) {
          const p = parsePathFromDirective(line, directive);
          if (p && (isManagedDependencyPath(p) || hasNtfsShortNameAlias(p))) {
            throw new Error(`PROMOTION_MANAGED_DEPENDENCY_PATH_NOT_PERMITTED:${p}`);
          }
        }
      }
    }
  }

  // 2. Extract all affected paths independently using immutable snapshot baseline
  const patchPaths = await extractPatchPaths(snapshot.snapshotPath, changes.patch, snapshot.baselineCommit);
  for (const path of patchPaths) {
    if (isManagedDependencyPath(path) || hasNtfsShortNameAlias(path)) {
      throw new Error(`PROMOTION_MANAGED_DEPENDENCY_PATH_NOT_PERMITTED:${path}`);
    }
  }
  for (const path of changes.changedPaths) {
    if (isManagedDependencyPath(path) || hasNtfsShortNameAlias(path)) {
      throw new Error(`PROMOTION_MANAGED_DEPENDENCY_PATH_NOT_PERMITTED:${path}`);
    }
  }

  // 3. Metadata consistency check
  const declaredSet = new Set(changes.changedPaths);
  const patchSet = new Set(patchPaths);
  if (
    declaredSet.size !== changes.changedPaths.length ||
    declaredSet.size !== patchSet.size ||
    !changes.changedPaths.every((p) => patchSet.has(p))
  ) {
    throw new Error('PROMOTION_PATCH_INCONSISTENT_METADATA');
  }
}

export async function checkRepositoryPromotion(
  snapshot: RepositorySnapshot,
  changes: RepositoryChanges,
): Promise<void> {
  await validateRepositoryChanges(snapshot, changes);
  // 4. Verify parent HEAD
  const currentHead = (await git(snapshot.parentPath, ['rev-parse', '--verify', 'HEAD'])).trim();
  if (currentHead !== snapshot.parentHead) throw new Error('PROMOTION_PARENT_HEAD_CHANGED');

  // 5. Verify index and worktree fingerprints for all affected paths
  const currentIndex = parseIndex(await git(snapshot.parentPath, ['ls-files', '--stage', '-z']));
  const allAffected = new Set(changes.changedPaths);
  for (const path of allAffected) {
    assertCanonicalPathSafe(snapshot.parentPath, path);
    const parentFile = safeRepositoryPath(snapshot.parentPath, path);
    const currentFingerprint = existsSync(parentFile) ? worktreeFingerprint(parentFile) : undefined;
    if (currentFingerprint !== snapshot.parentWorktree[path]) throw new Error(`PROMOTION_PARENT_PATH_CHANGED:${path}`);
    if (currentIndex[path] !== snapshot.parentIndex[path]) throw new Error(`PROMOTION_PARENT_INDEX_CHANGED:${path}`);
  }

  if (!changes.patch || !changes.patch.trim()) return;
  await git(snapshot.parentPath, ['apply', '--check', '--binary', '--whitespace=nowarn', '-'], changes.patch);
}

/**
 * Validates and applies reviewed unified diff patches to the parent repository checkout.
 */
export async function promoteRepositoryChanges(
  snapshot: RepositorySnapshot,
  changes: RepositoryChanges,
): Promise<void> {
  await checkRepositoryPromotion(snapshot, changes);
  if (!changes.patch) return;
  await git(snapshot.parentPath, ['apply', '--binary', '--whitespace=nowarn', '-'], changes.patch);
}

export function writePatchArtifact(path: string, changes: RepositoryChanges): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, changes.patch, { encoding: 'utf8', mode: 0o600 });
}

export function removeSnapshot(snapshot: RepositorySnapshot): void {
  const resolved = resolve(snapshot.snapshotPath);
  if (resolved === resolve(snapshot.parentPath) || !existsSync(resolved)) return;
  rmSync(resolved, { recursive: true, force: true });
}

export function readSnapshotFile(snapshot: RepositorySnapshot, path: string, maximumBytes: number): Buffer {
  const file = safeRepositoryPath(snapshot.snapshotPath, path);
  const size = statSync(file).size;
  if (size > maximumBytes) throw new Error('SNAPSHOT_FILE_TOO_LARGE');
  return readFileSync(file);
}

export function safeRepositoryPath(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.split(/[\\/]+/).includes('..') || path.includes('\0') || path.includes(':'))
    throw new Error('REPOSITORY_RELATIVE_PATH_INVALID');
  if (process.platform === 'win32') {
    const segments = path.split(/[\\/]+/);
    for (const segment of segments) {
      if (hasNtfsShortNameAlias(segment) || segment.endsWith(' ') || segment.endsWith('.')) {
        throw new Error('REPOSITORY_RELATIVE_PATH_INVALID');
      }
    }
  }
  const destination = resolve(root, path);
  const relativePath = relative(resolve(root), destination);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath))
    throw new Error('REPOSITORY_PATH_ESCAPE');
  return destination;
}

export function assertCanonicalPathSafe(parentPath: string, targetRelPath: string): void {
  if (isManagedDependencyPath(targetRelPath) || hasNtfsShortNameAlias(targetRelPath)) {
    throw new Error(`PROMOTION_MANAGED_DEPENDENCY_PATH_NOT_PERMITTED:${targetRelPath}`);
  }
  safeRepositoryPath(parentPath, targetRelPath);

  const canonicalParent = realpathSync.native(parentPath);
  const hostTarget = resolve(parentPath, targetRelPath);

  let current = hostTarget;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  if (!existsSync(current)) {
    throw new Error(`PROMOTION_PATH_ESCAPE:${targetRelPath}`);
  }

  const canonicalAncestor = realpathSync.native(current);
  const relFromParent = relative(canonicalParent, canonicalAncestor).replace(/\\/g, '/');

  if (relFromParent === '..' || relFromParent.startsWith('../') || isAbsolute(relFromParent)) {
    throw new Error(`PROMOTION_PATH_ESCAPE:${targetRelPath}`);
  }

  if (relFromParent && isManagedDependencyPath(relFromParent)) {
    throw new Error(`PROMOTION_MANAGED_DEPENDENCY_PATH_NOT_PERMITTED:${targetRelPath}`);
  }
}

function nulPaths(value: string): string[] {
  return value.split('\0').filter(Boolean);
}

function copyRoots(paths: string[]): string[] {
  const roots: string[] = [];
  for (const path of [...new Set(paths)]
    .map((value) => value.replace(/[\\/]+$/, ''))
    .sort((a, b) => a.length - b.length)) {
    if (!path || roots.some((root) => path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)))
      continue;
    roots.push(path);
  }
  return roots;
}

export function parseIndex(value: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const record of value.split('\0').filter(Boolean)) {
    const separator = record.indexOf('\t');
    if (separator <= 0) throw new Error('GIT_INDEX_FORMAT_INVALID');
    entries[record.slice(separator + 1)] = record.slice(0, separator);
  }
  return entries;
}

function worktreeFingerprint(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error('SNAPSHOT_NON_FILE_UNSUPPORTED');
  return `file:${stat.mode & 0o777}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function assertNoNestedRepository(root: string, path: string): void {
  const segments = path.split(/[\\/]+/);
  for (let index = 1; index < segments.length; index += 1) {
    const candidate = resolve(root, ...segments.slice(0, index), '.git');
    if (existsSync(candidate)) throw new Error('NESTED_REPOSITORY_UNSUPPORTED');
  }
}

export function git(cwd: string, arguments_: string[], input?: string, env?: Record<string, string>): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', arguments_, {
      cwd,
      stdio: 'pipe',
      windowsHide: true,
      shell: false,
      env: env ? { ...process.env, ...env } : process.env,
    });
    child.stdin.on('error', () => undefined);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (cause) => reject(new Error(`GIT_LAUNCH_FAILED:${cause.message}`)));
    child.once('exit', (exitCode) => {
      if (exitCode === 0) resolvePromise(stdout);
      else
        reject(
          new Error(`GIT_COMMAND_FAILED:${arguments_.join(' ')}:${exitCode ?? -1}:${stderr.trim().slice(0, 1000)}`),
        );
    });
    child.stdin.end(input);
  });
}

async function gitOptional(
  cwd: string,
  arguments_: string[],
  input?: string,
  env?: Record<string, string>,
): Promise<string> {
  try {
    return await git(cwd, arguments_, input, env);
  } catch (cause) {
    if (cause instanceof Error && /GIT_COMMAND_FAILED:.*:1:/.test(cause.message)) return '';
    throw cause;
  }
}
