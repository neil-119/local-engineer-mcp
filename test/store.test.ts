import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE_TEXT, MAX_MESSAGES_PER_RUN, RunStore } from '../src/store.js';
import type { Run } from '../src/domain.js';

describe('steering settlement', () => {
  const fixture = (runId: string): Run => ({
    runId,
    agentId: 'agt_settlement',
    ownerId: 'owner_settlement',
    fenceToken: 1,
    title: 'Steering settlement',
    task: 'No-op',
    workingDirectory: 'C:/work/example',
    worker: 'codex-local',
    status: 'running',
    continuationIndex: 0,
    createdAt: new Date().toISOString(),
    requiresUserAction: false,
  });
  const closedStatuses: Run['status'][] = [
    'ready_for_review',
    'failed',
    'timed_out',
    'cancel_requested',
    'cancelled',
    'recovery_required',
  ];

  it.each(closedStatuses)('rejects enqueue after a concurrent transition to %s with an unchanged fence', (status) => {
    const dir = mkdtempSync(join(tmpdir(), 'local-engineer-steer-settled-'));
    const reader = new RunStore(dir);
    const writer = new RunStore(dir);
    try {
      reader.add(fixture('run_settled'));
      const stale = reader.get('run_settled')!;
      writer.setStatus(stale.runId, status);
      expect(() =>
        reader.enqueueSteer(
          stale.runId,
          { id: 'steer_late', message: 'Late guidance', status: 'pending', queuedAt: new Date().toISOString() },
          { ownerId: stale.ownerId, expectedFenceToken: stale.fenceToken },
        ),
      ).toThrow('STEER_RUN_NOT_ACTIVE');
      expect(writer.get(stale.runId)?.steeringQueue).toBeUndefined();
    } finally {
      reader.close();
      writer.close();
    }
  });

  it.each(closedStatuses)('closes pending and in-flight messages atomically when entering %s', (status) => {
    const dir = mkdtempSync(join(tmpdir(), 'local-engineer-steer-close-'));
    const store = new RunStore(dir);
    try {
      store.add(fixture('run_close'));
      for (const id of ['steer_inflight', 'steer_pending']) {
        store.enqueueSteer('run_close', {
          id,
          message: id,
          status: 'pending',
          queuedAt: new Date().toISOString(),
        });
      }
      store.claimNextSteer('run_close', 'owner_settlement');
      const before = store.get('run_close')!;
      const closed = store.setStatus('run_close', status);
      expect(closed.fenceToken).toBe(before.fenceToken);
      expect(closed.steeringVersion).toBe(before.steeringVersion! + 1);
      expect(closed.pendingSteer).toBeUndefined();
      expect(closed.steeringQueue?.map((message) => message.status)).toEqual(['uncertain', 'failed']);
      expect(closed.steeringMessages).toEqual(closed.steeringQueue);
      expect(closed.steeringMessages?.[1]?.error).toBe(`run_${status}_before_dispatch`);
      expect(store.claimNextSteer('run_close', 'owner_settlement')).toBeUndefined();
      expect(store.get('run_close')).toEqual(JSON.parse(JSON.stringify(closed)));
    } finally {
      store.close();
    }
  });

  it('closes queued guidance during expired-owner reconciliation without replaying or changing delivered history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-engineer-steer-reconcile-'));
    let instant = new Date('2026-07-24T00:00:00.000Z');
    const store = new RunStore(dir, undefined, { now: () => instant });
    try {
      store.add(fixture('run_reconcile'), 1000);
      for (const id of ['steer_delivered', 'steer_inflight', 'steer_pending']) {
        store.enqueueSteer('run_reconcile', { id, message: id, status: 'pending', queuedAt: instant.toISOString() });
      }
      store.claimNextSteer('run_reconcile', 'owner_settlement');
      store.dequeueSteer('run_reconcile', 'steer_delivered', 'delivered');
      store.claimNextSteer('run_reconcile', 'owner_settlement');
      instant = new Date('2026-07-24T00:00:02.000Z');
      store.reconcileStaleRuns({ ownerId: 'owner_adopter' });
      const recovered = store.get('run_reconcile')!;
      expect(recovered.status).toBe('recovery_required');
      expect(recovered.steeringMessages?.map((message) => message.status)).toEqual([
        'delivered',
        'uncertain',
        'failed',
      ]);
      expect(recovered.steeringMessages?.[1]?.error).toBe('server_reconciled_orphan_dispatch');
      expect(recovered.pendingSteer).toBeUndefined();
      expect(store.claimNextSteer('run_reconcile', 'owner_adopter')).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

describe('server log rotation', () => {
  it('rotates before the active log exceeds its configured limit', () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'local-engineer-log-'));
    const store = new RunStore(stateDirectory, 100);

    store.logServer('first', { detail: 'a'.repeat(50) });
    store.logServer('second', { detail: 'b'.repeat(50) });

    const activeLog = join(stateDirectory, 'logs', 'server.log');
    const archivedLog = `${activeLog}.1`;
    expect(existsSync(archivedLog)).toBe(true);
    expect(readFileSync(archivedLog, 'utf8')).toContain('"event":"first"');
    expect(readFileSync(activeLog, 'utf8')).toContain('"event":"second"');
  });
});

