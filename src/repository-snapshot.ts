import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

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

export async function createRepositorySnapshot(parentPath: string, snapshotPath: string): Promise<RepositorySnapshot> {
  const parent = realpathSync.native(parentPath);
  const topLevel = realpathSync.native((await git(parent, ['rev-parse', '--show-toplevel'])).trim());
  if (topLevel !== parent) throw new Error('REPOSITORY_PATH_NOT_TOP_LEVEL');
  const parentHead = (await git(parent, ['rev-parse', '--verify', 'HEAD'])).trim();
  if (!/^[0-9a-f]{40,64}$/i.test(parentHead)) throw new Error('REPOSITORY_HEAD_INVALID');
  if ((await git(parent, ['diff', '--name-only', '--diff-filter=U'])).trim())
    throw new Error('REPOSITORY_HAS_UNMERGED_PATHS');
  const dirty = (await git(parent, ['status', '--porcelain=v1', '--untracked-files=all'])).length > 0;
  const trackedPaths = nulPaths(await git(parent, ['ls-files', '-z']));
  const untrackedPaths = nulPaths(await git(parent, ['ls-files', '-z', '--others', '--exclude-standard']));
  const ignoredPaths = copyRoots(
    nulPaths(await git(parent, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])),
  );
  for (const path of [...trackedPaths, ...untrackedPaths]) assertNoNestedRepository(parent, path);
  for (const path of ignoredPaths) safeRepositoryPath(parent, path);
  const parentWorktree = Object.fromEntries(
    [...new Set([...trackedPaths, ...untrackedPaths])]
      .filter((path) => existsSync(safeRepositoryPath(parent, path)))
      .map((path) => [path, worktreeFingerprint(safeRepositoryPath(parent, path))]),
  );
  const parentIndex = parseIndex(await git(parent, ['ls-files', '--stage', '-z']));
  if (existsSync(snapshotPath)) throw new Error('SNAPSHOT_PATH_EXISTS');
  mkdirSync(dirname(snapshotPath), { recursive: true });
  await git(dirname(snapshotPath), ['clone', '--no-hardlinks', '--no-checkout', parent, snapshotPath]);
  const autoCrlf = await gitOptional(parent, ['config', '--get', 'core.autocrlf']);
  const coreEol = await gitOptional(parent, ['config', '--get', 'core.eol']);
  if (autoCrlf.trim()) await git(snapshotPath, ['config', 'core.autocrlf', autoCrlf.trim()]);
  if (coreEol.trim()) await git(snapshotPath, ['config', 'core.eol', coreEol.trim()]);
  await git(snapshotPath, ['checkout', '--detach', parentHead]);

  for (const path of trackedPaths) {
    const source = safeRepositoryPath(parent, path);
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
    const source = safeRepositoryPath(parent, path);
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
    parentPath: parent,
    snapshotPath: realpathSync.native(snapshotPath),
    parentHead,
    baselineCommit,
    baselineKind: dirty ? 'ephemeral_dirty_snapshot' : 'clean_head',
    ignoredPaths,
    parentWorktree,
    parentIndex,
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

export async function checkRepositoryPromotion(
  snapshot: RepositorySnapshot,
  changes: RepositoryChanges,
): Promise<void> {
  const currentHead = (await git(snapshot.parentPath, ['rev-parse', '--verify', 'HEAD'])).trim();
  if (currentHead !== snapshot.parentHead) throw new Error('PROMOTION_PARENT_HEAD_CHANGED');
  const currentIndex = parseIndex(await git(snapshot.parentPath, ['ls-files', '--stage', '-z']));
  for (const path of changes.changedPaths) {
    const parentFile = safeRepositoryPath(snapshot.parentPath, path);
    const currentFingerprint = existsSync(parentFile) ? worktreeFingerprint(parentFile) : undefined;
    if (currentFingerprint !== snapshot.parentWorktree[path]) throw new Error(`PROMOTION_PARENT_PATH_CHANGED:${path}`);
    if (currentIndex[path] !== snapshot.parentIndex[path]) throw new Error(`PROMOTION_PARENT_INDEX_CHANGED:${path}`);
  }
  if (!changes.patch) return;
  await git(snapshot.parentPath, ['apply', '--check', '--binary', '--whitespace=nowarn', '-'], changes.patch);
}

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

function safeRepositoryPath(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.split(/[\\/]+/).includes('..') || path.includes('\0'))
    throw new Error('REPOSITORY_RELATIVE_PATH_INVALID');
  const destination = resolve(root, path);
  const relativePath = relative(resolve(root), destination);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath))
    throw new Error('REPOSITORY_PATH_ESCAPE');
  return destination;
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

function parseIndex(value: string): Record<string, string> {
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

function git(cwd: string, arguments_: string[], input?: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', arguments_, { cwd, stdio: 'pipe', windowsHide: true, shell: false });
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

async function gitOptional(cwd: string, arguments_: string[]): Promise<string> {
  try {
    return await git(cwd, arguments_);
  } catch (cause) {
    if (cause instanceof Error && /GIT_COMMAND_FAILED:.*:1:/.test(cause.message)) return '';
    throw cause;
  }
}
