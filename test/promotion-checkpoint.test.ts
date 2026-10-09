import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkpointPromotion,
  loadPromotionLedger,
  preparePromotion,
  savePromotionLedger,
} from '../src/promotion-checkpoint.js';
import {
  captureRepositoryChanges,
  createRepositorySnapshot,
  promoteRepositoryChanges,
} from '../src/repository-snapshot.js';

describe('host-private promotion checkpoints', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  async function fixture() {
    const root = mkdtempSync(join(process.cwd(), '.tmp', 'checkpoint-test-'));
    roots.push(root);
    const parent = join(root, 'parent');
    mkdirSync(parent);
    const git = (args: string[]) => execFileSync('git', args, { cwd: parent, windowsHide: true });
    git(['init']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['config', 'core.autocrlf', 'false']);
    writeFileSync(join(parent, 'tracked.txt'), 'base\n');
    git(['add', '.']);
    git(['commit', '-m', 'initial']);
    writeFileSync(join(parent, 'SPEC.md'), 'dirty baseline\n');
    const snapshot = await createRepositorySnapshot(parent, join(root, 'snapshot'));
    const spec = join(snapshot.snapshotPath, 'SPEC.md');
    writeFileSync(spec, 'first review\n');
    const full = await captureRepositoryChanges(snapshot);
    const first = await preparePromotion(snapshot, full);
    await promoteRepositoryChanges(first.snapshot, first.changes);
    const checkpoint = await checkpointPromotion(first.snapshot, first.changes, first.tree);
    return { root, parent, snapshot, spec, full, checkpoint };
  }

  it('promotes a follow-up against an already promoted dirty/untracked baseline after ledger reload', async () => {
    const { root, parent, snapshot, spec, checkpoint } = await fixture();
    savePromotionLedger(root, {
      schema_version: 1,
      phase: 'complete',
      revision: 1,
      digest: `sha256:${'a'.repeat(64)}`,
      repositories: { app: checkpoint },
    });
    writeFileSync(spec, 'second review\n');
    const full = await captureRepositoryChanges(snapshot);
    const second = await preparePromotion(snapshot, full, loadPromotionLedger(root)!.repositories.app);
    expect(second.changes.patch).toContain('-first review');
    expect(second.changes.patch).not.toContain('-dirty baseline');
    await promoteRepositoryChanges(second.snapshot, second.changes);
    expect(readFileSync(join(parent, 'SPEC.md'), 'utf8').replace(/\r\n/g, '\n')).toBe('second review\n');
    expect(snapshot.parentWorktree['SPEC.md']).not.toBe(checkpoint.parentWorktree['SPEC.md']);
  });

  it('rejects overlapping external edits without advancing the checkpoint or applying changes', async () => {
    const { parent, snapshot, spec, checkpoint } = await fixture();
    const saved = JSON.stringify(checkpoint);
    writeFileSync(join(parent, 'SPEC.md'), 'external edit\n');
    writeFileSync(spec, 'second review\n');
    const next = await preparePromotion(snapshot, await captureRepositoryChanges(snapshot), checkpoint);
    await expect(promoteRepositoryChanges(next.snapshot, next.changes)).rejects.toThrow(
      'PROMOTION_PARENT_PATH_CHANGED:SPEC.md',
    );
    expect(readFileSync(join(parent, 'SPEC.md'), 'utf8')).toBe('external edit\n');
    expect(JSON.stringify(checkpoint)).toBe(saved);
  });

  it('handles reverting all previous edits even when the original full patch is empty', async () => {
    const { parent, snapshot, spec, checkpoint } = await fixture();
    writeFileSync(spec, 'dirty baseline\n');
    const full = await captureRepositoryChanges(snapshot);
    expect(full.changedPaths).toEqual([]);
    const reverted = await preparePromotion(snapshot, full, checkpoint);
    expect(reverted.changes.changedPaths).toEqual(['SPEC.md']);
    await promoteRepositoryChanges(reverted.snapshot, reverted.changes);
    expect(readFileSync(join(parent, 'SPEC.md'), 'utf8').replace(/\r\n/g, '\n')).toBe('dirty baseline\n');
  });

  it('handles deletes and recreations, preserving absence in the checkpoint', async () => {
    const { parent, snapshot, spec, checkpoint } = await fixture();
    rmSync(spec);
    const deleted = await preparePromotion(snapshot, await captureRepositoryChanges(snapshot), checkpoint);
    await promoteRepositoryChanges(deleted.snapshot, deleted.changes);
    const absent = await checkpointPromotion(deleted.snapshot, deleted.changes, deleted.tree);
    expect(absent.parentWorktree['SPEC.md']).toBeUndefined();
    expect(existsSync(join(parent, 'SPEC.md'))).toBe(false);
    writeFileSync(spec, 'recreated\n');
    const recreated = await preparePromotion(snapshot, await captureRepositoryChanges(snapshot), absent);
    await promoteRepositoryChanges(recreated.snapshot, recreated.changes);
    expect(readFileSync(join(parent, 'SPEC.md'), 'utf8').replace(/\r\n/g, '\n')).toBe('recreated\n');
  });

  it('does not bless extra edits outside the old patch hunks during recovery', async () => {
    const { parent, snapshot, full } = await fixture();
    writeFileSync(join(parent, 'SPEC.md'), 'first review\nexternal extra line\n');
    const first = await preparePromotion(snapshot, full);
    await expect(checkpointPromotion(first.snapshot, first.changes, first.tree)).rejects.toThrow(
      'PROMOTION_APPLIED_CONTENT_MISMATCH:SPEC.md',
    );
  });

  it('accepts Windows checkout CRLF conversion but records exact bytes for later conflict checks', async () => {
    if (process.platform !== 'win32') return;
    const { parent, snapshot, full } = await fixture();
    const first = await preparePromotion(snapshot, full);
    writeFileSync(join(parent, 'SPEC.md'), 'first review\r\n');
    const checkpoint = await checkpointPromotion(first.snapshot, first.changes, first.tree);
    writeFileSync(join(parent, 'SPEC.md'), 'first review\n');
    const next = await preparePromotion(snapshot, full, checkpoint);
    // An identical tree has no pending writes; an actual follow-up must check exact fingerprint bytes.
    expect(next.changes.changedPaths).toEqual([]);
    writeFileSync(join(snapshot.snapshotPath, 'SPEC.md'), 'next review\n');
    const changed = await preparePromotion(snapshot, await captureRepositoryChanges(snapshot), checkpoint);
    await expect(promoteRepositoryChanges(changed.snapshot, changed.changes)).rejects.toThrow(
      'PROMOTION_PARENT_PATH_CHANGED:SPEC.md',
    );
  });

  it('rejects external staging and changed HEAD during checkpoint recovery', async () => {
    const { parent, snapshot, full } = await fixture();
    const first = await preparePromotion(snapshot, full);
    execFileSync('git', ['add', 'SPEC.md'], { cwd: parent });
    await expect(checkpointPromotion(first.snapshot, first.changes, first.tree)).rejects.toThrow(
      'PROMOTION_PARENT_INDEX_CHANGED:SPEC.md',
    );
    execFileSync('git', ['commit', '-m', 'external'], { cwd: parent });
    await expect(checkpointPromotion(first.snapshot, first.changes, first.tree)).rejects.toThrow(
      'PROMOTION_PARENT_HEAD_CHANGED',
    );
  });

  it('validates persisted checkpoint shape and paths', async () => {
    const { root, checkpoint } = await fixture();
    const ledger = {
      schema_version: 1 as const,
      phase: 'complete' as const,
      revision: 1,
      digest: `sha256:${'a'.repeat(64)}`,
      repositories: { app: checkpoint },
    };
    checkpoint.parentWorktree['../escape'] = `file:438:${'b'.repeat(64)}`;
    savePromotionLedger(root, ledger);
    expect(() => loadPromotionLedger(root)).toThrow('REPOSITORY_RELATIVE_PATH_INVALID');
  });
});