describe('shared-state concurrency claim', () => {
  it('starts only within the configured global and worker limits', () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'local-engineer-claim-'));
    const store = new RunStore(stateDirectory);
    const run = (runId: string): Run => ({
      runId,
      agentId: `agt_${runId}`,
      ownerId: 'owner',
      title: runId,
      task: 'No-op',
      workingDirectory: 'C:/work/example',
      worker: 'codex-local',
      status: 'queued',
      continuationIndex: 0,
      createdAt: `2026-07-22T00:00:0${runId.at(-1)}.000Z`,
      requiresUserAction: false,
    });
    store.add(run('run_1'));
    store.add(run('run_2'));

    expect(store.tryStart('run_1', 1, 1)?.status).toBe('starting');
    expect(store.tryStart('run_2', 1, 1)).toBeUndefined();
    store.setStatus('run_1', 'failed');
    expect(store.tryStart('run_2', 1, 1)?.status).toBe('starting');
  });
});

describe('server-side run pagination', () => {
  it('pages runs newest-first with deterministic cursor pagination', () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'local-engineer-runs-page-'));
    const store = new RunStore(stateDirectory);
    const run = (runId: string, createdAt: string): Run => ({
      runId,
      agentId: `agt_${runId}`,
      ownerId: 'owner',
      title: runId,
      task: 'No-op',
      workingDirectory: 'C:/work/example',
      worker: 'codex-local',
      status: 'queued',
      continuationIndex: 0,
      createdAt,
      requiresUserAction: false,
    });
    store.add(run('run_1', '2026-07-22T00:00:03.000Z'));
    store.add(run('run_2', '2026-07-22T00:00:02.000Z'));
    store.add(run('run_3', '2026-07-22T00:00:01.000Z'));

    const first = store.listRunsPage(2);
    expect(first.runs.map((r) => r.runId)).toEqual(['run_1', 'run_2']);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toEqual({ createdAt: '2026-07-22T00:00:02.000Z', runId: 'run_2' });

    const second = store.listRunsPage(2, first.nextCursor);
    expect(second.runs.map((r) => r.runId)).toEqual(['run_3']);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeUndefined();

    store.close();
  });

  it('tie-breaks runs that share a createdAt by run_id descending', () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'local-engineer-runs-tie-'));
    const store = new RunStore(stateDirectory);
    const run = (runId: string): Run => ({
      runId,
      agentId: `agt_${runId}`,
      ownerId: 'owner',
      title: runId,
      task: 'No-op',
      workingDirectory: 'C:/work/example',
      worker: 'codex-local',
      status: 'queued',
      continuationIndex: 0,
      createdAt: '2026-07-22T00:00:00.000Z',
      requiresUserAction: false,
    });
    store.add(run('run_a'));
    store.add(run('run_b'));
    store.add(run('run_c'));

    const first = store.listRunsPage(2);
    expect(first.runs.map((r) => r.runId)).toEqual(['run_c', 'run_b']);
    const second = store.listRunsPage(2, first.nextCursor);
    expect(second.runs.map((r) => r.runId)).toEqual(['run_a']);

    store.close();
  });
});

