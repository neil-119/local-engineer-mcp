import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE_TEXT, MAX_MESSAGES_PER_RUN, RunStore } from '../src/store.js';
import type { Run } from '../src/domain.js';

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
