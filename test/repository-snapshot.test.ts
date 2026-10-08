import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertCanonicalPathSafe,
  captureRepositoryChanges,
  checkRepositoryPromotion,
  createRepositorySnapshot,
  extractPatchPaths,
  promoteRepositoryChanges,
  safeRepositoryPath,
} from '../src/repository-snapshot.js';

describe('repository snapshots', () => {
  const temporaryRoots: string[] = [];
  afterEach(() => {
    for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it('requires an initial commit before it can create a worker snapshot', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'empty-repository-'));
    temporaryRoots.push(root);
    const parent = join(root, 'parent');
    mkdirSync(parent);
    git(parent, ['init']);

    await expect(createRepositorySnapshot(parent, join(root, 'snapshot'))).rejects.toThrow('REPOSITORY_HEAD_REQUIRED');
  });

  it('accepts a project directory inside a Git checkout and snapshots the checkout root', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'nested-repository-'));
    temporaryRoots.push(root);
    const parent = join(root, 'parent');
    const nested = join(parent, 'backend');
    mkdirSync(nested, { recursive: true });
    git(parent, ['init']);
    git(parent, ['config', 'user.name', 'Test']);
    git(parent, ['config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(nested, 'Cargo.toml'), '[package]\nname = "backend"\nversion = "0.1.0"\n');
    git(parent, ['add', '.']);
    git(parent, ['commit', '-m', 'initial']);

    const snapshot = await createRepositorySnapshot(nested, join(root, 'snapshot'));

    expect(snapshot.parentPath).toBe(realpathSync.native(parent));
    expect(readFileSync(join(snapshot.snapshotPath, 'backend', 'Cargo.toml'), 'utf8')).toContain('name = "backend"');
  });

  it('makes dirty parent state part of the private baseline', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'snapshot-'));
    temporaryRoots.push(root);
    const parent = join(root, 'parent');
    const snapshotPath = join(root, 'snapshot');
    mkdirSync(parent);
    git(parent, ['init']);
    git(parent, ['config', 'user.name', 'Test']);
    git(parent, ['config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(parent, 'tracked.txt'), 'committed\n');
    writeFileSync(join(parent, 'unrelated.txt'), 'unrelated baseline\n');
    git(parent, ['add', 'tracked.txt', 'unrelated.txt']);
    git(parent, ['commit', '-m', 'initial']);

    writeFileSync(join(parent, 'tracked.txt'), 'existing parent edit\n');
    writeFileSync(join(parent, 'untracked.txt'), 'existing untracked file\n');

    const snapshot = await createRepositorySnapshot(parent, snapshotPath);
    expect(snapshot.baselineKind).toBe('ephemeral_dirty_snapshot');
    expect(readFileSync(join(snapshotPath, 'tracked.txt'), 'utf8')).toBe('existing parent edit\n');
    expect(readFileSync(join(snapshotPath, 'untracked.txt'), 'utf8')).toBe('existing untracked file\n');

    writeFileSync(join(snapshotPath, 'tracked.txt'), 'existing parent edit\nworker edit\n');
    writeFileSync(join(snapshotPath, 'worker.txt'), 'worker file\n');
    const changes = await captureRepositoryChanges(snapshot);

    expect(changes.changedPaths).toEqual(['tracked.txt', 'worker.txt']);
    expect(changes.patch).not.toContain('untracked.txt');
    writeFileSync(join(parent, 'unrelated.txt'), 'unrelated parent edit\n');
    await promoteRepositoryChanges(snapshot, changes);
    expect(normalizeLines(readFileSync(join(parent, 'tracked.txt'), 'utf8'))).toBe(
      'existing parent edit\nworker edit\n',
    );
    expect(readFileSync(join(parent, 'untracked.txt'), 'utf8')).toBe('existing untracked file\n');
    expect(normalizeLines(readFileSync(join(parent, 'worker.txt'), 'utf8'))).toBe('worker file\n');
    expect(readFileSync(join(parent, 'unrelated.txt'), 'utf8')).toBe('unrelated parent edit\n');
  });

  it('rejects promotion after an overlapping parent edit', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'conflict-'));
    temporaryRoots.push(root);
    const parent = join(root, 'parent');
    const snapshotPath = join(root, 'snapshot');
    mkdirSync(parent);
    git(parent, ['init']);
    git(parent, ['config', 'user.name', 'Test']);
    git(parent, ['config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(parent, 'file.txt'), 'baseline\n');
    git(parent, ['add', 'file.txt']);
    git(parent, ['commit', '-m', 'initial']);
    const snapshot = await createRepositorySnapshot(parent, snapshotPath);
    writeFileSync(join(snapshotPath, 'file.txt'), 'worker\n');
    const changes = await captureRepositoryChanges(snapshot);

    writeFileSync(join(parent, 'file.txt'), 'parent\n');
    await expect(checkRepositoryPromotion(snapshot, changes)).rejects.toThrow('PROMOTION_PARENT_PATH_CHANGED');
    expect(readFileSync(join(parent, 'file.txt'), 'utf8')).toBe('parent\n');
  });

  it('rejects promotion after the affected parent index changes', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'index-conflict-'));
    temporaryRoots.push(root);
    const parent = join(root, 'parent');
    const snapshotPath = join(root, 'snapshot');
    mkdirSync(parent);
    git(parent, ['init']);
    git(parent, ['config', 'user.name', 'Test']);
    git(parent, ['config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(parent, 'file.txt'), 'baseline\n');
    git(parent, ['add', 'file.txt']);
    git(parent, ['commit', '-m', 'initial']);
    const snapshot = await createRepositorySnapshot(parent, snapshotPath);
    writeFileSync(join(snapshotPath, 'file.txt'), 'worker\n');
    const changes = await captureRepositoryChanges(snapshot);

    writeFileSync(join(parent, 'file.txt'), 'staged parent edit\n');
    git(parent, ['add', 'file.txt']);
    writeFileSync(join(parent, 'file.txt'), 'baseline\n');
    await expect(checkRepositoryPromotion(snapshot, changes)).rejects.toThrow('PROMOTION_PARENT_INDEX_CHANGED');
    expect(readFileSync(join(parent, 'file.txt'), 'utf8')).toBe('baseline\n');
  });

  it('extracts affected paths from unified diffs', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'extract-paths-'));
    temporaryRoots.push(root);
    git(root, ['init']);

    const patch = [
      'diff --git a/src/index.ts b/src/index.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/index.ts',
      '@@ -0,0 +1 @@',
      '+console.log("hello");',
      '',
    ].join('\n');

    const paths = await extractPatchPaths(root, patch);
    expect(paths).toEqual(['src/index.ts']);
  });

  it('rejects crafted patch targeting managed dependency path with empty changedPaths', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'crafted-managed-empty-'));
    temporaryRoots.push(root);
    const parent = join(root, 'parent');
    const snapshotPath = join(root, 'snapshot');
    mkdirSync(parent);
    git(parent, ['init']);
    git(parent, ['config', 'user.name', 'Test']);
    git(parent, ['config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(parent, 'file.txt'), 'baseline\n');
    git(parent, ['add', 'file.txt']);
    git(parent, ['commit', '-m', 'initial']);
    const snapshot = await createRepositorySnapshot(parent, snapshotPath);

    const craftedPatch = [
      'diff --git a/node_modules/malicious.js b/node_modules/malicious.js',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/node_modules/malicious.js',
      '@@ -0,0 +1 @@',
      '+console.log("pwned");',
      '',
    ].join('\n');

    const changes = {
      patch: craftedPatch,
      patchDigest: 'sha256:dummy',
      changedPaths: [],
      additions: 1,
      deletions: 0,
    };

    await expect(checkRepositoryPromotion(snapshot, changes)).rejects.toThrow(
      'PROMOTION_MANAGED_DEPENDENCY_PATH_NOT_PERMITTED:node_modules/malicious.js',
    );
  });

  it('rejects crafted patch with safe changedPaths omitting managed path', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'crafted-managed-omitted-'));
    temporaryRoots.push(root);
    const parent = join(root, 'parent');
    const snapshotPath = join(root, 'snapshot');
    mkdirSync(parent);
    git(parent, ['init']);
    git(parent, ['config', 'user.name', 'Test']);
    git(parent, ['config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(parent, 'safe.txt'), 'baseline\n');
    git(parent, ['add', 'safe.txt']);
    git(parent, ['commit', '-m', 'initial']);
    const snapshot = await createRepositorySnapshot(parent, snapshotPath);

    const craftedPatch = [
      'diff --git a/safe.txt b/safe.txt',
      '--- a/safe.txt',
      '+++ b/safe.txt',
      '@@ -1 +1 @@',
      '-baseline',
      '+updated',
      'diff --git a/node_modules/malicious.js b/node_modules/malicious.js',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/node_modules/malicious.js',
      '@@ -0,0 +1 @@',
      '+console.log("pwned");',
      '',
    ].join('\n');

    const changes = {
      patch: craftedPatch,
      patchDigest: 'sha256:dummy',
      changedPaths: ['safe.txt'],
      additions: 2,
      deletions: 1,
    };

    await expect(checkRepositoryPromotion(snapshot, changes)).rejects.toThrow(
      'PROMOTION_MANAGED_DEPENDENCY_PATH_NOT_PERMITTED:node_modules/malicious.js',
    );
  });

  it('rejects patch with mixed safe and managed hunks even if changedPaths declares both', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'mixed-declared-'));
    temporaryRoots.push(root);
    const parent = join(root, 'parent');
    const snapshotPath = join(root, 'snapshot');
    mkdirSync(parent);
    git(parent, ['init']);
    git(parent, ['config', 'user.name', 'Test']);
    git(parent, ['config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(parent, 'safe.txt'), 'baseline\n');
    git(parent, ['add', 'safe.txt']);
    git(parent, ['commit', '-m', 'initial']);
    const snapshot = await createRepositorySnapshot(parent, snapshotPath);

    const patch = [
      'diff --git a/safe.txt b/safe.txt',
      '--- a/safe.txt',
      '+++ b/safe.txt',
      '@@ -1 +1 @@',
      '-baseline',
      '+updated',
      'diff --git a/node_modules/malicious.js b/node_modules/malicious.js',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/node_modules/malicious.js',
      '@@ -0,0 +1 @@',
      '+console.log("pwned");',
      '',
    ].join('\n');

    const changes = {
      patch,
      patchDigest: 'sha256:dummy',
      changedPaths: ['safe.txt', 'node_modules/malicious.js'],
      additions: 2,
      deletions: 1,
    };

    await expect(checkRepositoryPromotion(snapshot, changes)).rejects.toThrow(
      'PROMOTION_MANAGED_DEPENDENCY_PATH_NOT_PERMITTED:node_modules/malicious.js',
    );
  });

  it('rejects promotion targeting managed dependency path in repos without ignore rules', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'no-ignore-rules-'));
    temporaryRoots.push(root);
    const parent = join(root, 'parent');
    const snapshotPath = join(root, 'snapshot');
    mkdirSync(parent);
    git(parent, ['init']);
    git(parent, ['config', 'user.name', 'Test']);
    git(parent, ['config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(parent, 'file.txt'), 'baseline\n');
    git(parent, ['add', 'file.txt']);
    git(parent, ['commit', '-m', 'initial']);
    const snapshot = await createRepositorySnapshot(parent, snapshotPath);

    const patch = [
      'diff --git a/.local-pkgs/pkg.tgz b/.local-pkgs/pkg.tgz',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/.local-pkgs/pkg.tgz',
      '@@ -0,0 +1 @@',
      '+data',
      '',
    ].join('\n');

    const changes = {
      patch,
      patchDigest: 'sha256:dummy',
      changedPaths: ['.local-pkgs/pkg.tgz'],
      additions: 1,
      deletions: 0,
    };

    await expect(checkRepositoryPromotion(snapshot, changes)).rejects.toThrow(
      'PROMOTION_MANAGED_DEPENDENCY_PATH_NOT_PERMITTED:.local-pkgs/pkg.tgz',
    );
  });

  it('rejects tracked dependency modifications or deletions failing closed', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'tracked-dependency-'));
    temporaryRoots.push(root);
    const parent = join(root, 'parent');
    const snapshotPath = join(root, 'snapshot');
    mkdirSync(parent);
    git(parent, ['init']);
    git(parent, ['config', 'user.name', 'Test']);
    git(parent, ['config', 'user.email', 'test@example.invalid']);
    mkdirSync(join(parent, 'node_modules', 'existing'), { recursive: true });
    writeFileSync(join(parent, 'node_modules', 'existing', 'index.js'), 'legacy\n');
    git(parent, ['add', '-f', '.']);
    git(parent, ['commit', '-m', 'initial with tracked dependency']);
    const snapshot = await createRepositorySnapshot(parent, snapshotPath);

    const deletePatch = [
      'diff --git a/node_modules/existing/index.js b/node_modules/existing/index.js',
      'deleted file mode 100644',
      '--- a/node_modules/existing/index.js',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-legacy',
      '',
    ].join('\n');

    const changes = {
      patch: deletePatch,
      patchDigest: 'sha256:dummy',
      changedPaths: ['node_modules/existing/index.js'],
      additions: 0,
      deletions: 1,
    };

    await expect(checkRepositoryPromotion(snapshot, changes)).rejects.toThrow(
      'PROMOTION_MANAGED_DEPENDENCY_PATH_NOT_PERMITTED:node_modules/existing/index.js',
    );
  });

  it('rejects patch metadata inconsistencies', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'metadata-mismatch-'));
    temporaryRoots.push(root);
    const parent = join(root, 'parent');
    const snapshotPath = join(root, 'snapshot');
    mkdirSync(parent);
    git(parent, ['init']);
    git(parent, ['config', 'user.name', 'Test']);
    git(parent, ['config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(parent, 'file1.txt'), 'baseline1\n');
    writeFileSync(join(parent, 'file2.txt'), 'baseline2\n');
    git(parent, ['add', '.']);
    git(parent, ['commit', '-m', 'initial']);
    const snapshot = await createRepositorySnapshot(parent, snapshotPath);

    const patch1 = [
      'diff --git a/file1.txt b/file1.txt',
      '--- a/file1.txt',
      '+++ b/file1.txt',
      '@@ -1 +1 @@',
      '-baseline1',
      '+updated1',
      '',
    ].join('\n');

    // Case 1: changedPaths is empty, patch is non-empty
    await expect(
      checkRepositoryPromotion(snapshot, {
        patch: patch1,
        patchDigest: 'sha256:dummy',
        changedPaths: [],
        additions: 1,
        deletions: 1,
      }),
    ).rejects.toThrow('PROMOTION_PATCH_INCONSISTENT_METADATA');

    // Case 2: changedPaths has wrong file
    await expect(
      checkRepositoryPromotion(snapshot, {
        patch: patch1,
        patchDigest: 'sha256:dummy',
        changedPaths: ['file2.txt'],
        additions: 1,
        deletions: 1,
      }),
    ).rejects.toThrow('PROMOTION_PATCH_INCONSISTENT_METADATA');

    // Case 3: changedPaths has duplicate entries
    await expect(
      checkRepositoryPromotion(snapshot, {
        patch: patch1,
        patchDigest: 'sha256:dummy',
        changedPaths: ['file1.txt', 'file1.txt'],
        additions: 1,
        deletions: 1,
      }),
    ).rejects.toThrow('PROMOTION_PATCH_INCONSISTENT_METADATA');

    // Case 4: patch is empty, changedPaths is non-empty
    await expect(
      checkRepositoryPromotion(snapshot, {
        patch: '',
        patchDigest: 'sha256:dummy',
        changedPaths: ['file1.txt'],
        additions: 0,
        deletions: 0,
      }),
    ).rejects.toThrow('PROMOTION_PATCH_INCONSISTENT_METADATA');
  });

  it('rejects encoded managed-source rename probe even when changedPaths contains only destination', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'encoded-rename-'));
    temporaryRoots.push(root);
    const parent = join(root, 'parent');
    const snapshotPath = join(root, 'snapshot');
    mkdirSync(parent);
    git(parent, ['init']);
    git(parent, ['config', 'user.name', 'Test']);
    git(parent, ['config', 'user.email', 'test@example.invalid']);
    mkdirSync(join(parent, 'node_modules'), { recursive: true });
    writeFileSync(join(parent, 'node_modules', '.modules.yaml'), 'legacy: true\n');
    git(parent, ['add', '-f', '.']);
    git(parent, ['commit', '-m', 'initial']);
    const snapshot = await createRepositorySnapshot(parent, snapshotPath);

    const patch = [
      'diff --git "a/\\156ode_modules/.modules.yaml" b/packages/review-only/renamed.txt',
      'similarity index 100%',
      'rename from "\\156ode_modules/.modules.yaml"',
      'rename to packages/review-only/renamed.txt',
      '',
    ].join('\n');

    const changes = {
      patch,
      patchDigest: 'sha256:dummy',
      changedPaths: ['packages/review-only/renamed.txt'],
      additions: 0,
      deletions: 0,
    };

    await expect(checkRepositoryPromotion(snapshot, changes)).rejects.toThrow(
      'PROMOTION_MANAGED_DEPENDENCY_PATH_NOT_PERMITTED:node_modules/.modules.yaml',
    );
  });

  it('rejects encoded nested .local-pkgs rename even when declared in changedPaths', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'encoded-local-pkgs-'));
    temporaryRoots.push(root);
    const parent = join(root, 'parent');
    const snapshotPath = join(root, 'snapshot');
    mkdirSync(parent);
    git(parent, ['init']);
    git(parent, ['config', 'user.name', 'Test']);
    git(parent, ['config', 'user.email', 'test@example.invalid']);
    mkdirSync(join(parent, 'foo', '.local-pkgs'), { recursive: true });
    writeFileSync(join(parent, 'foo', '.local-pkgs', 'pkg.tar'), 'data\n');
    git(parent, ['add', '-f', '.']);
    git(parent, ['commit', '-m', 'initial']);
    const snapshot = await createRepositorySnapshot(parent, snapshotPath);

    const patch = [
      'diff --git "a/foo/\\056local-pkgs/pkg.tar" b/bar/pkg.tar',
      'similarity index 100%',
      'rename from "foo/\\056local-pkgs/pkg.tar"',
      'rename to bar/pkg.tar',
      '',
    ].join('\n');

    const changes = {
      patch,
      patchDigest: 'sha256:dummy',
      changedPaths: ['bar/pkg.tar'],
      additions: 0,
      deletions: 0,
    };

    await expect(checkRepositoryPromotion(snapshot, changes)).rejects.toThrow(
      'PROMOTION_MANAGED_DEPENDENCY_PATH_NOT_PERMITTED:foo/.local-pkgs/pkg.tar',
    );
  });

  it('rejects mismatched source and destination diff headers as renames', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'mismatched-headers-'));
    temporaryRoots.push(root);
    const parent = join(root, 'parent');
    const snapshotPath = join(root, 'snapshot');
    mkdirSync(parent);
    git(parent, ['init']);
    git(parent, ['config', 'user.name', 'Test']);
    git(parent, ['config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(parent, 'foo.txt'), 'old\n');
    git(parent, ['add', 'foo.txt']);
    git(parent, ['commit', '-m', 'initial']);
    const snapshot = await createRepositorySnapshot(parent, snapshotPath);

    const patch = [
      'diff --git a/foo.txt b/bar.txt',
      '--- a/foo.txt',
      '+++ b/bar.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n');

    const changes = {
      patch,
      patchDigest: 'sha256:dummy',
      changedPaths: ['bar.txt'],
      additions: 1,
      deletions: 1,
    };

    await expect(checkRepositoryPromotion(snapshot, changes)).rejects.toThrow('PROMOTION_PATCH_RENAME_NOT_PERMITTED');
  });

  it('handles real Git patch with hunk content starting with ++ (ordinary.txt)', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'hunk-content-probe-'));
    temporaryRoots.push(root);
    const parent = join(root, 'parent');
    const snapshotPath = join(root, 'snapshot');
    mkdirSync(parent);
    git(parent, ['init']);
    git(parent, ['config', 'user.name', 'Test']);
    git(parent, ['config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(parent, 'init.txt'), 'init\n');
    git(parent, ['add', 'init.txt']);
    git(parent, ['commit', '-m', 'initial']);
    const snapshot = await createRepositorySnapshot(parent, snapshotPath);

    mkdirSync(join(snapshotPath, 'packages', 'review-only'), { recursive: true });
    writeFileSync(join(snapshotPath, 'packages', 'review-only', 'ordinary.txt'), '++ reference\n');
    const changes = await captureRepositoryChanges(snapshot);

    expect(changes.changedPaths).toEqual(['packages/review-only/ordinary.txt']);
    const pathsFromSnapshot = await extractPatchPaths(snapshot.snapshotPath, changes.patch, snapshot.baselineCommit);
    expect(pathsFromSnapshot).toEqual(['packages/review-only/ordinary.txt']);

    // Fallback un-baselined extraction should also not extract "reference"
    const fallbackPaths = await extractPatchPaths(snapshot.parentPath, changes.patch);
    expect(fallbackPaths).toEqual(['packages/review-only/ordinary.txt']);

    await expect(checkRepositoryPromotion(snapshot, changes)).resolves.toBeUndefined();
  });

  it('handles real Git patch with unquoted filename containing spaces', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'space-filename-probe-'));
    temporaryRoots.push(root);
    const parent = join(root, 'parent');
    const snapshotPath = join(root, 'snapshot');
    mkdirSync(parent);
    git(parent, ['init']);
    git(parent, ['config', 'user.name', 'Test']);
    git(parent, ['config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(parent, 'init.txt'), 'init\n');
    git(parent, ['add', 'init.txt']);
    git(parent, ['commit', '-m', 'initial']);
    const snapshot = await createRepositorySnapshot(parent, snapshotPath);

    mkdirSync(join(snapshotPath, 'packages', 'review-only'), { recursive: true });
    writeFileSync(join(snapshotPath, 'packages', 'review-only', 'with space.txt'), 'content in spaced file\n');
    const changes = await captureRepositoryChanges(snapshot);

    expect(changes.changedPaths).toEqual(['packages/review-only/with space.txt']);
    const pathsFromSnapshot = await extractPatchPaths(snapshot.snapshotPath, changes.patch, snapshot.baselineCommit);
    expect(pathsFromSnapshot).toEqual(['packages/review-only/with space.txt']);

    const fallbackPaths = await extractPatchPaths(snapshot.parentPath, changes.patch);
    expect(fallbackPaths).toEqual(['packages/review-only/with space.txt']);

    await expect(checkRepositoryPromotion(snapshot, changes)).resolves.toBeUndefined();
  });

  it('handles real Git patch with deleted content resembling ---', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'deleted-resembling-probe-'));
    temporaryRoots.push(root);
    const parent = join(root, 'parent');
    const snapshotPath = join(root, 'snapshot');
    mkdirSync(parent);
    git(parent, ['init']);
    git(parent, ['config', 'user.name', 'Test']);
    git(parent, ['config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(parent, 'file.txt'), '--- header line\nkeep line\n');
    git(parent, ['add', 'file.txt']);
    git(parent, ['commit', '-m', 'initial']);
    const snapshot = await createRepositorySnapshot(parent, snapshotPath);

    writeFileSync(join(snapshotPath, 'file.txt'), 'keep line\n');
    const changes = await captureRepositoryChanges(snapshot);

    expect(changes.changedPaths).toEqual(['file.txt']);
    const pathsFromSnapshot = await extractPatchPaths(snapshot.snapshotPath, changes.patch, snapshot.baselineCommit);
    expect(pathsFromSnapshot).toEqual(['file.txt']);

    const fallbackPaths = await extractPatchPaths(snapshot.parentPath, changes.patch);
    expect(fallbackPaths).toEqual(['file.txt']);

    await expect(checkRepositoryPromotion(snapshot, changes)).resolves.toBeUndefined();
  });

  it('uses temporary index on dirty host baseline and fails closed on corrupted patch', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'dirty-baseline-probe-'));
    temporaryRoots.push(root);
    const parent = join(root, 'parent');
    const snapshotPath = join(root, 'snapshot');
    mkdirSync(parent);
    git(parent, ['init']);
    git(parent, ['config', 'user.name', 'Test']);
    git(parent, ['config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(parent, 'clean.txt'), 'committed\n');
    git(parent, ['add', 'clean.txt']);
    git(parent, ['commit', '-m', 'initial']);

    // Host has uncommitted dirty changes
    writeFileSync(join(parent, 'dirty.txt'), 'dirty uncommitted\n');
    const snapshot = await createRepositorySnapshot(parent, snapshotPath);
    expect(snapshot.baselineKind).toBe('ephemeral_dirty_snapshot');

    // Worker creates a new file
    writeFileSync(join(snapshotPath, 'worker.txt'), 'worker data\n');
    const changes = await captureRepositoryChanges(snapshot);

    // Extraction succeeds from snapshot temporary index even though parent checkout never committed the baseline
    const paths = await extractPatchPaths(snapshot.snapshotPath, changes.patch, snapshot.baselineCommit);
    expect(paths).toEqual(['worker.txt']);
    await expect(checkRepositoryPromotion(snapshot, changes)).resolves.toBeUndefined();

    // Corrupted patch fails closed when baselineCommit is passed
    const corruptPatch = 'corrupted patch header\n+++ broken\n@@ invalid @@\n';
    await expect(extractPatchPaths(snapshot.snapshotPath, corruptPatch, snapshot.baselineCommit)).rejects.toThrow();
  });

  it('rejects patch additions with 8.3 aliases', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'patch-8dot3-add-'));
    temporaryRoots.push(root);
    const parent = join(root, 'parent');
    const snapshotPath = join(root, 'snapshot');
    mkdirSync(parent);
    git(parent, ['init']);
    git(parent, ['config', 'user.name', 'Test']);
    git(parent, ['config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(parent, 'init.txt'), 'init\n');
    git(parent, ['add', 'init.txt']);
    git(parent, ['commit', '-m', 'initial']);
    const snapshot = await createRepositorySnapshot(parent, snapshotPath);

    const patch = [
      'diff --git a/NODE_M~1/review-only-8dot3-proof.txt b/NODE_M~1/review-only-8dot3-proof.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/NODE_M~1/review-only-8dot3-proof.txt',
      '@@ -0,0 +1 @@',
      '+proof',
      '',
    ].join('\n');

    const changes = {
      patch,
      patchDigest: 'sha256:dummy',
      changedPaths: ['NODE_M~1/review-only-8dot3-proof.txt'],
      additions: 1,
      deletions: 0,
    };

    await expect(checkRepositoryPromotion(snapshot, changes)).rejects.toThrow(
      'PROMOTION_MANAGED_DEPENDENCY_PATH_NOT_PERMITTED:NODE_M~1/review-only-8dot3-proof.txt',
    );
  });

  it('rejects patch modifications with 8.3 aliases', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'patch-8dot3-mod-'));
    temporaryRoots.push(root);
    const parent = join(root, 'parent');
    const snapshotPath = join(root, 'snapshot');
    mkdirSync(parent);
    git(parent, ['init']);
    git(parent, ['config', 'user.name', 'Test']);
    git(parent, ['config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(parent, 'init.txt'), 'init\n');
    git(parent, ['add', 'init.txt']);
    git(parent, ['commit', '-m', 'initial']);
    const snapshot = await createRepositorySnapshot(parent, snapshotPath);

    const patch = [
      'diff --git a/NODE_M~1/package.json b/NODE_M~1/package.json',
      '--- a/NODE_M~1/package.json',
      '+++ b/NODE_M~1/package.json',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n');

    const changes = {
      patch,
      patchDigest: 'sha256:dummy',
      changedPaths: ['NODE_M~1/package.json'],
      additions: 1,
      deletions: 1,
    };

    await expect(checkRepositoryPromotion(snapshot, changes)).rejects.toThrow(
      'PROMOTION_MANAGED_DEPENDENCY_PATH_NOT_PERMITTED:NODE_M~1/package.json',
    );
  });

  it('rejects patch deletions with 8.3 aliases', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'patch-8dot3-del-'));
    temporaryRoots.push(root);
    const parent = join(root, 'parent');
    const snapshotPath = join(root, 'snapshot');
    mkdirSync(parent);
    git(parent, ['init']);
    git(parent, ['config', 'user.name', 'Test']);
    git(parent, ['config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(parent, 'init.txt'), 'init\n');
    git(parent, ['add', 'init.txt']);
    git(parent, ['commit', '-m', 'initial']);
    const snapshot = await createRepositorySnapshot(parent, snapshotPath);

    const patch = [
      'diff --git a/NODE_M~1/file.txt b/NODE_M~1/file.txt',
      'deleted file mode 100644',
      '--- a/NODE_M~1/file.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-content',
      '',
    ].join('\n');

    const changes = {
      patch,
      patchDigest: 'sha256:dummy',
      changedPaths: ['NODE_M~1/file.txt'],
      additions: 0,
      deletions: 1,
    };

    await expect(checkRepositoryPromotion(snapshot, changes)).rejects.toThrow(
      'PROMOTION_MANAGED_DEPENDENCY_PATH_NOT_PERMITTED:NODE_M~1/file.txt',
    );
  });

  it('rejects nested managed directories with 8.3 aliases', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'patch-8dot3-nested-'));
    temporaryRoots.push(root);
    const parent = join(root, 'parent');
    const snapshotPath = join(root, 'snapshot');
    mkdirSync(parent);
    git(parent, ['init']);
    git(parent, ['config', 'user.name', 'Test']);
    git(parent, ['config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(parent, 'init.txt'), 'init\n');
    git(parent, ['add', 'init.txt']);
    git(parent, ['commit', '-m', 'initial']);
    const snapshot = await createRepositorySnapshot(parent, snapshotPath);

    const patch = [
      'diff --git a/packages/app/PNPM_S~1/store b/packages/app/PNPM_S~1/store',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/packages/app/PNPM_S~1/store',
      '@@ -0,0 +1 @@',
      '+store',
      '',
    ].join('\n');

    const changes = {
      patch,
      patchDigest: 'sha256:dummy',
      changedPaths: ['packages/app/PNPM_S~1/store'],
      additions: 1,
      deletions: 0,
    };

    await expect(checkRepositoryPromotion(snapshot, changes)).rejects.toThrow(
      'PROMOTION_MANAGED_DEPENDENCY_PATH_NOT_PERMITTED:packages/app/PNPM_S~1/store',
    );
  });

  it('rejects promotion using real Windows NTFS 8.3 short-name alias when 8.3 is enabled', async () => {
    if (process.platform !== 'win32') return;

    const root = mkdtempSync(join(testTemporaryDirectory(), 'real-8dot3-'));
    temporaryRoots.push(root);
    const parent = join(root, 'parent');
    const snapshotPath = join(root, 'snapshot');
    mkdirSync(parent);
    git(parent, ['init']);
    git(parent, ['config', 'user.name', 'Test']);
    git(parent, ['config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(parent, 'init.txt'), 'init\n');
    git(parent, ['add', 'init.txt']);
    git(parent, ['commit', '-m', 'initial']);

    // Create a real host node_modules directory
    const nodeModules = join(parent, 'node_modules');
    mkdirSync(nodeModules, { recursive: true });

    // Probe for 8.3 short name on host
    let shortName: string | undefined;
    try {
      const output = execFileSync('cmd.exe', ['/c', `for %I in ("${nodeModules}") do @echo %~sI`], {
        encoding: 'utf8',
      }).trim();
      const parts = output.replace(/\\/g, '/').split('/');
      const last = parts[parts.length - 1];
      if (last && last.includes('~')) {
        shortName = last;
      }
    } catch {
      // 8.3 disabled or cmd failed
    }

    if (!shortName) {
      // Skip test if 8.3 short names are disabled on this volume
      return;
    }

    const snapshot = await createRepositorySnapshot(parent, snapshotPath);
    const targetFile = `${shortName}/proof.txt`;
    const patch = [
      `diff --git a/${targetFile} b/${targetFile}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${targetFile}`,
      '@@ -0,0 +1 @@',
      '+injected data',
      '',
    ].join('\n');

    const changes = {
      patch,
      patchDigest: 'sha256:dummy',
      changedPaths: [targetFile],
      additions: 1,
      deletions: 0,
    };

    await expect(checkRepositoryPromotion(snapshot, changes)).rejects.toThrow(
      /PROMOTION_MANAGED_DEPENDENCY_PATH_NOT_PERMITTED/,
    );
  });

  it('rejects paths with trailing dot or space on Windows', () => {
    if (process.platform !== 'win32') return;
    const root = mkdtempSync(join(testTemporaryDirectory(), 'trailing-check-'));
    temporaryRoots.push(root);

    expect(() => safeRepositoryPath(root, 'file.txt.')).toThrow('REPOSITORY_RELATIVE_PATH_INVALID');
    expect(() => safeRepositoryPath(root, 'file.txt ')).toThrow('REPOSITORY_RELATIVE_PATH_INVALID');
    expect(() => safeRepositoryPath(root, 'dir./file.txt')).toThrow('REPOSITORY_RELATIVE_PATH_INVALID');
    expect(() => safeRepositoryPath(root, 'dir /file.txt')).toThrow('REPOSITORY_RELATIVE_PATH_INVALID');
    expect(() => safeRepositoryPath(root, 'valid/path/file.txt')).not.toThrow();
  });

  it('rejects paths matching 8.3 short-name aliases in safeRepositoryPath on Windows', () => {
    if (process.platform !== 'win32') return;
    const root = mkdtempSync(join(testTemporaryDirectory(), 'shortname-check-'));
    temporaryRoots.push(root);

    expect(() => safeRepositoryPath(root, 'NODE_M~1/proof.txt')).toThrow('REPOSITORY_RELATIVE_PATH_INVALID');
    expect(() => safeRepositoryPath(root, 'FILE~1.TXT')).toThrow('REPOSITORY_RELATIVE_PATH_INVALID');
    expect(() => safeRepositoryPath(root, 'packages/pkg/NODE_M~1')).toThrow('REPOSITORY_RELATIVE_PATH_INVALID');
  });

  it('assertCanonicalPathSafe verifies host confinement and catches managed dependencies', () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'canonical-safe-'));
    temporaryRoots.push(root);
    const nodeModules = join(root, 'node_modules');
    mkdirSync(nodeModules, { recursive: true });

    expect(() => assertCanonicalPathSafe(root, 'node_modules/pkg/index.js')).toThrow(
      /PROMOTION_MANAGED_DEPENDENCY_PATH_NOT_PERMITTED:node_modules\/pkg\/index\.js/,
    );
    expect(() => assertCanonicalPathSafe(root, 'NODE_M~1/pkg/index.js')).toThrow(
      /PROMOTION_MANAGED_DEPENDENCY_PATH_NOT_PERMITTED:NODE_M~1\/pkg\/index\.js/,
    );
    expect(() => assertCanonicalPathSafe(root, 'src/index.ts')).not.toThrow();
  });
});

function git(cwd: string, arguments_: string[]): void {
  execFileSync('git', arguments_, { cwd, stdio: 'pipe' });
}

function testTemporaryDirectory(): string {
  const path = join(process.cwd(), '.tmp', 'tests');
  mkdirSync(path, { recursive: true });
  return path;
}

function normalizeLines(value: string): string {
  return value.replace(/\r\n/g, '\n');
}
