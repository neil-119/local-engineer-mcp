import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureRepositoryChanges,
  checkRepositoryPromotion,
  createRepositorySnapshot,
  promoteRepositoryChanges,
} from '../src/repository-snapshot.js';

describe('repository snapshots', () => {
  const temporaryRoots: string[] = [];
  afterEach(() => {
    for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
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