describe('assistant message capture and pagination', () => {
  it('deduplicates by item id and bounds stored text', () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'local-engineer-msg-dup-'));
    const store = new RunStore(stateDirectory);

    store.captureMessage('run_1', 'item_a', '2026-07-22T00:00:01.000Z', 'first message');
    store.captureMessage('run_1', 'item_a', '2026-07-22T00:00:02.000Z', 'changed text');

    const page = store.listMessagesPage('run_1', 10);
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]!.seq).toBe(1);
    expect(page.messages[0]!.text).toBe('first message');

    const long = 'x'.repeat(MAX_MESSAGE_TEXT + 50);
    store.captureMessage('run_1', 'item_b', '2026-07-22T00:00:03.000Z', long);
    const page2 = store.listMessagesPage('run_1', 10);
    const bounded = page2.messages.find((m) => m.truncated === true)!;
    expect(bounded.text).toHaveLength(MAX_MESSAGE_TEXT);
    expect(bounded.truncated).toBe(true);

    store.close();
  });

  it('caps the number of stored messages per run, keeping the newest', () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'local-engineer-msg-cap-'));
    const store = new RunStore(stateDirectory);
    const total = MAX_MESSAGES_PER_RUN + 2;
    for (let i = 0; i < total; i += 1) {
      store.captureMessage(
        'run_1',
        `item_${i}`,
        `2026-07-22T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
        `msg ${i}`,
      );
    }
    const page = store.listMessagesPage('run_1', MAX_MESSAGES_PER_RUN + 10);
    expect(page.messages).toHaveLength(MAX_MESSAGES_PER_RUN);
    const texts = page.messages.map((m) => m.text);
    // newest messages are retained and pageable
    expect(texts[0]).toBe(`msg ${total - 1}`);
    expect(texts).toContain(`msg ${MAX_MESSAGES_PER_RUN}`);
    expect(texts[texts.length - 1]).toBe(`msg ${total - MAX_MESSAGES_PER_RUN}`);
    // oldest overflow messages are pruned
    expect(texts).not.toContain('msg 0');
    expect(texts).not.toContain('msg 1');
    store.close();
  });

  it('returns messages newest-first with opaque cursor pagination', () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'local-engineer-msg-page-'));
    const store = new RunStore(stateDirectory);
    store.captureMessage('run_1', 'item_1', '2026-07-22T00:00:01.000Z', 'message 1');
    store.captureMessage('run_1', 'item_2', '2026-07-22T00:00:02.000Z', 'message 2');
    store.captureMessage('run_1', 'item_3', '2026-07-22T00:00:03.000Z', 'message 3');

    const first = store.listMessagesPage('run_1', 2);
    expect(first.messages.map((m) => m.seq)).toEqual([3, 2]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toEqual({ seq: 2 });

    const second = store.listMessagesPage('run_1', 2, first.nextCursor);
    expect(second.messages.map((m) => m.seq)).toEqual([1]);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeUndefined();

    store.close();
  });
});

describe('stale-run reconciliation', () => {
  it('holds expired worker runs in recovery until cleanup while terminalizing queued runs', () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'local-engineer-reconcile-'));
    const store = new RunStore(stateDirectory);
    const createRun = (runId: string, status: Run['status']): Run => ({
      runId,
      agentId: `agt_${runId}`,
      ownerId: 'owner',
      title: runId,
      task: 'Reconciliation test',
      workingDirectory: 'C:/work/example',
      worker: 'codex-local',
      status,
      continuationIndex: 0,
      createdAt: '2026-07-22T00:00:00.000Z',
      leaseExpiresAt: '2020-01-01T00:00:00.000Z',
      requiresUserAction: false,
    });

    store.add(createRun('run_starting', 'starting'));
    store.add(createRun('run_running', 'running'));
    store.add(createRun('run_cancelling', 'cancel_requested'));
    store.add(createRun('run_queued', 'queued'));
    store.add(createRun('run_reviewed', 'ready_for_review'));

    const result = store.reconcileStaleRuns();
    expect(result.reconciledCount).toBe(4);
    expect(result.reconciledRunIds).toEqual(
      expect.arrayContaining(['run_starting', 'run_running', 'run_cancelling', 'run_queued']),
    );

    const starting = store.get('run_starting')!;
    expect(starting.status).toBe('recovery_required');
    expect(starting.errorCode).toBe('SERVER_PROCESS_RESTARTED');
    expect(starting.requiresUserAction).toBe(false);
    expect(starting.recovery).toEqual({ kind: 'container_cleanup', targetStatus: 'failed' });
    expect(starting.diagnostics?.commands_active_count).toBe(0);
    expect(starting.completedAt).toBeUndefined();
    expect(starting.diagnostics?.exit_reason).toContain('Local Engineer server restarted');

    const running = store.get('run_running')!;
    expect(running.status).toBe('recovery_required');
    expect(running.errorCode).toBe('SERVER_PROCESS_RESTARTED');
    expect(running.requiresUserAction).toBe(false);
    expect(running.diagnostics?.commands_active_count).toBe(0);
    expect(running.completedAt).toBeUndefined();

    const cancelling = store.get('run_cancelling')!;
    expect(cancelling.status).toBe('recovery_required');
    expect(cancelling.requiresUserAction).toBe(false);
    expect(cancelling.recovery).toEqual({ kind: 'container_cleanup', targetStatus: 'cancelled' });
    expect(cancelling.diagnostics?.commands_active_count).toBe(0);
    expect(cancelling.completedAt).toBeUndefined();
    expect(cancelling.diagnostics?.exit_reason).toContain('during cancellation');

    const queued = store.get('run_queued')!;
    expect(queued.status).toBe('cancelled');
    expect(queued.errorCode).toBe('SERVER_PROCESS_RESTARTED');
    expect(queued.requiresUserAction).toBe(false);
    expect(queued.diagnostics?.commands_active_count).toBe(0);
    expect(queued.completedAt).toBeTruthy();
    expect(queued.diagnostics?.exit_reason).toContain('while this run was queued');

    const reviewed = store.get('run_reviewed')!;
    expect(reviewed.status).toBe('ready_for_review');

    // Idempotency: subsequent call reconciles nothing
    const secondCall = store.reconcileStaleRuns();
    expect(secondCall.reconciledCount).toBe(0);
    expect(secondCall.reconciledRunIds).toEqual([]);

    store.close();
  });

  it('preserves legacy runs without lease metadata and runs with active leases', () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'local-engineer-legacy-'));
    const store = new RunStore(stateDirectory);

    const legacyRun: Run = {
      runId: 'run_legacy_running',
      agentId: 'agt_legacy',
      ownerId: 'owner_old',
      title: 'Legacy running run',
      task: 'Legacy test',
      workingDirectory: 'C:/work/example',
      worker: 'codex-local',
      status: 'running',
      continuationIndex: 0,
      createdAt: '2026-07-22T00:00:00.000Z',
      requiresUserAction: false,
    };
    store.add(legacyRun);

    // Strip lease metadata to simulate a legacy pre-lease DB record
    const rawLegacy = { ...legacyRun };
    delete rawLegacy.leaseExpiresAt;
    delete rawLegacy.leaseHeartbeatAt;
    delete rawLegacy.fenceToken;
    (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
      .prepare('UPDATE runs SET json = ? WHERE run_id = ?')
      .run(JSON.stringify(rawLegacy), 'run_legacy_running');

    // Also add an active run whose lease is fresh
    store.add({
      runId: 'run_active',
      agentId: 'agt_active',
      ownerId: 'owner_live',
      title: 'Active run',
      task: 'Active test',
      workingDirectory: 'C:/work/example',
      worker: 'codex-local',
      status: 'running',
      continuationIndex: 0,
      createdAt: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      requiresUserAction: false,
    });

    const result = store.reconcileStaleRuns();
    expect(result.reconciledCount).toBe(0);
    expect(result.reconciledRunIds).toEqual([]);

    expect(store.get('run_legacy_running')?.status).toBe('running');
    expect(store.get('run_active')?.status).toBe('running');

    store.close();
  });
});

describe('exact revision diff isolation and bounded history ingestion', () => {
  it('never falls back to another revision when requested revision patch is missing', () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'local-engineer-diff-iso-'));
    const store = new RunStore(stateDirectory);
    const runId = 'run_iso_1';
    const agentId = 'agt_iso_1';

    const patchDir2 = join(stateDirectory, 'container-agents', agentId, 'patches', 'revision-2');
    mkdirSync(patchDir2, { recursive: true });
    writeFileSync(
      join(patchDir2, 'myrepo.full.patch'),
      'diff --git a/wrong.txt b/wrong.txt\nnew file mode 100644\n--- /dev/null\n+++ b/wrong.txt\n@@ -0,0 +1 @@\n+wrong\n',
    );

    store.add({
      runId,
      agentId,
      ownerId: 'owner',
      title: 'Diff Iso Test',
      task: 'Task',
      workingDirectory: 'C:/work/example',
      worker: 'codex-local',
      status: 'ready_for_review',
      continuationIndex: 0,
      createdAt: '2026-07-22T00:00:00.000Z',
      requiresUserAction: false,
      changeSet: {
        revision: 1,
        previous_revision: 0,
        digest: 'sha256:rev1',
        repositories: [
          {
            repository: 'myrepo',
            changed_paths: ['file1.txt'],
            additions: 1,
            deletions: 0,
            patch_digest: 'sha256:p1',
            delta_changed_paths: ['file1.txt'],
            delta_additions: 1,
            delta_deletions: 0,
            delta_patch_digest: 'sha256:d1',
          },
        ],
      },
    });

    const diffs = store.readDiffs(runId);
    expect(diffs).toBeDefined();
    expect(diffs?.revision).toBe(1);
    expect(diffs?.files).toHaveLength(1);
    expect(diffs?.files[0]?.path).toBe('file1.txt');
    expect(diffs?.files[0]?.diff).toContain('No diff captured for revision 1');
    expect(diffs?.raw_patch).toBe('');
    expect(JSON.stringify(diffs)).not.toContain('wrong.txt');

    store.close();
  });

  it('preserves repository identity for overlapping filenames across repositories', () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'local-engineer-diff-overlap-'));
    const store = new RunStore(stateDirectory);
    const runId = 'run_overlap_1';
    const agentId = 'agt_overlap_1';

    const patchDir = join(stateDirectory, 'container-agents', agentId, 'patches', 'revision-1');
    mkdirSync(patchDir, { recursive: true });
    writeFileSync(
      join(patchDir, 'repoA.full.patch'),
      'diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-a\n+A\n',
    );
    writeFileSync(
      join(patchDir, 'repoB.full.patch'),
      'diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-b\n+B\n',
    );

    store.add({
      runId,
      agentId,
      ownerId: 'owner',
      title: 'Overlap Test',
      task: 'Task',
      workingDirectory: 'C:/work/example',
      worker: 'codex-local',
      status: 'ready_for_review',
      continuationIndex: 0,
      createdAt: '2026-07-22T00:00:00.000Z',
      requiresUserAction: false,
      changeSet: {
        revision: 1,
        previous_revision: 0,
        digest: 'sha256:rev1',
        repositories: [
          {
            repository: 'repoA',
            changed_paths: ['src/index.ts'],
            additions: 1,
            deletions: 1,
            patch_digest: 'sha256:pA',
            delta_changed_paths: ['src/index.ts'],
            delta_additions: 1,
            delta_deletions: 1,
            delta_patch_digest: 'sha256:dA',
          },
          {
            repository: 'repoB',
            changed_paths: ['src/index.ts'],
            additions: 1,
            deletions: 1,
            patch_digest: 'sha256:pB',
            delta_changed_paths: ['src/index.ts'],
            delta_additions: 1,
            delta_deletions: 1,
            delta_patch_digest: 'sha256:dB',
          },
        ],
      },
    });

    const diffs = store.readDiffs(runId);
    expect(diffs).toBeDefined();
    expect(diffs?.files).toHaveLength(2);
    expect(diffs?.files[0]?.path).toBe('src/index.ts');
    expect(diffs?.files[0]?.repository).toBe('repoA');
    expect(diffs?.files[1]?.path).toBe('src/index.ts');
    expect(diffs?.files[1]?.repository).toBe('repoB');

    store.close();
  });

  it('validates timeline offsets and limits as safe integers', () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'local-engineer-tl-bounds-'));
    const store = new RunStore(stateDirectory);
    const runId = 'run_bounds_1';
    store.add({
      runId,
      agentId: 'agt_b',
      ownerId: 'owner',
      title: 'Bounds Test',
      task: 'Task',
      workingDirectory: 'C:/work/example',
      worker: 'codex-local',
      status: 'running',
      continuationIndex: 0,
      createdAt: '2026-07-22T00:00:00.000Z',
      requiresUserAction: false,
    });

    expect(() => store.readTimeline(runId, 10, -1)).toThrow('INVALID_TIMELINE_OFFSET');
    expect(() => store.readTimeline(runId, 10, NaN)).toThrow('INVALID_TIMELINE_OFFSET');
    expect(() => store.readTimeline(runId, 0, 0)).toThrow('INVALID_TIMELINE_LIMIT');
    expect(() => store.readTimeline(runId, -5, 0)).toThrow('INVALID_TIMELINE_LIMIT');

    store.close();
  });

  it('handles oversized lines (>64KB) in timeline streams gracefully without OOM', async () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'local-engineer-oversized-'));
    const store = new RunStore(stateDirectory);
    const runId = 'run_oversized_1';
    store.add({
      runId,
      agentId: 'agt_o',
      ownerId: 'owner',
      title: 'Oversized Test',
      task: 'Task',
      workingDirectory: 'C:/work/example',
      worker: 'codex-local',
      status: 'running',
      continuationIndex: 0,
      createdAt: '2026-07-22T00:00:00.000Z',
      requiresUserAction: false,
    });

    const harnessDir = join(stateDirectory, 'runs', runId, 'harness');
    mkdirSync(harnessDir, { recursive: true });

    // One normal line, one 70KB oversized line, one normal line
    const normal1 = JSON.stringify({
      method: 'item/started',
      params: {
        startedAtMs: 1790120000000,
        item: { id: 'cmd_1', type: 'commandExecution', command: 'echo 1', cwd: 'C:/test' },
      },
    });
    const oversizedLine = 'X'.repeat(70 * 1024);
    const normal2 = JSON.stringify({
      method: 'item/completed',
      params: {
        completedAtMs: 1790120001000,
        item: { id: 'cmd_1', type: 'commandExecution', command: 'echo 1', cwd: 'C:/test', exitCode: 0 },
      },
    });

    writeFileSync(join(harnessDir, 'raw-events.jsonl'), [normal1, oversizedLine, normal2].join('\n') + '\n');

    const analysis = await store.analyzeTimeline(runId);
    expect(analysis.historyTruncated).toBe(true);
    expect(analysis.commandsCount).toBe(1);

    const timeline = store.readTimeline(runId, 50, 0);
    expect(timeline.items).toHaveLength(1);
    expect(timeline.items[0]?.id).toBe('cmd_1');

    store.close();
  });

  it('discards oversized line with valid JSON suffix without parsing forged command', async () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'local-engineer-oversized-suffix-'));
    const store = new RunStore(stateDirectory);
    const runId = 'run_oversized_suffix_1';
    store.add({
      runId,
      agentId: 'agt_os',
      ownerId: 'owner',
      title: 'Oversized Suffix Test',
      task: 'Task',
      workingDirectory: 'C:/work/example',
      worker: 'codex-local',
      status: 'running',
      continuationIndex: 0,
      createdAt: '2026-07-22T00:00:00.000Z',
      requiresUserAction: false,
    });

    const harnessDir = join(stateDirectory, 'runs', runId, 'harness');
    mkdirSync(harnessDir, { recursive: true });

    const forgedEvent = JSON.stringify({
      method: 'item/completed',
      params: {
        completedAtMs: 1790120001000,
        item: { id: 'forged_cmd', type: 'commandExecution', command: 'rm -rf /', cwd: 'C:/test', exitCode: 0 },
      },
    });
    // Prefix exceeds 64KB, suffix is valid JSON, followed by newline
    const payload = 'A'.repeat(70 * 1024) + forgedEvent + '\n';
    writeFileSync(join(harnessDir, 'raw-events.jsonl'), payload);

    const analysis = await store.analyzeTimeline(runId);
    expect(analysis.historyTruncated).toBe(true);
    expect(analysis.commandsCount).toBe(0);

    const timeline = store.readTimeline(runId, 50, 0);
    expect(timeline.items).toHaveLength(0);

    store.close();
  });

  it('discards incomplete trailing record without trailing newline at EOF', async () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'local-engineer-incomplete-trailing-'));
    const store = new RunStore(stateDirectory);
    const runId = 'run_incomplete_1';
    store.add({
      runId,
      agentId: 'agt_inc',
      ownerId: 'owner',
      title: 'Incomplete Trailing Test',
      task: 'Task',
      workingDirectory: 'C:/work/example',
      worker: 'codex-local',
      status: 'running',
      continuationIndex: 0,
      createdAt: '2026-07-22T00:00:00.000Z',
      requiresUserAction: false,
    });

    const harnessDir = join(stateDirectory, 'runs', runId, 'harness');
    mkdirSync(harnessDir, { recursive: true });

    const validEvent = JSON.stringify({
      method: 'item/completed',
      params: {
        completedAtMs: 1790120000000,
        item: { id: 'valid_cmd', type: 'commandExecution', command: 'echo hello', cwd: 'C:/test', exitCode: 0 },
      },
    });
    // Partial JSON record at EOF without newline
    const incompleteEvent = '{"method":"item/completed","params":{"item":{"id":"incomplete_cmd"';

    writeFileSync(join(harnessDir, 'raw-events.jsonl'), `${validEvent}\n${incompleteEvent}`);

    const analysis = await store.analyzeTimeline(runId);
    expect(analysis.historyTruncated).toBe(true);
    expect(analysis.commandsCount).toBe(1);

    const timeline = store.readTimeline(runId, 50, 0);
    expect(timeline.items).toHaveLength(1);
    expect(timeline.items[0]?.id).toBe('valid_cmd');

    store.close();
  });

  it('preserves multibyte UTF-8 characters split across 64 KiB chunk boundary', () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'local-engineer-utf8-split-'));
    const store = new RunStore(stateDirectory);
    const runId = 'run_utf8_split_1';
    store.add({
      runId,
      agentId: 'agt_utf8',
      ownerId: 'owner',
      title: 'UTF8 Split Test',
      task: 'Task',
      workingDirectory: 'C:/work/example',
      worker: 'codex-local',
      status: 'running',
      continuationIndex: 0,
      createdAt: '2026-07-22T00:00:00.000Z',
      requiresUserAction: false,
    });

    const harnessDir = join(stateDirectory, 'runs', runId, 'harness');
    mkdirSync(harnessDir, { recursive: true });

    // Chunk size is 64 * 1024 = 65,536 bytes.
    // Line 1 is a valid ~60KB event under MAX_LINE_LENGTH (64KB).
    const line1 =
      JSON.stringify({
        method: 'item/started',
        params: {
          startedAtMs: 100,
          item: { id: 'cmd_pad', type: 'commandExecution', command: 'A'.repeat(60000), cwd: 'C:/' },
        },
      }) + '\n';
    const line1Buf = Buffer.from(line1, 'utf8');

    // Line 2 starts at byte line1Buf.length (~60,150) and crosses the 65,536 boundary.
    const prefix2Str =
      '{"method":"item/started","params":{"startedAtMs":200,"item":{"id":"cmd_u","type":"commandExecution","command":"';
    const prefix2Buf = Buffer.from(prefix2Str, 'utf8');
    const currentLen = line1Buf.length + prefix2Buf.length;
    const targetSplit = 65535; // byte 65535 is last byte of chunk 0
    const padLen = targetSplit - currentLen;
    const padBuf = Buffer.alloc(padLen, 0x20); // space
    const charBuf = Buffer.from('€', 'utf8'); // 3 bytes: 0xE2 0x82 0xAC
    const suffixBuf = Buffer.from('","cwd":"C:/"}}}\n', 'utf8');
    const totalBuf = Buffer.concat([line1Buf, prefix2Buf, padBuf, charBuf, suffixBuf]);

    writeFileSync(join(harnessDir, 'raw-events.jsonl'), totalBuf);

    const timeline = store.readTimeline(runId, 50, 0);
    expect(timeline.items.length).toBeGreaterThanOrEqual(1);
    const item = timeline.items.find((it) => it.id === 'cmd_u');
    expect(item).toBeDefined();
    expect(item?.command).toContain('€');

    store.close();
  });

  it('enforces timelineCache LRU eviction, byte budget, and skips single oversized entries', () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'local-engineer-cache-budget-'));
    const store = new RunStore(stateDirectory);

    interface CacheStoreAccessor {
      timelineCache: Map<string, { approxBytes: number }>;
      timelineCacheBytes: number;
      setCachedTimeline(
        runId: string,
        entry: {
          mtimeMs: number;
          size: number;
          items: Map<string, { id: string; type: string; status: string; text?: string }>;
          order: string[];
          historyTruncated: boolean;
        },
      ): void;
    }
    const accessor = store as unknown as CacheStoreAccessor;

    // 1. Single oversized entry (> 20 MiB) must be skipped from caching
    const hugeItems = new Map<string, { id: string; type: string; status: string; text?: string }>();
    const hugeOrder: string[] = [];
    const hugeText = 'x'.repeat(11 * 1024 * 1024); // 11M chars = 22 MiB UTF-16
    hugeItems.set('huge_1', { id: 'huge_1', type: 'message', status: 'completed', text: hugeText });
    hugeOrder.push('huge_1');

    accessor.setCachedTimeline('run_huge', {
      mtimeMs: 1,
      size: 100,
      items: hugeItems,
      order: hugeOrder,
      historyTruncated: false,
    });

    expect(accessor.timelineCache.has('run_huge')).toBe(false);
    expect(accessor.timelineCacheBytes).toBe(0);

    // 2. Count eviction: MAX_TIMELINE_CACHE_ENTRIES = 10
    for (let i = 1; i <= 12; i++) {
      const items = new Map<string, { id: string; type: string; status: string; text?: string }>();
      items.set(`item_${i}`, { id: `item_${i}`, type: 'message', status: 'completed', text: `text_${i}` });
      accessor.setCachedTimeline(`run_${i}`, {
        mtimeMs: 1,
        size: 100,
        items,
        order: [`item_${i}`],
        historyTruncated: false,
      });
    }

    expect(accessor.timelineCache.size).toBe(10);
    expect(accessor.timelineCache.has('run_1')).toBe(false);
    expect(accessor.timelineCache.has('run_2')).toBe(false);
    expect(accessor.timelineCache.has('run_12')).toBe(true);

    // 3. Aggregate byte eviction: entries that exceed 20 MiB aggregate
    store.clearTimelineCache();
    expect(accessor.timelineCache.size).toBe(0);
    expect(accessor.timelineCacheBytes).toBe(0);

    const midText = 'm'.repeat(4 * 1024 * 1024); // ~8.4 MiB UTF-16
    for (let i = 1; i <= 3; i++) {
      const items = new Map<string, { id: string; type: string; status: string; text?: string }>();
      items.set(`mid_${i}`, { id: `mid_${i}`, type: 'message', status: 'completed', text: midText });
      accessor.setCachedTimeline(`run_mid_${i}`, {
        mtimeMs: 1,
        size: 100,
        items,
        order: [`mid_${i}`],
        historyTruncated: false,
      });
    }

    expect(accessor.timelineCache.has('run_mid_1')).toBe(false);
    expect(accessor.timelineCache.has('run_mid_2')).toBe(true);
    expect(accessor.timelineCache.has('run_mid_3')).toBe(true);
    expect(accessor.timelineCacheBytes).toBeLessThanOrEqual(RunStore.MAX_TIMELINE_CACHE_BYTES);

    store.close();
  });

  it('preserves per-repo summaries across all repositories when diff exceeds aggregate budget', () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'local-engineer-diff-budget-'));
    const store = new RunStore(stateDirectory);
    const runId = 'run_diff_budget_1';
    const agentId = 'agt_diff_budget_1';

    store.add({
      runId,
      agentId,
      ownerId: 'owner',
      title: 'Diff Budget Test',
      task: 'Task',
      workingDirectory: 'C:/work/example',
      worker: 'codex-local',
      status: 'ready_for_review',
      continuationIndex: 0,
      createdAt: '2026-07-22T00:00:00.000Z',
      requiresUserAction: false,
      changeSet: {
        revision: 1,
        previous_revision: 0,
        digest: 'sha256:' + 'a'.repeat(64),
        repositories: [
          { repository: 'repo-alpha', changed_paths: ['file1.ts'], additions: 10, deletions: 2 },
          { repository: 'repo-beta', changed_paths: ['file2.ts'], additions: 20, deletions: 5 },
        ],
      },
    });

    const patchDir = join(stateDirectory, 'container-agents', agentId, 'patches', 'revision-1');
    mkdirSync(patchDir, { recursive: true });

    // repo-alpha has 12 MiB patch, repo-beta has 12 MiB patch (Total 24 MiB > 20 MiB)
    const patchAlpha = 'diff --git a/file1.ts b/file1.ts\n' + '+line\n'.repeat(2 * 1024 * 1024);
    const patchBeta = 'diff --git a/file2.ts b/file2.ts\n' + '+line\n'.repeat(2 * 1024 * 1024);

    writeFileSync(join(patchDir, 'repo-alpha.full.patch'), patchAlpha);
    writeFileSync(join(patchDir, 'repo-beta.full.patch'), patchBeta);

    const diffs = store.readDiffs(runId);
    expect(diffs).toBeDefined();
    expect(diffs?.truncated).toBe(true);
    expect(diffs?.repositories).toHaveLength(2);
    expect(diffs?.repositories[0]?.repository).toBe('repo-alpha');
    expect(diffs?.repositories[1]?.repository).toBe('repo-beta');
    expect(diffs?.repositories[1]?.patch_truncated).toBe(true);

    const serializedBytes = Buffer.byteLength(JSON.stringify(diffs), 'utf8');
    expect(serializedBytes).toBeLessThanOrEqual(20 * 1024 * 1024);

    store.close();
  });

  it('appends raw event inside transaction and rolls back on fence failure in finalizeSteerDispatch', () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'local-engineer-atomic-steer-'));
    const store = new RunStore(stateDirectory);
    const runId = 'run_atomic_raw_1';
    const agentId = 'agt_atomic_raw_1';

    store.add({
      runId,
      agentId,
      ownerId: 'owner_1',
      fenceToken: 1,
      title: 'Atomic Raw Test',
      task: 'Task',
      workingDirectory: 'C:/work/example',
      worker: 'codex-local',
      status: 'running',
      workerThreadId: 'thread_1',
      workerTurnId: 'turn_1',
      continuationIndex: 0,
      createdAt: '2026-07-22T00:00:00.000Z',
      requiresUserAction: false,
    });

    const steerMsg = {
      id: 'steer_atomic_1',
      message: 'direction 1',
      status: 'pending' as const,
      queuedAt: new Date().toISOString(),
    };
    store.enqueueSteer(runId, steerMsg, { ownerId: 'owner_1', expectedFenceToken: 1 });
    const claim = store.claimNextSteer(runId, {
      ownerId: 'owner_1',
      expectedFenceToken: 1,
      workerThreadId: 'thread_1',
      workerTurnId: 'turn_1',
    });
    expect(claim).toBeDefined();

    const rawEvent1 = '{"method":"item/started","params":{"item":{"id":"steer_atomic_1"}}}\n';
    store.finalizeSteerDispatch(runId, {
      steerId: 'steer_atomic_1',
      status: 'delivered',
      rawEvent: rawEvent1,
      fence: {
        ownerId: 'owner_1',
        expectedFenceToken: 1,
        workerThreadId: 'thread_1',
        workerTurnId: 'turn_1',
      },
    });

    const rawPath = join(stateDirectory, 'runs', runId, 'harness', 'raw-events.jsonl');
    expect(existsSync(rawPath)).toBe(true);
    expect(readFileSync(rawPath, 'utf8')).toContain('steer_atomic_1');

    const steerMsg2 = {
      id: 'steer_atomic_2',
      message: 'direction 2',
      status: 'pending' as const,
      queuedAt: new Date().toISOString(),
    };
    store.enqueueSteer(runId, steerMsg2, { ownerId: 'owner_1', expectedFenceToken: 1 });
    const claim2 = store.claimNextSteer(runId, {
      ownerId: 'owner_1',
      expectedFenceToken: 1,
      workerThreadId: 'thread_1',
      workerTurnId: 'turn_1',
    });
    expect(claim2).toBeDefined();

    const rawEvent2 = '{"method":"item/started","params":{"item":{"id":"steer_atomic_2"}}}\n';
    expect(() =>
      store.finalizeSteerDispatch(runId, {
        steerId: 'steer_atomic_2',
        status: 'delivered',
        rawEvent: rawEvent2,
        fence: {
          ownerId: 'owner_1',
          expectedFenceToken: 99,
          workerThreadId: 'thread_1',
          workerTurnId: 'turn_1',
        },
      }),
    ).toThrow('MUTATION_FENCE_TOKEN_MISMATCH');

    expect(readFileSync(rawPath, 'utf8')).not.toContain('steer_atomic_2');
    const updated = store.get(runId);
    expect(updated?.steeringMessages?.find((m) => m.id === 'steer_atomic_2')?.status).toBe('dispatching');
    expect(updated?.steeringMessages?.find((m) => m.id === 'steer_atomic_2')?.status).not.toBe('delivered');

    store.close();
  });
});
