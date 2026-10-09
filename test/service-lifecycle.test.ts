import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Config, Run } from '../src/domain.js';
import {
  LocalEngineer,
  codexTurnFailure,
  completedAgentMessage,
  maskedPatchExitCode,
  safe,
  safeHarnessFailureDetail,
  isMissingRecoveredThread,
} from '../src/service.js';
import { type Clock, RunStore } from '../src/store.js';
import { PromotionPreflightError } from '../src/promotion-checkpoint.js';

describe('agent lifecycle history', () => {
  it('keeps a typed preflight rejection reviewable but blocks untyped or ambiguous failures', async () => {
    for (const typed of [true, false]) {
      const state = mkdtempSync(join(testTemporaryDirectory(), 'promotion-preflight-'));
      const store = new RunStore(state);
      const reviewed = {
        ...run('run_preflight', 'ready_for_review', 0),
        changeSet: { revision: 1, previous_revision: 0, digest: 'digest', repositories: [] },
      };
      store.add(reviewed);
      const engine = new LocalEngineer(config(state), store, 'owner_new', undefined, 30_000, 0, false);
      const manager = (engine as unknown as { containerManager: Record<string, unknown> }).containerManager;
      manager.promote = async () => {
        throw typed
          ? new PromotionPreflightError('PROMOTION_PARENT_PATH_CHANGED:SPEC.md')
          : new Error('PROMOTION_PARENT_PATH_CHANGED:SPEC.md');
      };
      await expect(engine.keepChanges(reviewed.agentId, 1, 'digest')).rejects.toThrow('PROMOTION_PARENT_PATH_CHANGED');
      expect(store.get(reviewed.runId)?.status).toBe(typed ? 'ready_for_review' : 'recovery_required');
      expect(store.get(reviewed.runId)?.operationClaim).toBeUndefined();
      await engine.close();
    }
  });

  it('requires operator confirmation and exact prior promotion evidence before recovery, without promoting', async () => {
    const state = mkdtempSync(join(testTemporaryDirectory(), 'promotion-recovery-'));
    const store = new RunStore(state);
    const earlier = {
      ...run('run_previous_promoted', 'promoted', 0),
      changeSet: { revision: 1, previous_revision: 0, digest: 'digest1', repositories: [] },
    };
    const failed = {
      ...run('run_failed_promote', 'recovery_required', 1),
      leaseExpiresAt: '2000-01-01T00:00:00.000Z',
      recovery: { kind: 'settled_operation' as const, operation: 'promote' as const },
      diagnostics: {
        last_phase: 'recovery_required',
        last_activity_at: new Date().toISOString(),
        recovery_error_excerpt: 'PROMOTION_PARENT_PATH_CHANGED:SPEC.md',
      },
      changeSet: { revision: 2, previous_revision: 1, digest: 'digest2', repositories: [] },
    };
    store.add(earlier);
    store.add(failed);
    const engine = new LocalEngineer(config(state), store, 'owner_operator', undefined, 30_000, 0, false);
    const manager = (engine as unknown as { containerManager: Record<string, unknown> }).containerManager;
    const bootstrap = vi.fn(async () => {
      expect(Date.parse(store.get(failed.runId)!.leaseExpiresAt!)).toBeGreaterThan(Date.now());
      return failed.changeSet;
    });
    const promote = vi.fn();
    manager.recoverPromotionCheckpoint = bootstrap;
    manager.promote = promote;
    await expect(engine.recoverPromotion(failed.agentId, failed.runId, earlier.runId, false)).rejects.toThrow(
      'PROMOTION_RECOVERY_CONFIRMATION_REQUIRED',
    );
    await expect(engine.recoverPromotion(failed.agentId, failed.runId, 'missing', true)).rejects.toThrow(
      'PROMOTION_PREFLIGHT_RECOVERY_REJECTED',
    );
    expect(bootstrap).not.toHaveBeenCalled();
    expect((await engine.recoverPromotion(failed.agentId, failed.runId, earlier.runId, true)).status).toBe(
      'ready_for_review',
    );
    expect(bootstrap).toHaveBeenCalledOnce();
    expect(promote).not.toHaveBeenCalled();
    expect(store.get(failed.runId)?.recovery).toBeUndefined();
    expect(store.get(earlier.runId)?.status).toBe('promoted');
    await engine.close();
  });

  it('does not unlock expired or partial promotion failures through preflight recovery', async () => {
    for (const error of [undefined, 'PROMOTION_ROLLBACK_INCOMPLETE', 'GIT_COMMAND_FAILED']) {
      const state = mkdtempSync(join(testTemporaryDirectory(), 'ambiguous-promote-'));
      const store = new RunStore(state);
      const record = {
        ...run('run_ambiguous', 'recovery_required', 0),
        recovery: { kind: 'settled_operation' as const, operation: 'promote' as const },
        diagnostics: {
          last_phase: 'recovery_required',
          last_activity_at: new Date().toISOString(),
          recovery_error_excerpt: error,
        },
      };
      store.add(record);
      expect(() => store.claimPromotionPreflightRecovery(record.agentId, record.runId, 'owner_operator')).toThrow(
        'PROMOTION_PREFLIGHT_RECOVERY_REJECTED',
      );
      expect(store.get(record.runId)?.status).toBe('recovery_required');
      store.close();
    }
  });

  it('returns pending promotion diffs without advancing the ordinary review cursor', async () => {
    const state = mkdtempSync(join(testTemporaryDirectory(), 'promotion-diff-'));
    const store = new RunStore(state);
    const reviewed = {
      ...run('run_pending_diff', 'ready_for_review', 0),
      changeSet: { revision: 3, previous_revision: 2, digest: 'digest', repositories: [] },
    };
    store.add(reviewed);
    const engine = new LocalEngineer(config(state), store, 'owner_review', undefined, 30_000, 0, false);
    const manager = (engine as unknown as { containerManager: Record<string, unknown> }).containerManager;
    manager.getPromotionPatch = async () => ({ patch: 'pending patch', fromRevision: 1 });
    const ordinary = vi.fn(async () => 'full patch');
    manager.getPatchBetween = ordinary;
    expect(await engine.getDiff(reviewed.agentId, 'app', 'promotion')).toMatchObject({
      from_revision: 1,
      to_revision: 3,
      patch: 'pending patch',
      check_cursor_advanced: false,
    });
    await engine.getDiff(reviewed.agentId, 'app', 'since_last_check');
    expect(ordinary).toHaveBeenCalledWith(reviewed.agentId, 'app', 0, 3);
    await engine.close();
  });

  it('keeps recovery blocked when retained checkpoint validation fails', async () => {
    const state = mkdtempSync(join(testTemporaryDirectory(), 'promotion-bad-recovery-'));
    const store = new RunStore(state);
    const previous = {
      ...run('run_previous', 'promoted', 0),
      changeSet: { revision: 1, previous_revision: 0, digest: 'old', repositories: [] },
    };
    const failed = {
      ...run('run_recover_failed', 'recovery_required', 1),
      recovery: { kind: 'settled_operation' as const, operation: 'promote' as const },
      diagnostics: {
        last_phase: 'recovery_required',
        last_activity_at: new Date().toISOString(),
        recovery_error_excerpt: 'PROMOTION_PARENT_PATH_CHANGED:SPEC.md',
      },
      changeSet: { revision: 2, previous_revision: 1, digest: 'new', repositories: [] },
    };
    store.add(previous);
    store.add(failed);
    const engine = new LocalEngineer(config(state), store, 'owner_operator', undefined, 30_000, 0, false);
    const manager = (engine as unknown as { containerManager: Record<string, unknown> }).containerManager;
    manager.recoverPromotionCheckpoint = async () => {
      throw new Error('PROMOTION_APPLIED_CONTENT_MISMATCH:SPEC.md');
    };
    await expect(engine.recoverPromotion(failed.agentId, failed.runId, previous.runId, true)).rejects.toThrow(
      'PROMOTION_APPLIED_CONTENT_MISMATCH',
    );
    expect(store.get(failed.runId)).toMatchObject({ status: 'recovery_required', recovery: { operation: 'promote' } });
    expect(store.get(failed.runId)?.operationClaim).toBeUndefined();
    await engine.close();
  });

  it('never clears a promotion claim after a competing fence advances', () => {
    const state = mkdtempSync(join(testTemporaryDirectory(), 'promotion-fenced-'));
    const store = new RunStore(state);
    const record = run('run_fenced_promote', 'ready_for_review', 0);
    store.add(record);
    const claimed = store.claimAgentOperation(
      record.agentId,
      record.runId,
      ['ready_for_review'],
      'owner_promote',
      'promote',
    );
    const fence = { ownerId: 'owner_promote', expectedFenceToken: claimed.fenceToken! };
    store.update(
      record.runId,
      {
        fenceToken: claimed.fenceToken! + 1,
        status: 'recovery_required',
        recovery: { kind: 'settled_operation', operation: 'promote' },
      },
      'test.competing_fence',
      fence,
    );
    expect(() => store.releasePromotionPreflightClaim(record.runId, fence)).toThrow('AGENT_OPERATION_CLAIM_REJECTED');
    expect(store.get(record.runId)?.status).toBe('recovery_required');
    store.close();
  });

  it('allows an exact opaque agent handle to recover review metadata after an MCP process changes', () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-capability-'));
    const store = new RunStore(stateDirectory);
    const engine = new LocalEngineer(config(stateDirectory), store, 'owner_new_connection');
    const reviewed = {
      ...run('run_retained', 'ready_for_review', 0),
      ownerId: 'owner_original_connection',
      changeSet: { revision: 1, previous_revision: 0, digest: `sha256:${'b'.repeat(64)}`, repositories: [] },
    };
    store.add(reviewed);

    expect(engine.status(undefined, [reviewed.agentId])).toHaveLength(1);
    expect(engine.getChanges(reviewed.agentId)).toMatchObject({
      run_id: reviewed.runId,
      change_set: { revision: 1 },
    });
    expect(engine.list({ limit: 10 })).toHaveLength(0);
  });

  it('returns a bounded actionable setup diagnostic without leaking local paths', () => {
    expect(safeHarnessFailureDetail(new Error('REPOSITORY_HEAD_REQUIRED'))).toBe('REPOSITORY_HEAD_REQUIRED');
    expect(safeHarnessFailureDetail(new Error('untrusted output C:\\Users\\someone\\secret'))).not.toContain('secret');
  });

  it('recognizes the app-server thread loss that requires a retained-container fallback', () => {
    expect(isMissingRecoveredThread(new Error('CODEX_RPC_ERROR:thread not found: private-thread'))).toBe(true);
    expect(isMissingRecoveredThread(new Error('CODEX_RPC_ERROR:permission denied'))).toBe(false);
    expect(isMissingRecoveredThread(new Error('CODEX_APP_SERVER_EXIT:0'))).toBe(true);
    expect(isMissingRecoveredThread(new Error('CODEX_APP_SERVER_EXIT:137'))).toBe(true);
  });

  it('records direct parent task and grounding text for an initial assignment', () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-start-'));
    const testConfig = config(stateDirectory);
    testConfig.security.allowed_roots = [stateDirectory];
    const store = new RunStore(stateDirectory);
    const engine = new LocalEngineer(testConfig, store, 'owner_test');
    Object.defineProperty(engine, 'queue', { value: () => undefined });

    const title = 'Initial assignment';
    const task = 'Inspect the narrow target.';
    const objective = 'Verify parent payload telemetry.';
    const started = engine.start({
      title,
      task,
      workingDirectory: stateDirectory,
      grounding: { objective, constraints: ['Do not edit files.'] },
    });

    expect(store.get(started.run_id)?.stats?.parent_to_worker).toMatchObject({
      task_assignments: 1,
      follow_up_messages: 0,
      title_characters: title.length,
      task_characters: task.length,
      grounding_characters: objective.length + 'Do not edit files.'.length,
      characters: title.length + task.length + objective.length + 'Do not edit files.'.length,
    });
  });

  it('records dependencyMode in start and projects it through SafeRun and reply continuations', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-dep-mode-'));
    const testConfig = config(stateDirectory);
    testConfig.security.allowed_roots = [stateDirectory];
    const store = new RunStore(stateDirectory);
    const engine = new LocalEngineer(testConfig, store, 'owner_test');
    Object.defineProperty(engine, 'queue', { value: () => undefined });

    const started = engine.start({
      title: 'Private install run',
      task: 'Install deps and test.',
      workingDirectory: stateDirectory,
      dependencyMode: 'private-install',
    });

    expect(started.dependency_mode).toBe('private-install');
    const runInStore = store.get(started.run_id);
    expect(runInStore?.dependencyMode).toBe('private-install');

    // Simulate run completing to ready_for_review
    store.setStatus(
      started.run_id,
      'ready_for_review',
      {
        completedAt: new Date().toISOString(),
        workerThreadId: 'thread_test_1',
        changeSet: {
          revision: 1,
          previous_revision: 0,
          digest: 'sha256:' + 'a'.repeat(64),
          repositories: [],
        },
      },
      { ownerId: 'owner_test' },
    );

    // Reply inherits dependencyMode
    vi.spyOn(
      engine as unknown as { restoreContainerAgent: () => Promise<void> },
      'restoreContainerAgent',
    ).mockResolvedValue(undefined);
    const replied = await engine.reply({
      agentId: started.agent_id,
      title: 'Follow-up turn',
      message: 'Run verification tests.',
    });
    expect(replied.dependency_mode).toBe('private-install');
    expect(store.get(replied.run_id)?.dependencyMode).toBe('private-install');
  });

  it('projects safe failure codes and actionable diagnostics to the parent', () => {
    const failed = {
      ...run('run_head_required', 'failed', 0),
      errorCode: 'REPOSITORY_HEAD_REQUIRED',
      diagnostics: {
        last_phase: 'failed',
        last_activity_at: '2026-07-24T00:00:00.000Z',
        exit_reason:
          'A Local Engineer repository needs at least one Git commit (a valid HEAD) before a worker can start.',
      },
    };

    expect(safe(failed)).toMatchObject({
      error_code: 'REPOSITORY_HEAD_REQUIRED',
      diagnostics: {
        exit_reason:
          'A Local Engineer repository needs at least one Git commit (a valid HEAD) before a worker can start.',
      },
    });
  });

  it('adds bounded live progress to timed-out wait projections', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-progress-'));
    const store = new RunStore(stateDirectory);
    const engine = new LocalEngineer(config(stateDirectory), store, 'owner_test');
    const running = {
      ...run('run_progress', 'running', 0),
      diagnostics: {
        last_phase: 'agent_message_streaming',
        last_activity_at: new Date().toISOString(),
        last_agent_message_at: new Date().toISOString(),
        last_agent_message_excerpt: 'Applying the validated next patch.',
        commands_started_count: 4,
        commands_completed_count: 4,
        commands_active_count: 0,
      },
    };
    store.add(running);
    const manager = (
      engine as unknown as { containerManager: { liveChangeCount: (agentId: string) => Promise<number> } }
    ).containerManager;
    manager.liveChangeCount = async () => 3;

    const projected = await (
      engine as unknown as { waitProjection: (run: Run) => Promise<Record<string, unknown>> }
    ).waitProjection(running);

    expect(projected).toMatchObject({
      live_progress: {
        state: 'producing_message',
        changed_file_count: 3,
        recent_message_excerpt: 'Applying the validated next patch.',
        recommended_parent_action: 'continue_waiting',
      },
    });
  });

  it('delivers only unseen revision deltas and does not advance a truncated cursor', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-diff-'));
    const store = new RunStore(stateDirectory);
    const engine = new LocalEngineer(config(stateDirectory), store, 'owner_test');
    const reviewed = {
      ...run('run_review', 'ready_for_review', 0),
      changeSet: { revision: 1, previous_revision: 0, digest: `sha256:${'a'.repeat(64)}`, repositories: [] },
    };
    store.add(reviewed);
    const calls: Array<[number, number]> = [];
    const manager = (
      engine as unknown as {
        containerManager: {
          getPatchBetween: (
            agentId: string,
            repository: string,
            fromRevision: number,
            toRevision: number,
          ) => Promise<string>;
        };
      }
    ).containerManager;
    manager.getPatchBetween = async (_agentId, _repository, fromRevision, toRevision) => {
      calls.push([fromRevision, toRevision]);
      return `revision-${fromRevision}-${toRevision}`;
    };

    expect(await engine.getDiff(reviewed.agentId, 'primary')).toMatchObject({
      from_revision: 0,
      to_revision: 1,
      check_cursor_advanced: true,
    });
    store.update(
      reviewed.runId,
      {
        changeSet: {
          revision: 2,
          previous_revision: 1,
          digest: `sha256:${'b'.repeat(64)}`,
          repositories: [],
        },
      },
      'test.revision',
    );
    expect(await engine.getDiff(reviewed.agentId, 'primary', 'since_last_check', 2)).toMatchObject({
      from_revision: 1,
      to_revision: 2,
      truncated: true,
      check_cursor_advanced: false,
    });
    expect(await engine.getDiff(reviewed.agentId, 'primary')).toMatchObject({
      from_revision: 1,
      to_revision: 2,
      check_cursor_advanced: true,
    });
    expect(calls).toEqual([
      [0, 1],
      [1, 2],
      [1, 2],
    ]);
  });

  it('supersedes the prior review run when a continuation is queued', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-reply-'));
    const store = new RunStore(stateDirectory);
    const engine = new LocalEngineer(config(stateDirectory), store, 'owner_test');
    const reviewed = {
      ...run('run_review', 'ready_for_review', 0),
      workerThreadId: 'thread_private',
    };
    store.add(reviewed);
    Object.defineProperty(engine, 'queue', { value: () => undefined });

    const continuation = await engine.reply({
      agentId: reviewed.agentId,
      title: 'Focused correction',
      message: 'Correct one reviewed issue.',
    });

    expect(store.get(reviewed.runId)?.status).toBe('superseded');
    expect(store.get(reviewed.runId)?.diagnostics?.exit_reason).toBe('continued_by_parent');
    expect(continuation).toMatchObject({
      agent_id: reviewed.agentId,
      status: 'queued',
      continuation_index: 1,
      continuation_of_run_id: reviewed.runId,
    });
    expect(store.get(continuation.run_id)?.stats?.parent_to_worker).toMatchObject({
      task_assignments: 0,
      follow_up_messages: 1,
      title_characters: 'Focused correction'.length,
      task_characters: 'Correct one reviewed issue.'.length,
      grounding_characters: 0,
      characters: 'Focused correction'.length + 'Correct one reviewed issue.'.length,
    });
  });

  it('retries from the retained reviewed revision after a continuation fails', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-reply-recovery-'));
    const store = new RunStore(stateDirectory);
    const engine = new LocalEngineer(config(stateDirectory), store, 'owner_test');
    const reviewed = {
      ...run('run_reviewed', 'superseded', 0),
      workerThreadId: 'thread_private',
      changeSet: { revision: 1, previous_revision: 0, digest: `sha256:${'c'.repeat(64)}`, repositories: [] },
    };
    const failed = { ...run('run_failed', 'failed', 1), agentId: reviewed.agentId };
    store.add(reviewed);
    store.add(failed);
    Object.defineProperty(engine, 'queue', { value: () => undefined });

    const retry = await engine.reply({
      agentId: reviewed.agentId,
      title: 'Retry retained review',
      message: 'Validate the existing revision and report.',
    });

    expect(retry).toMatchObject({
      continuation_index: 2,
      continuation_of_run_id: failed.runId,
      status: 'queued',
    });
  });

  it('returns explicit idempotent deletion confirmation and terminalizes stale review runs', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-delete-'));
    const store = new RunStore(stateDirectory);
    const engine = new LocalEngineer(config(stateDirectory), store, 'owner_test');
    const first = run('run_review', 'ready_for_review', 0);
    const promoted = run('run_promoted', 'promoted', 1);
    store.add(first);
    store.add(promoted);

    const deleted = await engine.deleteAgent(first.agentId);

    expect(deleted).toMatchObject({
      schema_version: 1,
      agent_id: first.agentId,
      deleted: true,
      resources_removed: true,
      discarded_run_ids: [first.runId],
      retained_history_run_ids: [promoted.runId],
      history_retained: true,
    });
    expect(store.get(first.runId)?.status).toBe('rejected');
    expect(store.get(promoted.runId)?.status).toBe('promoted');
    expect(store.get(promoted.runId)?.diagnostics?.resources_deleted_at).toBeTruthy();
    expect(engine.list({ activeOnly: true })).toEqual([]);

    await expect(engine.deleteAgent(first.agentId)).resolves.toMatchObject({
      deleted: true,
      resources_removed: true,
      discarded_run_ids: [],
      retained_history_run_ids: [first.runId, promoted.runId],
    });
  });

  it('deletes an agent even when restoring the container agent throws (dead/stopped container)', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-delete-dead-'));
    const store = new RunStore(stateDirectory);
    const engine = new LocalEngineer(config(stateDirectory), store, 'owner_test');
    const failedRun = run('run_stopped', 'failed', 0);
    store.add(failedRun);

    Object.defineProperty(engine, 'restoreContainerAgent', {
      value: async () => {
        throw new Error('CONTAINER_PROXY_ADDRESS_CHANGED');
      },
    });

    const deleted = await engine.deleteAgent(failedRun.agentId);
    expect(deleted).toMatchObject({
      agent_id: failedRun.agentId,
      deleted: true,
      resources_removed: true,
    });
  });

  it('keeps stale worker runs capacity-blocking until cleanup completes', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-reconcile-'));
    const store = new RunStore(stateDirectory);
    const engine = new LocalEngineer(config(stateDirectory), store, 'owner_test', undefined, 30_000, 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    let releaseCleanup!: () => void;
    const cleanupDeferred = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const manager = (engine as unknown as { containerManager: { cleanup: (agentId: string) => Promise<void> } })
      .containerManager;
    manager.cleanup = async () => cleanupDeferred;

    // Simulate runs left behind by a server restart or crash with expired leases
    for (const zombie of [
      run('run_zombie_starting', 'starting', 0, '2020-01-01T00:00:00.000Z'),
      run('run_zombie_running', 'running', 1, '2020-01-01T00:00:00.000Z'),
      run('run_zombie_cancelling', 'cancel_requested', 2, '2020-01-01T00:00:00.000Z'),
      run('run_zombie_queued', 'queued', 3, '2020-01-01T00:00:00.000Z'),
    ]) {
      zombie.ownerId = 'owner_dead';
      store.add(zombie);
    }

    const freshRun = run('run_new', 'queued', 4);
    freshRun.ownerId = 'owner_test';
    store.add(freshRun);
    const maintenance = (engine as unknown as { runMaintenance: () => Promise<void> }).runMaintenance();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Worker-backed runs remain recovery_required and consume capacity while
    // cleanup is outstanding. A queued orphan has no worker and can settle.
    expect(store.get('run_zombie_starting')).toMatchObject({
      status: 'recovery_required',
      errorCode: 'SERVER_PROCESS_RESTARTED',
    });
    expect(store.get('run_zombie_running')).toMatchObject({
      status: 'recovery_required',
      errorCode: 'SERVER_PROCESS_RESTARTED',
    });
    expect(store.get('run_zombie_cancelling')).toMatchObject({
      status: 'recovery_required',
    });
    expect(store.get('run_zombie_queued')).toMatchObject({
      status: 'cancelled',
      errorCode: 'SERVER_PROCESS_RESTARTED',
    });

    expect(store.tryStart('run_new', 1, 1, 'owner_test', {}, 1)).toBeUndefined();

    releaseCleanup();
    await maintenance;
    expect(store.get('run_zombie_starting')?.status).toBe('failed');
    expect(store.get('run_zombie_running')?.status).toBe('failed');
    expect(store.get('run_zombie_cancelling')?.status).toBe('cancelled');
    expect(store.tryStart('run_new', 1, 1)?.status).toBe('starting');
    expect(engine.list({ activeOnly: true }).map((r) => r.run_id)).toEqual(['run_new']);
    await engine.close();
  });

  it('keeps failed cleanup in recovery_required and continues blocking capacity', async () => {
    const currentTime = 5_000_000;
    const testClock: Clock = { now: () => new Date(currentTime) };
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-recovery-failed-'));
    const testConfig = config(stateDirectory);
    testConfig.server.max_concurrency = 1;
    const store = new RunStore(stateDirectory, 1024 * 1024, testClock);
    const engine = new LocalEngineer(testConfig, store, 'owner_recovery', testClock, 30_000, 0);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const expired = run('run_cleanup_fails', 'running', 0, new Date(currentTime - 1).toISOString());
    expired.ownerId = 'owner_dead';
    store.add(expired, 30_000);
    store.update(expired.runId, { leaseExpiresAt: new Date(currentTime - 1).toISOString() }, 'test.expire', {
      ownerId: 'owner_dead',
      expectedFenceToken: 1,
    });
    const queued = run('run_waiting_for_cleanup', 'queued', 0);
    queued.ownerId = 'owner_recovery';
    store.add(queued, 30_000);

    const manager = (engine as unknown as { containerManager: { cleanup: (agentId: string) => Promise<void> } })
      .containerManager;
    manager.cleanup = async () => {
      throw new Error('CONTAINER_DELETE_FAILED:C:\\sensitive\\path');
    };

    await (engine as unknown as { runMaintenance: () => Promise<void> }).runMaintenance();

    expect(store.get(expired.runId)).toMatchObject({
      status: 'recovery_required',
      errorCode: 'CONTAINER_AGENT_CLEANUP_FAILED',
      requiresUserAction: true,
      recovery: { kind: 'container_cleanup', targetStatus: 'failed' },
      diagnostics: {
        exit_reason: 'Container-agent cleanup did not complete; concurrency remains blocked.',
      },
    });
    expect(store.get(expired.runId)?.diagnostics?.recovery_error_excerpt).not.toContain('sensitive');
    expect(store.tryStart(queued.runId, 1, 1, 'owner_recovery', {}, 1, 30_000)).toBeUndefined();

    await engine.close();
    store.close();
  });

  it('stops the adapter when cancelling a run in starting state', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-cancel-starting-'));
    const store = new RunStore(stateDirectory);
    const engine = new LocalEngineer(config(stateDirectory), store, 'owner_test');

    const startingRun = run('run_starting', 'starting', 0);
    store.add(startingRun);

    let adapterStopped = false;
    const mockAdapter = {
      stop: async () => {
        adapterStopped = true;
      },
      interrupt: async () => undefined,
    };
    (engine as unknown as { adapters: Map<string, unknown> }).adapters.set(startingRun.agentId, mockAdapter);

    const cancelled = await engine.cancel(startingRun.runId);
    expect(cancelled.status).toBe('cancelled');
    expect(adapterStopped).toBe(true);
    expect((engine as unknown as { adapters: Map<string, unknown> }).adapters.has(startingRun.agentId)).toBe(false);
    expect(store.get(startingRun.runId)?.status).toBe('cancelled');
  });

  it('handles startup timeout cleanly and transitions run to failed with STARTUP_TIMEOUT', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-startup-timeout-'));
    const testConfig = config(stateDirectory);
    testConfig.security.allowed_roots = [stateDirectory];
    const store = new RunStore(stateDirectory);
    const engine = new LocalEngineer(testConfig, store, 'owner_test');

    // Simulate containerManager.probe hanging past startup timeout
    const manager = (engine as unknown as { containerManager: { probe: () => Promise<unknown> } }).containerManager;
    manager.probe = () => new Promise((resolve) => setTimeout(resolve, 5000));

    store.add(run('run_timeout', 'queued', 0));
    // Execute with a very short timeout (0.05 seconds, meaning startup timeout is 50ms)
    const executePromise = (
      engine as unknown as { execute: (runId: string, timeoutSeconds: number) => Promise<void> }
    ).execute('run_timeout', 0.05);

    await executePromise;

    const finished = store.get('run_timeout');
    expect(finished?.status).toBe('failed');
    expect(finished?.errorCode).toBe('STARTUP_TIMEOUT');
    expect(finished?.diagnostics?.last_phase).toBe('startup_timed_out');
    expect(finished?.diagnostics?.exit_reason).toContain('Worker startup or container preparation timed out');
  });

  it('cleans up container and skips adapter creation if the run is cancelled while starting preparation completes', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-cancel-mid-startup-'));
    const testConfig = config(stateDirectory);
    testConfig.security.allowed_roots = [stateDirectory];
    const store = new RunStore(stateDirectory);
    const engine = new LocalEngineer(testConfig, store, 'owner_test');

    let cleanupCalled = false;
    let adapterCreated = false;
    const mockAdapter = {
      stop: async () => {},
      createAndStart: async () => ({ threadId: 'th_1', turnId: 'turn_1' }),
      wait: async () => ({ summary: 'ok' }),
    };

    const manager = (
      engine as unknown as {
        containerManager: {
          probe: () => Promise<unknown>;
          prepare: () => Promise<unknown>;
          cleanup: (agentId: string) => Promise<void>;
          appServerWorker: () => unknown;
        };
      }
    ).containerManager;

    manager.probe = async () => ({ supported: true });
    manager.cleanup = async () => {
      cleanupCalled = true;
    };
    manager.prepare = async () => {
      // Cancel the run while prepare is executing
      store.setStatus('run_cancel_mid', 'cancelled');
      return { repositories: new Map() };
    };
    manager.appServerWorker = () => ({});

    // Mock adapter creation
    (
      engine as unknown as {
        adapter: () => Promise<unknown>;
        adapters: Map<string, unknown>;
      }
    ).adapter = async (agentId: string) => {
      adapterCreated = true;
      (engine as unknown as { adapters: Map<string, unknown> }).adapters.set(agentId, mockAdapter);
      return mockAdapter;
    };

    store.add(run('run_cancel_mid', 'queued', 0));
    await (engine as unknown as { execute: (runId: string, timeoutSeconds: number) => Promise<void> }).execute(
      'run_cancel_mid',
      30,
    );

    expect(cleanupCalled).toBe(true);
    expect(adapterCreated).toBe(false);
    expect((engine as unknown as { adapters: Map<string, unknown> }).adapters.has('agt_lifecycle')).toBe(false);
  });

  it('stops and cleans up the adapter if the run is cancelled after adapter creation during session start', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-cancel-session-start-'));
    const testConfig = config(stateDirectory);
    testConfig.security.allowed_roots = [stateDirectory];
    const store = new RunStore(stateDirectory);
    const engine = new LocalEngineer(testConfig, store, 'owner_test');

    let adapterStopped = false;
    const mockAdapter = {
      stop: async () => {
        adapterStopped = true;
      },
      createAndStart: async () => {
        // Cancel run while createAndStart is executing
        await engine.cancel('run_cancel_session');
        return { threadId: 'th_1', turnId: 'turn_1' };
      },
      wait: async () => ({ summary: 'ok' }),
    };

    const manager = (
      engine as unknown as {
        containerManager: {
          probe: () => Promise<unknown>;
          prepare: () => Promise<unknown>;
          cleanup: (agentId: string) => Promise<void>;
          appServerWorker: () => unknown;
        };
      }
    ).containerManager;

    manager.probe = async () => ({ supported: true });
    manager.prepare = async () => ({ repositories: new Map() });
    manager.cleanup = async () => {};
    manager.appServerWorker = () => ({});

    (
      engine as unknown as {
        adapter: () => Promise<unknown>;
        adapters: Map<string, unknown>;
      }
    ).adapter = async (agentId: string) => {
      (engine as unknown as { adapters: Map<string, unknown> }).adapters.set(agentId, mockAdapter);
      return mockAdapter;
    };

    store.add(run('run_cancel_session', 'queued', 0));
    await (engine as unknown as { execute: (runId: string, timeoutSeconds: number) => Promise<void> }).execute(
      'run_cancel_session',
      30,
    );

    expect(adapterStopped).toBe(true);
    expect((engine as unknown as { adapters: Map<string, unknown> }).adapters.has('agt_lifecycle')).toBe(false);
  });

  it('stops and deletes adapter when run reaches ready_for_review on Windows platform', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-win-review-cleanup-'));
    const testConfig = config(stateDirectory);
    testConfig.container.platform = 'windows';
    testConfig.security.allowed_roots = [stateDirectory];
    const store = new RunStore(stateDirectory);
    const engine = new LocalEngineer(testConfig, store, 'owner_test');

    let adapterStopped = false;
    const mockAdapter = {
      stop: async () => {
        adapterStopped = true;
      },
      createAndStart: async () => ({ threadId: 'th_1', turnId: 'turn_1' }),
      wait: async () => ({ summary: 'completed' }),
    };

    const manager = (
      engine as unknown as {
        containerManager: {
          probe: () => Promise<unknown>;
          prepare: () => Promise<unknown>;
          appServerWorker: () => unknown;
          capture: () => Promise<unknown>;
        };
      }
    ).containerManager;

    manager.probe = async () => ({ supported: true });
    manager.prepare = async () => ({ repositories: new Map() });
    manager.appServerWorker = () => ({});
    manager.capture = async () => ({ revision: 1, patchDigest: 'abc', changedFiles: [] });

    (
      engine as unknown as {
        adapter: () => Promise<unknown>;
        adapters: Map<string, unknown>;
      }
    ).adapter = async (agentId: string) => {
      (engine as unknown as { adapters: Map<string, unknown> }).adapters.set(agentId, mockAdapter);
      return mockAdapter;
    };

    store.add(run('run_win_done', 'queued', 0));
    await (engine as unknown as { execute: (runId: string, timeoutSeconds: number) => Promise<void> }).execute(
      'run_win_done',
      30,
    );

    const doneRun = store.get('run_win_done');
    expect(doneRun?.status).toBe('ready_for_review');
    expect(adapterStopped).toBe(true);
    expect((engine as unknown as { adapters: Map<string, unknown> }).adapters.has('agt_lifecycle')).toBe(false);
  });

  it('manages multi-process leases, preserves live owners, reclaims expired runs, and fences stale resumed owners', async () => {
    let currentTime = 1_000_000;
    const testClock: Clock = { now: () => new Date(currentTime) };
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-multi-process-'));
    const store = new RunStore(stateDirectory, 1024 * 1024, testClock);

    const testConfig = config(stateDirectory);
    const engine1 = new LocalEngineer(testConfig, store, 'owner_instance_1');
    const engine2 = new LocalEngineer(testConfig, store, 'owner_instance_2');

    // Instance 1 creates runs
    const r1 = run('run_inst1_queued', 'queued', 0);
    r1.ownerId = 'owner_instance_1';
    store.add(r1, 30_000);

    const r2 = run('run_inst1_running', 'running', 1);
    r2.ownerId = 'owner_instance_1';
    store.add(r2, 30_000);

    // 1. Live-owner preservation: Instance 2 reconciles -> 0 reconciled
    const rec1 = store.reconcileStaleRuns();
    expect(rec1.reconciledCount).toBe(0);
    expect(store.get('run_inst1_queued')?.status).toBe('queued');
    expect(store.get('run_inst1_running')?.status).toBe('running');

    // 2. Owner isolation in tryStart: Instance 2 cannot claim or start Instance 1's queued run
    const claimByInst2 = store.tryStart('run_inst1_queued', 10, 10, 'owner_instance_2');
    expect(claimByInst2).toBeUndefined();

    // 3. Heartbeat renewal: Clock advances 15 seconds. Instance 1 heartbeats
    currentTime += 15_000;
    const hb = store.heartbeat('owner_instance_1', 30_000);
    expect(hb.renewedCount).toBe(2);

    // Instance 2 reconciles at currentTime (1_015_000) -> 0 reconciled
    const rec2 = store.reconcileStaleRuns();
    expect(rec2.reconciledCount).toBe(0);

    // 4. Expired-owner reclamation: Clock advances past renewed lease expiry
    currentTime += 35_000;
    const rec3 = store.reconcileStaleRuns();
    expect(rec3.reconciledCount).toBe(2);
    expect(rec3.reconciledRunIds).toEqual(expect.arrayContaining(['run_inst1_queued', 'run_inst1_running']));

    const reclaimedQueued = store.get('run_inst1_queued')!;
    expect(reclaimedQueued.status).toBe('cancelled');
    expect(reclaimedQueued.fenceToken).toBe(2);

    const reclaimedRunning = store.get('run_inst1_running')!;
    expect(reclaimedRunning.status).toBe('recovery_required');
    expect(reclaimedRunning.recovery).toEqual({ kind: 'container_cleanup', targetStatus: 'failed' });
    expect(reclaimedRunning.fenceToken).toBe(2);

    // 5. Resumed stale owner rejected by fencing
    expect(() =>
      store.update('run_inst1_running', { status: 'running' }, 'run.resumed', {
        ownerId: 'owner_instance_1',
        expectedFenceToken: 1,
      }),
    ).toThrow(/FENCE_REJECTED/);

    expect(() => store.setStatus('run_inst1_running', 'running', {}, { ownerId: 'owner_instance_1' })).toThrow(
      /FENCE_REJECTED|FENCE_REQUIRED/,
    );

    engine1.close();
    engine2.close();
    store.close();
  });

  it('enforces restart-compatibility across instances for two-turn continuation, promotion, and deletion', async () => {
    const currentTime = 1_000_000;
    const testClock: Clock = { now: () => new Date(currentTime) };
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-restart-compat-'));
    const testConfig = config(stateDirectory);
    testConfig.security.allowed_roots = [stateDirectory];

    // --- TURN 1 on Instance 1 ---
    const store1 = new RunStore(stateDirectory, 1024 * 1024, testClock);
    const engine1 = new LocalEngineer(testConfig, store1, 'owner_inst_1', testClock);

    const mockAgentManager1 = (engine1 as unknown as { containerManager: Record<string, unknown> }).containerManager;
    mockAgentManager1.probe = async () => ({ supported: true });
    mockAgentManager1.prepare = async () => ({ repositories: new Map() });
    mockAgentManager1.appServerWorker = () => ({});
    mockAgentManager1.capture = async () => ({
      revision: 1,
      patchDigest: 'digest_rev1',
      changedFiles: ['file1.txt'],
      patch: 'patch1',
    });
    mockAgentManager1.promote = async () => undefined;
    mockAgentManager1.recover = async () => undefined;
    mockAgentManager1.delete = async () => undefined;

    const mockAdapter1 = {
      createAndStart: async () => ({ threadId: 'thread_turn1', turnId: 'turn_1' }),
      wait: async () => ({
        final_message: JSON.stringify({
          summary: 'Turn 1 report',
          verification: [],
          files_changed: ['file1.txt'],
          unresolved_risks: [],
        }),
      }),
      stop: async () => undefined,
      interrupt: async () => undefined,
    };
    (engine1 as unknown as { adapter: () => Promise<unknown> }).adapter = async () => mockAdapter1;

    const run1 = run('run_turn_1', 'queued', 0);
    run1.agentId = 'agt_cross_turn';
    run1.ownerId = 'owner_inst_1';
    run1.repositories = [
      {
        name: 'primary',
        parentPath: stateDirectory,
        containerPath: 'C:/repos/primary',
        access: 'read-write',
      },
    ];
    store1.add(run1, 30_000);

    await (engine1 as unknown as { execute: (runId: string, timeoutSeconds: number) => Promise<void> }).execute(
      'run_turn_1',
      30,
    );

    const readyTurn1 = store1.get('run_turn_1')!;
    expect(readyTurn1.status).toBe('ready_for_review');
    expect(readyTurn1.fenceToken).toBe(2);
    expect(readyTurn1.changeSet?.revision).toBe(1);

    await engine1.close();
    store1.close();

    // --- TURN 2 on Instance 2 (fresh process, separate store instance, new ownerId) ---
    const store2 = new RunStore(stateDirectory, 1024 * 1024, testClock);
    const engine2 = new LocalEngineer(testConfig, store2, 'owner_inst_2', testClock);

    const mockAgentManager2 = (engine2 as unknown as { containerManager: Record<string, unknown> }).containerManager;
    mockAgentManager2.probe = async () => ({ supported: true });
    mockAgentManager2.prepare = async () => ({ repositories: new Map() });
    mockAgentManager2.appServerWorker = () => ({});
    mockAgentManager2.capture = async () => ({
      revision: 2,
      patchDigest: 'digest_rev2',
      changedFiles: ['file1.txt', 'file2.txt'],
      patch: 'patch2',
    });
    mockAgentManager2.promote = async () => undefined;
    mockAgentManager2.recover = async () => undefined;
    mockAgentManager2.delete = async () => undefined;

    const mockAdapter2 = {
      createAndStart: async () => ({ threadId: 'thread_turn2', turnId: 'turn_2' }),
      continue: async () => 'turn_2',
      wait: async () => ({
        final_message: JSON.stringify({
          summary: 'Turn 2 report',
          verification: [],
          files_changed: ['file1.txt', 'file2.txt'],
          unresolved_risks: [],
        }),
      }),
      stop: async () => undefined,
      interrupt: async () => undefined,
    };
    (engine2 as unknown as { adapter: () => Promise<unknown> }).adapter = async () => mockAdapter2;

    const replyTurn2 = await engine2.reply({
      agentId: 'agt_cross_turn',
      title: 'Turn 2 continuation',
      message: 'Add file2.txt',
    });

    expect(replyTurn2.status).toBe('queued');
    expect(replyTurn2.continuation_index).toBe(1);

    const supersededTurn1 = store2.get('run_turn_1')!;
    expect(supersededTurn1.status).toBe('superseded');

    await (engine2 as unknown as { execute: (runId: string, timeoutSeconds: number) => Promise<void> }).execute(
      replyTurn2.run_id,
      30,
    );

    const readyTurn2 = store2.get(replyTurn2.run_id)!;
    expect(readyTurn2.status).toBe('ready_for_review');
    expect(readyTurn2.fenceToken).toBe(2);
    expect(readyTurn2.changeSet?.revision).toBe(2);

    await engine2.close();
    store2.close();

    // --- PROMOTION & DELETION on Instance 3 (third process, new ownerId) ---
    const store3 = new RunStore(stateDirectory, 1024 * 1024, testClock);
    const engine3 = new LocalEngineer(testConfig, store3, 'owner_inst_3', testClock);

    const mockAgentManager3 = (engine3 as unknown as { containerManager: Record<string, unknown> }).containerManager;
    let promotedRevision = 0;
    mockAgentManager3.promote = async (_agt: string, rev: number) => {
      promotedRevision = rev;
    };
    mockAgentManager3.recover = async () => undefined;
    mockAgentManager3.delete = async () => undefined;

    const promotedResult = await engine3.keepChanges('agt_cross_turn', 2, 'digest_rev2');
    expect(promotedResult.status).toBe('promoted');
    expect(promotedRevision).toBe(2);

    const promotedRecord = store3.get(replyTurn2.run_id)!;
    expect(promotedRecord.status).toBe('promoted');

    const deleteResult = await engine3.deleteAgent('agt_cross_turn');
    expect(deleteResult.deleted).toBe(true);
    expect(deleteResult.history_retained).toBe(true);

    const deletedRecord1 = store3.get('run_turn_1')!;
    expect(deletedRecord1.diagnostics?.resources_deleted_at).toBeTruthy();
    const deletedRecord2 = store3.get(replyTurn2.run_id)!;
    expect(deletedRecord2.diagnostics?.resources_deleted_at).toBeTruthy();

    await engine3.close();
    store3.close();
  });

  it('allows exactly one cross-process reply, promotion, and deletion side effect', async () => {
    const repository = (root: string) => [
      {
        name: 'primary',
        parentPath: root,
        containerPath: 'C:/repos/primary',
        access: 'read-write' as const,
      },
    ];

    // Reply claim: only the winner may recover retained resources and add a continuation.
    const replyState = mkdtempSync(join(testTemporaryDirectory(), 'service-claim-reply-'));
    const replyStoreA = new RunStore(replyState);
    const reviewed = {
      ...run('run_claim_reply', 'ready_for_review', 0),
      agentId: 'agt_claim_reply',
      workerThreadId: 'thread_claim_reply',
      repositories: repository(replyState),
    };
    replyStoreA.add(reviewed);
    const replyStoreB = new RunStore(replyState);
    const replyEngineA = new LocalEngineer(config(replyState), replyStoreA, 'owner_reply_a', undefined, 30_000, 0);
    const replyEngineB = new LocalEngineer(config(replyState), replyStoreB, 'owner_reply_b', undefined, 30_000, 0);
    Object.defineProperty(replyEngineA, 'queue', { value: () => undefined });
    Object.defineProperty(replyEngineB, 'queue', { value: () => undefined });
    let recoverCalls = 0;
    for (const engine of [replyEngineA, replyEngineB]) {
      const manager = (engine as unknown as { containerManager: Record<string, unknown> }).containerManager;
      manager.recover = async () => {
        recoverCalls++;
      };
    }
    const replies = await Promise.allSettled(
      [replyEngineA, replyEngineB].map((engine, index) =>
        engine.reply({
          agentId: reviewed.agentId,
          title: `Concurrent reply ${index}`,
          message: 'Only one continuation may be created.',
        }),
      ),
    );
    expect(replies.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(replies.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(recoverCalls).toBe(1);
    expect(replyStoreA.getByAgent(reviewed.agentId)).toHaveLength(2);
    await replyEngineA.close();
    await replyEngineB.close();

    // Promotion claim: only the winner may touch the host repository.
    const promoteState = mkdtempSync(join(testTemporaryDirectory(), 'service-claim-promote-'));
    const promoteStoreA = new RunStore(promoteState);
    const promotable = {
      ...run('run_claim_promote', 'ready_for_review', 0),
      agentId: 'agt_claim_promote',
      repositories: repository(promoteState),
      changeSet: { revision: 1, previous_revision: 0, digest: 'digest_claim', repositories: [] },
    };
    promoteStoreA.add(promotable);
    const promoteStoreB = new RunStore(promoteState);
    const promoteEngineA = new LocalEngineer(
      config(promoteState),
      promoteStoreA,
      'owner_promote_a',
      undefined,
      30_000,
      0,
    );
    const promoteEngineB = new LocalEngineer(
      config(promoteState),
      promoteStoreB,
      'owner_promote_b',
      undefined,
      30_000,
      0,
    );
    let promoteCalls = 0;
    for (const engine of [promoteEngineA, promoteEngineB]) {
      const manager = (engine as unknown as { containerManager: Record<string, unknown> }).containerManager;
      manager.recover = async () => undefined;
      manager.promote = async () => {
        promoteCalls++;
      };
    }
    const promotions = await Promise.allSettled(
      [promoteEngineA, promoteEngineB].map((engine) => engine.keepChanges(promotable.agentId, 1, 'digest_claim')),
    );
    expect(promotions.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(promotions.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(promoteCalls).toBe(1);
    expect(promoteStoreA.get(promotable.runId)?.status).toBe('promoted');
    await promoteEngineA.close();
    await promoteEngineB.close();

    // Deletion claim: only the winner may remove retained resources.
    const deleteState = mkdtempSync(join(testTemporaryDirectory(), 'service-claim-delete-'));
    const deleteStoreA = new RunStore(deleteState);
    const deletable = { ...run('run_claim_delete', 'failed', 0), agentId: 'agt_claim_delete' };
    deleteStoreA.add(deletable);
    const deleteStoreB = new RunStore(deleteState);
    const deleteEngineA = new LocalEngineer(config(deleteState), deleteStoreA, 'owner_delete_a', undefined, 30_000, 0);
    const deleteEngineB = new LocalEngineer(config(deleteState), deleteStoreB, 'owner_delete_b', undefined, 30_000, 0);
    let deleteCalls = 0;
    for (const engine of [deleteEngineA, deleteEngineB]) {
      const manager = (engine as unknown as { containerManager: Record<string, unknown> }).containerManager;
      manager.delete = async () => {
        deleteCalls++;
      };
    }
    const deletions = await Promise.allSettled(
      [deleteEngineA, deleteEngineB].map((engine) => engine.deleteAgent(deletable.agentId)),
    );
    expect(deletions.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(deletions.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(deleteCalls).toBe(1);
    await deleteEngineA.close();
    await deleteEngineB.close();
  });

  it('blocks deletion while an expired promotion may still be changing the host', async () => {
    let currentTime = 2_000_000;
    const testClock: Clock = { now: () => new Date(currentTime) };
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-expired-promotion-'));
    const storeA = new RunStore(stateDirectory, 1024 * 1024, testClock);
    const reviewed = {
      ...run('run_expired_promotion', 'ready_for_review', 0),
      agentId: 'agt_expired_promotion',
      repositories: [
        {
          name: 'primary',
          parentPath: stateDirectory,
          containerPath: 'C:/repos/primary',
          access: 'read-write' as const,
        },
      ],
      changeSet: { revision: 1, previous_revision: 0, digest: 'digest_expired', repositories: [] },
    };
    storeA.add(reviewed);
    const storeB = new RunStore(stateDirectory, 1024 * 1024, testClock);
    const engineA = new LocalEngineer(config(stateDirectory), storeA, 'owner_promoting', testClock, 30_000, 0);
    const engineB = new LocalEngineer(config(stateDirectory), storeB, 'owner_deleting', testClock, 30_000, 0);
    let releasePromotion!: () => void;
    let promotionEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      promotionEntered = resolve;
    });
    const blockedPromotion = new Promise<void>((resolve) => {
      releasePromotion = resolve;
    });
    let promoteCalls = 0;
    let deleteCalls = 0;
    const managerA = (engineA as unknown as { containerManager: Record<string, unknown> }).containerManager;
    const managerB = (engineB as unknown as { containerManager: Record<string, unknown> }).containerManager;
    managerA.recover = async () => undefined;
    managerA.promote = async () => {
      promoteCalls++;
      promotionEntered();
      await blockedPromotion;
    };
    managerB.delete = async () => {
      deleteCalls++;
    };

    const promotion = engineA.keepChanges(reviewed.agentId, 1, 'digest_expired');
    try {
      await entered;
      currentTime += 30_001;
      expect(storeB.reconcileStaleRuns({ ownerId: 'owner_deleting', leaseDurationMs: 30_000 })).toMatchObject({
        reconciledRunIds: [reviewed.runId],
      });
      expect(storeB.get(reviewed.runId)).toMatchObject({
        status: 'recovery_required',
        recovery: { kind: 'settled_operation', operation: 'promote' },
        requiresUserAction: true,
      });
      await expect(engineB.deleteAgent(reviewed.agentId)).rejects.toThrow('AGENT_OPERATION_RECOVERY_REQUIRED');
      expect(deleteCalls).toBe(0);
    } finally {
      releasePromotion();
    }
    await expect(promotion).rejects.toThrow('FENCE_REJECTED');
    expect(promoteCalls).toBe(1);
    expect(deleteCalls).toBe(0);
    expect(storeB.get(reviewed.runId)).toMatchObject({ status: 'recovery_required', requiresUserAction: true });
    await engineA.close();
    await engineB.close();
  });

  it('reclaims expired runs and unblocks concurrency across restarted instances via tryStart and periodic maintenance', async () => {
    let currentTime = 2_000_000;
    const testClock: Clock = { now: () => new Date(currentTime) };
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-restart-reclaim-'));
    const testConfig = config(stateDirectory);
    testConfig.server.max_concurrency = 1;

    const store1 = new RunStore(stateDirectory, 1024 * 1024, testClock);
    const engine1 = new LocalEngineer(testConfig, store1, 'owner_dead', testClock, 30_000, 5_000);

    const r1 = run('run_active_dead', 'queued', 0);
    r1.ownerId = 'owner_dead';
    store1.add(r1, 30_000);
    const claimed1 = store1.tryStart('run_active_dead', 1, 1, 'owner_dead', {}, 1, 30_000);
    expect(claimed1?.status).toBe('starting');
    expect(claimed1?.fenceToken).toBe(2);

    store1.close();

    currentTime += 2_000;
    const store2 = new RunStore(stateDirectory, 1024 * 1024, testClock);
    const engine2 = new LocalEngineer(testConfig, store2, 'owner_live', testClock, 30_000, 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    let cleanupCalls = 0;
    const manager2 = (engine2 as unknown as { containerManager: { cleanup: (agentId: string) => Promise<void> } })
      .containerManager;
    manager2.cleanup = async () => {
      cleanupCalls++;
    };

    expect(store2.get('run_active_dead')?.status).toBe('starting');

    const r2 = run('run_new', 'queued', 0);
    r2.ownerId = 'owner_live';
    store2.add(r2, 30_000);

    const prematureClaim = store2.tryStart('run_new', 1, 1, 'owner_live', {}, 1, 30_000);
    expect(prematureClaim).toBeUndefined();

    currentTime += 30_000;
    await (engine2 as unknown as { runMaintenance: () => Promise<void> }).runMaintenance();

    const successfulClaim = store2.tryStart('run_new', 1, 1, 'owner_live', {}, 1, 30_000);
    expect(successfulClaim).toBeDefined();
    expect(successfulClaim?.status).toBe('starting');
    expect(successfulClaim?.fenceToken).toBe(2);

    const deadReconciled = store2.get('run_active_dead')!;
    expect(deadReconciled.status).toBe('failed');
    expect(deadReconciled.errorCode).toBe('SERVER_PROCESS_RESTARTED');
    expect(deadReconciled.fenceToken).toBe(3);
    expect(cleanupCalls).toBe(1);

    await engine1.close();
    await engine2.close();
    store2.close();
  });

  it('strictly seals terminal runs and drops stale worker events passing obsolete fence tokens', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-fence-terminal-'));
    const store = new RunStore(stateDirectory);

    const r = run('run_terminal_test', 'queued', 0);
    r.ownerId = 'owner_1';
    store.add(r);

    store.setStatus('run_terminal_test', 'failed');
    expect(store.get('run_terminal_test')?.status).toBe('failed');

    expect(() =>
      store.update('run_terminal_test', { diagnostics: { last_phase: 'late_activity' } }, 'run.late_activity'),
    ).toThrow(/RUN_TERMINAL/);

    expect(() =>
      store.setStatus('run_terminal_test', 'running', {}, { ownerId: 'owner_1', expectedFenceToken: 1 }),
    ).toThrow(/RUN_TERMINAL/);

    const updated = store.update(
      'run_terminal_test',
      { diagnostics: { resources_deleted_at: '2026-09-22T00:00:00Z' } },
      'run.resources_deleted',
      { allowTerminalMutation: true },
    );
    expect(updated.diagnostics?.resources_deleted_at).toBe('2026-09-22T00:00:00Z');

    store.close();
  });

  it('allows a restarted instance to cancel an expired orphaned run from a dead owner', async () => {
    let currentTime = 3_000_000;
    const testClock: Clock = { now: () => new Date(currentTime) };
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-cancel-expired-'));
    const testConfig = config(stateDirectory);

    const store1 = new RunStore(stateDirectory, 1024 * 1024, testClock);
    const engine1 = new LocalEngineer(testConfig, store1, 'owner_dead', testClock);

    const r = run('run_orphaned', 'queued', 0);
    r.ownerId = 'owner_dead';
    store1.add(r, 30_000);
    store1.tryStart('run_orphaned', 10, 10, 'owner_dead', {}, 1, 30_000);
    expect(store1.get('run_orphaned')?.status).toBe('starting');

    store1.close();

    const store2 = new RunStore(stateDirectory, 1024 * 1024, testClock);
    const engine2 = new LocalEngineer(testConfig, store2, 'owner_new', testClock);

    currentTime += 35_000;

    const cancelled = await engine2.cancel('run_orphaned');
    expect(cancelled.status).toBe('cancelled');

    const cancelledRecord = store2.get('run_orphaned')!;
    expect(cancelledRecord.status).toBe('cancelled');

    await engine1.close();
    await engine2.close();
    store2.close();
  });

  it('deterministically cleans up container and preserves failed status when prepare resolves after startup timeout', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-deferred-prepare-'));
    const testConfig = config(stateDirectory);
    testConfig.security.allowed_roots = [stateDirectory];
    const store = new RunStore(stateDirectory);
    const engine = new LocalEngineer(testConfig, store, 'owner_test');

    let resolvePrepare!: (val: unknown) => void;
    const prepareDeferred = new Promise((resolve) => {
      resolvePrepare = resolve;
    });

    let cleanupCalled = false;
    let adapterCreated = false;
    let turnStarted = false;

    const manager = (
      engine as unknown as {
        containerManager: {
          probe: () => Promise<unknown>;
          prepare: () => Promise<unknown>;
          cleanup: (agentId: string) => Promise<void>;
          appServerWorker: () => unknown;
        };
      }
    ).containerManager;

    manager.probe = async () => ({ supported: true });
    manager.cleanup = async () => {
      cleanupCalled = true;
    };
    manager.prepare = () => prepareDeferred;
    manager.appServerWorker = () => ({});

    const mockAdapter = {
      stop: async () => {},
      createAndStart: async () => {
        turnStarted = true;
        return { threadId: 'th_1', turnId: 'turn_1' };
      },
      wait: async () => ({ summary: 'ok' }),
    };

    (
      engine as unknown as {
        adapter: () => Promise<unknown>;
        adapters: Map<string, unknown>;
      }
    ).adapter = async (agentId: string) => {
      adapterCreated = true;
      (engine as unknown as { adapters: Map<string, unknown> }).adapters.set(agentId, mockAdapter);
      return mockAdapter;
    };

    const targetRun = run('run_deferred_test', 'queued', 0);
    store.add(targetRun);

    const executePromise = (
      engine as unknown as { execute: (runId: string, timeoutSeconds: number) => Promise<void> }
    ).execute('run_deferred_test', 0.05);

    await executePromise;

    const failedRun = store.get('run_deferred_test');
    expect(failedRun?.status).toBe('failed');
    expect(failedRun?.errorCode).toBe('STARTUP_TIMEOUT');

    // Resolve prepare late in background
    resolvePrepare({
      repositories: new Map([
        ['primary', { runRepository: { name: 'primary', containerPath: '/workspace/primary', access: 'read-write' } }],
      ]),
    });

    await new Promise((r) => setTimeout(r, 50));

    const afterLatePrepare = store.get('run_deferred_test');
    expect(afterLatePrepare?.status).toBe('failed');
    expect(afterLatePrepare?.errorCode).toBe('STARTUP_TIMEOUT');

    const eventsPath = join(stateDirectory, 'runs', 'run_deferred_test', 'events.jsonl');
    let eventsContent = '';
    if (existsSync(eventsPath)) {
      eventsContent = readFileSync(eventsPath, 'utf-8');
    }
    expect(eventsContent).not.toContain('container_prepared');

    expect(adapterCreated).toBe(false);
    expect(turnStarted).toBe(false);
    expect(cleanupCalled).toBe(true);

    engine.close();
    store.close();
  });

  it('disposes pre-stop adapter on Windows, restarts worker with fresh app-server, and safely falls back on missing thread', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-retained-continuation-'));
    const testConfig = config(stateDirectory);
    testConfig.container.platform = 'windows';
    testConfig.security.allowed_roots = [stateDirectory];
    const store = new RunStore(stateDirectory);
    const engine = new LocalEngineer(testConfig, store, 'owner_test');

    let firstAdapterStopped = false;
    let secondAdapterStopped = false;
    let adapterInstanceCount = 0;
    let continueAttempted = false;
    let fallbackCreateAndStartAttempted = false;

    const mockAdapter1 = {
      instanceId: 1,
      stop: async () => {
        firstAdapterStopped = true;
      },
      createAndStart: async () => ({ threadId: 'th_initial', turnId: 'turn_initial' }),
      wait: async () => ({ summary: 'first turn complete' }),
    };

    const mockAdapter2 = {
      instanceId: 2,
      stop: async () => {
        secondAdapterStopped = true;
      },
      continue: async (threadId: string) => {
        continueAttempted = true;
        throw new Error(`CODEX_RPC_ERROR:thread not found: ${threadId}`);
      },
      createAndStart: async (workdir: string, prompt: string) => {
        fallbackCreateAndStartAttempted = true;
        expect(prompt).toContain('Recovery context:');
        return { threadId: 'th_recovered', turnId: 'turn_recovered' };
      },
      wait: async () => ({ summary: 'second turn complete' }),
    };

    let prepareCallCount = 0;
    const manager = (
      engine as unknown as {
        containerManager: {
          probe: () => Promise<unknown>;
          prepare: () => Promise<unknown>;
          appServerWorker: () => unknown;
          capture: () => Promise<unknown>;
        };
      }
    ).containerManager;

    manager.probe = async () => ({ supported: true });
    manager.prepare = async () => {
      prepareCallCount++;
      return { repositories: new Map() };
    };
    manager.appServerWorker = () => ({});
    let capturedRevision = 1;
    manager.capture = async () => ({
      revision: capturedRevision++,
      patchDigest: `digest_${capturedRevision}`,
      changedFiles: ['file.txt'],
    });

    (
      engine as unknown as {
        adapter: () => Promise<unknown>;
        adapters: Map<string, unknown>;
      }
    ).adapter = async (agentId: string) => {
      adapterInstanceCount++;
      const selected = adapterInstanceCount === 1 ? mockAdapter1 : mockAdapter2;
      (engine as unknown as { adapters: Map<string, unknown> }).adapters.set(agentId, selected);
      return selected;
    };

    // Turn 1
    const run1 = run('run_turn1', 'queued', 0);
    store.add(run1);
    await (engine as unknown as { execute: (runId: string, timeoutSeconds: number) => Promise<void> }).execute(
      'run_turn1',
      30,
    );

    const turn1Settled = store.get('run_turn1');
    expect(turn1Settled?.status).toBe('ready_for_review');
    expect(firstAdapterStopped).toBe(true);
    expect((engine as unknown as { adapters: Map<string, unknown> }).adapters.has('agt_lifecycle')).toBe(false);
    expect(prepareCallCount).toBe(1);

    // Turn 2: continuation on same retained agent
    const run2 = run('run_turn2', 'queued', 1);
    run2.workerThreadId = 'th_initial';
    store.add(run2);
    await (engine as unknown as { execute: (runId: string, timeoutSeconds: number) => Promise<void> }).execute(
      'run_turn2',
      30,
    );

    const turn2Settled = store.get('run_turn2');
    expect(turn2Settled?.status).toBe('ready_for_review');
    expect(prepareCallCount).toBe(2);
    expect(adapterInstanceCount).toBe(2);
    expect(continueAttempted).toBe(true);
    expect(fallbackCreateAndStartAttempted).toBe(true);
    expect(turn2Settled?.diagnostics?.last_phase).toBe('ready_for_review');
    expect(turn2Settled?.workerThreadId).toBe('th_recovered');
    expect(secondAdapterStopped).toBe(true);
    expect((engine as unknown as { adapters: Map<string, unknown> }).adapters.has('agt_lifecycle')).toBe(false);

    engine.close();
    store.close();
  });

  it('cancels a queued run directly to cancelled without an invalid cancel_requested intermediate', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-cancel-queued-'));
    const testConfig = config(stateDirectory);
    const store = new RunStore(stateDirectory);
    const engine = new LocalEngineer(testConfig, store, 'owner_test');

    const r = run('run_queued_cancel', 'queued', 0);
    r.ownerId = 'owner_test';
    store.add(r, 30_000);
    expect(store.get('run_queued_cancel')?.status).toBe('queued');

    const result = await engine.cancel('run_queued_cancel');
    expect(result.status).toBe('cancelled');

    // Must never have visited cancel_requested (invalid for queued → domain invariant)
    const eventsPath = join(stateDirectory, 'runs', 'run_queued_cancel', 'events.jsonl');
    const events = readFileSync(eventsPath, 'utf-8');
    expect(events).not.toContain('cancel_requested');
    expect(events).toContain('cancelled');

    engine.close();
    store.close();
  });

  it('transactionally rejects all stale event writes when reconciliation wins after event receipt', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-fence-events-'));
    const testConfig = config(stateDirectory);
    let currentTime = 1_000_000;
    const testClock: Clock = { now: () => new Date(currentTime) };
    const store = new RunStore(stateDirectory, 1024 * 1024, testClock);
    const engine = new LocalEngineer(testConfig, store, 'owner_test', testClock, 30_000, 0);
    const competingStore = new RunStore(stateDirectory, 1024 * 1024, testClock);

    const r = run('run_fence_events', 'queued', 0);
    r.ownerId = 'owner_test';
    store.add(r, 30_000);
    // Start it so there's a meaningful fenceToken=2
    const started = store.tryStart('run_fence_events', 10, 10, 'owner_test', {}, 1, 30_000)!;
    store.setStatus(
      started.runId,
      'running',
      { workerThreadId: 'th_stale', workerTurnId: 'turn_stale' },
      { ownerId: 'owner_test', expectedFenceToken: started.fenceToken },
    );

    // Force the competing process to reconcile after onEvent has selected the
    // run snapshot but immediately before the atomic ingestion transaction.
    const originalIngest = store.ingestEvent.bind(store);
    let reconciledBetweenReceiptAndPersistence = false;
    store.ingestEvent = (...args) => {
      currentTime += 35_000;
      competingStore.reconcileStaleRuns({
        now: new Date(currentTime),
        ownerId: 'owner_recovery',
        leaseDurationMs: 30_000,
      });
      reconciledBetweenReceiptAndPersistence = true;
      return originalIngest(...args);
    };

    // Fire an event matching the stale run's worker/thread/turn IDs.
    const onEvent = (engine as unknown as { onEvent: (worker: string, event: unknown) => void }).onEvent.bind(engine);
    onEvent('local-container', {
      method: 'item/completed',
      params: {
        threadId: 'th_stale',
        turnId: 'turn_stale',
        item: { type: 'agentMessage', id: 'msg_1', text: 'hello' },
      },
    });

    store.ingestEvent = originalIngest;

    expect(reconciledBetweenReceiptAndPersistence).toBe(true);
    expect(store.get('run_fence_events')).toMatchObject({ status: 'recovery_required', fenceToken: 3 });

    // captureMessage must have been suppressed (live fenceToken=3 !== stale fenceToken=2)
    const messages = store.listMessagesPage('run_fence_events', 10);
    expect(messages.messages).toHaveLength(0);

    // appendRaw must have been suppressed — raw-events file should not exist
    const rawEventsPath = join(stateDirectory, 'runs', 'run_fence_events', 'harness', 'raw-events.jsonl');
    expect(existsSync(rawEventsPath)).toBe(false);

    await engine.close();
    competingStore.close();
    store.close();
  });

  it('exclusive pre-capture claim: fenced touch rejects concurrent fence advancement before capture() runs', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-precapture-claim-'));
    const testConfig = config(stateDirectory);
    testConfig.security.allowed_roots = [stateDirectory];
    const store = new RunStore(stateDirectory);
    const engine = new LocalEngineer(testConfig, store, 'owner_test');

    let captureCallCount = 0;
    const manager = (engine as unknown as { containerManager: Record<string, unknown> }).containerManager;
    manager.probe = async () => ({ supported: true });
    manager.prepare = async () => ({ repositories: new Map() });
    manager.appServerWorker = () => ({});
    manager.cleanup = async () => undefined;
    manager.capture = async () => {
      captureCallCount++;
      return { revision: 1, patchDigest: 'digest', changedFiles: [], patch: '' };
    };

    let resolveWait!: (outcome: unknown) => void;
    const waitDeferred = new Promise<unknown>((resolve) => {
      resolveWait = resolve;
    });

    const mockAdapter = {
      createAndStart: async () => ({ threadId: 'th_1', turnId: 'turn_1' }),
      wait: () => waitDeferred,
      stop: async () => undefined,
      interrupt: async () => undefined,
    };
    (engine as unknown as { adapter: () => Promise<unknown> }).adapter = async () => mockAdapter;

    const r = run('run_precapture', 'queued', 0);
    r.ownerId = 'owner_test';
    store.add(r, 30_000);

    // Intercept store.update: when the fenced 'run.capturing' event fires,
    // advance the stored fenceToken before the actual update so the fence check
    // sees a mismatch and throws FENCE_REJECTED — simulating a concurrent cancel
    // that happened between postOutcome = store.get() and the fenced update.
    const origUpdate = store.update.bind(store);
    store.update = (id: string, patch: Partial<unknown>, event: string, fence?: unknown) => {
      if (event === 'run.capturing') {
        // Inject a concurrent fence advancement (different owner bumps the token).
        // Use the raw DB update path to skip the fence guard on this injection.
        origUpdate(id, { fenceToken: 99 }, 'run.fence_injected');
      }
      return origUpdate(id, patch as never, event, fence as never);
    };

    // Start execute in background; it will block on waitDeferred
    const execPromise = (engine as unknown as { execute: (id: string, t: number) => Promise<void> }).execute(
      'run_precapture',
      30,
    );

    // Wait until the run reaches 'running'
    await new Promise<void>((resolve) => {
      const check = () => {
        if (store.get('run_precapture')?.status === 'running') return resolve();
        setTimeout(check, 10);
      };
      check();
    });

    // Resolve waitForOutcome — execute() proceeds to the pre-capture fenced touch
    resolveWait({
      final_message: JSON.stringify({ summary: 'done', verification: [], files_changed: [], unresolved_risks: [] }),
    });

    await execPromise;

    store.update = origUpdate;

    // capture() must NOT have been called: the fenced touch threw FENCE_REJECTED
    // before capture() could run.
    expect(captureCallCount).toBe(0);
    // The run must not be in ready_for_review (settled to failed by error handler)
    const finalRun = store.get('run_precapture');
    expect(finalRun?.status).not.toBe('ready_for_review');

    engine.close();
    store.close();
  });
});

function run(runId: string, status: Run['status'], continuationIndex: number, leaseExpiresAt?: string): Run {
  return {
    runId,
    agentId: 'agt_lifecycle',
    ownerId: 'owner_test',
    title: runId,
    task: 'Lifecycle test',
    workingDirectory: 'C:/work/example',
    worker: 'local-container',
    status,
    continuationIndex,
    continuationOfRunId: continuationIndex ? 'run_review' : undefined,
    createdAt: `2026-07-24T00:00:0${continuationIndex}.000Z`,
    leaseExpiresAt,
    diagnostics: {
      last_phase: status,
      last_activity_at: `2026-07-24T00:00:0${continuationIndex}.000Z`,
    },
    requiresUserAction: false,
  };
}

function config(stateDirectory: string): Config {
  return {
    version: 1,
    default_worker: 'local-container',
    server: {
      state_dir: stateDirectory,
      max_concurrency: 1,
      default_timeout_seconds: 300,
      max_timeout_seconds: 3600,
      default_wait_timeout_seconds: 300,
      max_wait_timeout_seconds: 300,
      wait_response_reserve_seconds: 2,
      max_wait_ids: 10,
      cancellation_grace_seconds: 1,
      final_result_max_characters_per_run: 6000,
      max_server_log_bytes: 1024,
    },
    security: {
      allowed_roots: ['C:/work'],
      deny_unc_paths: true,
      deny_path_traversal: true,
      deny_symlink_escape: true,
      allowed_environment_variables: [],
    },
    container: {
      command: 'docker',
      platform: 'linux',
      image: 'local-engineer/worker:test',
      base_image: 'node:24-bookworm-slim',
      codex_version: '0.144.6',
      workspace_path: '/workspace',
      worker_user: 'codex',
      codex_command: 'codex',
      network: {
        model_domains: ['model-provider.example'],
        read_only_domains: [],
        allow_private_model_endpoint: false,
      },
    },
    workers: [
      {
        name: 'local-container',
        enabled: true,
        harness: 'codex',
        model: 'local-model',
        max_concurrency: 1,
        timeout_seconds: 300,
        idle_timeout_seconds: 60,
        environment: {},
        environment_from_host: [],
        container_model_provider: {
          base_url: 'https://model-provider.example/v1',
          wire_api: 'responses',
          requires_openai_auth: false,
        },
      },
    ],
  };
}

function testTemporaryDirectory(): string {
  const path = join(process.cwd(), '.tmp', 'tests');
  mkdirSync(path, { recursive: true });
  return path;
}

describe('completed assistant message extraction', () => {
  it('captures only completed agentMessage items with stable ids', () => {
    expect(
      completedAgentMessage({
        method: 'item/completed',
        params: { item: { type: 'agentMessage', id: 'item_9', text: 'finished' } },
      }),
    ).toEqual({ itemId: 'item_9', text: 'finished' });
    expect(
      completedAgentMessage({
        method: 'item/completed',
        params: { item: { type: 'commandExecution', id: 'cmd_1', text: 'ls -la' } },
      }),
    ).toBeUndefined();
    expect(completedAgentMessage({ method: 'item/agentMessage/delta', params: { delta: 'z' } })).toBeUndefined();
    expect(
      completedAgentMessage({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'x' } } }),
    ).toBeUndefined();
    expect(completedAgentMessage({})).toBeUndefined();
  });
});

describe('masked patch exit-code detection', () => {
  it('preserves a failed apply_patch status hidden by a trailing echo', () => {
    expect(
      maskedPatchExitCode(
        { command: 'apply_patch <<\'PATCH\'\n...\nPATCH\necho "e:$?"' },
        'apply_patch: patch context did not match src/example.ts\ne:128',
      ),
    ).toBe(128);
  });

  it('does not reinterpret unrelated command output', () => {
    expect(maskedPatchExitCode({ command: 'echo "e:128"' }, 'e:128')).toBeUndefined();
  });
});

describe('failed Codex turn classification', () => {
  it('uses bounded public classifications without exposing raw upstream details', () => {
    expect(codexTurnFailure(new Error('CODEX_TURN_FAILED:model relay error: model upstream timeout'))).toEqual({
      errorCode: 'MODEL_UPSTREAM_TIMEOUT',
      exitReason: 'The local model endpoint did not respond before the worker relay timed out.',
    });
    expect(codexTurnFailure(new Error('CODEX_TURN_FAILED:connect EHOSTUNREACH 192.168.90.174:8888'))).toEqual({
      errorCode: 'MODEL_UPSTREAM_UNREACHABLE',
      exitReason: 'The local model endpoint was unreachable from the worker relay.',
    });
    expect(codexTurnFailure(new Error('other failure'))).toBeUndefined();
  });
});

describe('isMissingRecoveredThread', () => {
  it('matches all supported thread-lost error conditions', () => {
    expect(isMissingRecoveredThread(new Error('CODEX_RPC_ERROR:thread not found: th_1'))).toBe(true);
    expect(isMissingRecoveredThread(new Error('thread not found'))).toBe(true);
    expect(isMissingRecoveredThread(new Error('unknown thread: th_2'))).toBe(true);
    expect(isMissingRecoveredThread(new Error('invalid thread id'))).toBe(true);
    expect(isMissingRecoveredThread(new Error('CODEX_APP_SERVER_EXIT:0'))).toBe(true);
    expect(isMissingRecoveredThread(new Error('CODEX_APP_SERVER_STOPPED'))).toBe(true);
    expect(isMissingRecoveredThread(new Error('CODEX_APP_SERVER_ERROR: spawn error'))).toBe(true);
    expect(isMissingRecoveredThread(new Error('CODEX_RPC_TIMEOUT:turn/start'))).toBe(true);
    expect(isMissingRecoveredThread(new Error('CODEX_RPC_TIMEOUT:thread/resume'))).toBe(true);

    expect(isMissingRecoveredThread(new Error('CODEX_RPC_TIMEOUT:config/get'))).toBe(false);
    expect(isMissingRecoveredThread(new Error('something else'))).toBe(false);
    expect(isMissingRecoveredThread(null)).toBe(false);
    expect(isMissingRecoveredThread(undefined)).toBe(false);
  });
});

describe('steering fenced delivery and failure semantics', () => {
  it('reports failed delivery when accepted guidance is closed before the dispatch path starts', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-steer-undelivered-'));
    const store = new RunStore(stateDirectory);
    const engine = new LocalEngineer(config(stateDirectory), store, 'owner_test', undefined, 30_000, 0);
    store.add({ ...run('run_steer_undelivered', 'running', 0), workerThreadId: 'thread_test' });
    const enqueue = store.enqueueSteer.bind(store);
    vi.spyOn(store, 'enqueueSteer').mockImplementation((runId, message, fence) => {
      const accepted = enqueue(runId, message, fence);
      store.setStatus(runId, 'ready_for_review');
      return accepted;
    });
    try {
      await expect(engine.steer('run_steer_undelivered', 'Correction')).rejects.toThrow(
        'STEER_RPC_FAILED: run_ready_for_review_before_dispatch',
      );
      expect(store.get('run_steer_undelivered')?.steeringMessages?.[0]?.status).toBe('failed');
    } finally {
      store.close();
    }
  });

  it('rejects guidance rather than silently queueing when the run finishes just before enqueue', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-steer-settle-race-'));
    const store = new RunStore(stateDirectory);
    const engine = new LocalEngineer(config(stateDirectory), store, 'owner_test', undefined, 30_000, 0);
    store.add({ ...run('run_steer_settle_race', 'running', 0), workerThreadId: 'thread_test' });
    const enqueue = store.enqueueSteer.bind(store);
    vi.spyOn(store, 'enqueueSteer').mockImplementation((runId, message, fence) => {
      store.setStatus(runId, 'ready_for_review');
      return enqueue(runId, message, fence);
    });
    try {
      await expect(engine.steer('run_steer_settle_race', 'Late correction')).rejects.toThrow('STEER_RUN_NOT_ACTIVE');
      expect(store.get('run_steer_settle_race')?.steeringQueue).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('marks steering uncertain when a run completes before its in-flight RPC returns, without logging delivery', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-steer-complete-'));
    const store = new RunStore(stateDirectory);
    const engine = new LocalEngineer(config(stateDirectory), store, 'owner_test', undefined, 30_000, 0);
    const current = {
      ...run('run_steer_complete', 'running', 0),
      workerThreadId: 'thread_test',
      workerTurnId: 'turn_test',
    };
    store.add(current);
    const adapter = {
      steer: vi.fn().mockImplementation(async () => {
        store.setStatus(current.runId, 'ready_for_review');
      }),
    };
    (engine as unknown as { adapters: Map<string, unknown> }).adapters.set(current.agentId, adapter);
    try {
      await engine.steer(current.runId, 'Possibly delivered correction');
      expect(adapter.steer).toHaveBeenCalledTimes(1);
      const settled = store.get(current.runId)!;
      expect(settled.status).toBe('ready_for_review');
      expect(settled.steeringMessages?.[0]?.status).toBe('uncertain');
      expect(settled.pendingSteer).toBeUndefined();
      const rawPath = join(stateDirectory, 'runs', current.runId, 'harness', 'raw-events.jsonl');
      expect(existsSync(rawPath)).toBe(false);
    } finally {
      store.close();
    }
  });

  it('enforces MutationFence on enqueueSteer and dequeueSteer', () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-fence-'));
    const store = new RunStore(stateDirectory);
    const runId = 'run_fence_1';
    store.add({
      runId,
      agentId: 'agt_fence_1',
      ownerId: 'owner_a',
      fenceToken: 5,
      title: 'Fence Test',
      task: 'Task',
      workingDirectory: 'C:/work/example',
      worker: 'local-container',
      status: 'running',
      continuationIndex: 0,
      createdAt: '2026-07-22T00:00:00.000Z',
      requiresUserAction: false,
    });

    const steerMsg = {
      id: 'steer_1',
      message: 'test direction',
      status: 'pending' as const,
      queuedAt: new Date().toISOString(),
    };

    // Mismatched owner fails
    expect(() => store.enqueueSteer(runId, steerMsg, { ownerId: 'owner_wrong', expectedFenceToken: 5 })).toThrow(
      'MUTATION_FENCE_OWNER_MISMATCH',
    );

    // Stale fence token fails
    expect(() => store.enqueueSteer(runId, steerMsg, { ownerId: 'owner_a', expectedFenceToken: 4 })).toThrow(
      'MUTATION_FENCE_TOKEN_MISMATCH',
    );

    // Correct fence succeeds and preserves fenceToken while advancing steeringVersion
    const enqueued = store.enqueueSteer(runId, steerMsg, { ownerId: 'owner_a', expectedFenceToken: 5 });
    expect(enqueued.fenceToken).toBe(5);
    expect(enqueued.steeringVersion).toBe(1);
    expect(enqueued.steeringQueue).toHaveLength(1);

    // Claim steer before dequeue
    const claim = store.claimNextSteer(runId, { ownerId: 'owner_a', expectedFenceToken: 5 });
    expect(claim?.message.id).toBe('steer_1');
    expect(claim?.fenceToken).toBe(5);

    // Dequeue with stale token fails
    expect(() =>
      store.dequeueSteer(runId, 'steer_1', 'delivered', undefined, { ownerId: 'owner_a', expectedFenceToken: 4 }),
    ).toThrow('MUTATION_FENCE_TOKEN_MISMATCH');

    // Dequeue with correct token succeeds
    const dequeued = store.dequeueSteer(runId, 'steer_1', 'delivered', undefined, {
      ownerId: 'owner_a',
      expectedFenceToken: 5,
    });
    expect(dequeued.fenceToken).toBe(5);
    expect(dequeued.steeringVersion).toBe(3);
    expect(dequeued.steeringMessages).toHaveLength(1);
    expect(dequeued.steeringMessages?.[0]?.status).toBe('delivered');
  });

  it('fails closed and records failed status on adapter RPC failure without replaying', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-rpc-fail-'));
    const store = new RunStore(stateDirectory);
    const cfg = config(stateDirectory);
    cfg.security.allowed_roots = [stateDirectory];
    const engine = new LocalEngineer(cfg, store, 'owner_test');

    const runId = 'run_rpc_fail_1';
    const agentId = 'agt_rpc_fail_1';
    store.add({
      runId,
      agentId,
      ownerId: 'owner_test',
      fenceToken: 1,
      title: 'RPC Fail Test',
      task: 'Task',
      workingDirectory: stateDirectory,
      worker: 'local-container',
      status: 'running',
      workerThreadId: 'thread_1',
      workerTurnId: 'turn_1',
      continuationIndex: 0,
      createdAt: '2026-07-22T00:00:00.000Z',
      requiresUserAction: false,
    });

    const mockAdapter = {
      steer: vi.fn().mockRejectedValue(new Error('adapter connection reset')),
    };
    (engine as unknown as { adapters: Map<string, unknown> }).adapters.set(agentId, mockAdapter);

    await expect(engine.steer(runId, 'redirect agent')).rejects.toThrow('STEER_RPC_FAILED: adapter connection reset');

    const updated = store.get(runId);
    expect(updated?.steeringMessages).toHaveLength(1);
    expect(updated?.steeringMessages?.[0]?.status).toBe('failed');
    expect(updated?.steeringMessages?.[0]?.error).toContain('adapter connection reset');
    expect(updated?.pendingSteer).toBeUndefined();
  });

  it('rejects steering when run is in recovery_required state', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-rec-steer-'));
    const store = new RunStore(stateDirectory);
    const cfg = config(stateDirectory);
    cfg.security.allowed_roots = [stateDirectory];
    const engine = new LocalEngineer(cfg, store, 'owner_test');

    const runId = 'run_rec_1';
    store.add({
      runId,
      agentId: 'agt_rec_1',
      ownerId: 'owner_test',
      fenceToken: 1,
      title: 'Recovery Test',
      task: 'Task',
      workingDirectory: stateDirectory,
      worker: 'local-container',
      status: 'recovery_required',
      continuationIndex: 0,
      createdAt: '2026-07-22T00:00:00.000Z',
      requiresUserAction: true,
    });

    await expect(engine.steer(runId, 'hello')).rejects.toThrow('RUN_RECOVERY_REQUIRED');
  });

  it('drops stale dispatch and raw logging when fence advances while adapter RPC is in flight', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-rpc-fence-'));
    const store = new RunStore(stateDirectory);
    const cfg = config(stateDirectory);
    cfg.security.allowed_roots = [stateDirectory];
    const engine = new LocalEngineer(cfg, store, 'owner_test');

    const runId = 'run_fence_adv_1';
    const agentId = 'agt_fence_adv_1';
    store.add({
      runId,
      agentId,
      ownerId: 'owner_test',
      fenceToken: 1,
      title: 'Fence Advance In Flight',
      task: 'Task',
      workingDirectory: stateDirectory,
      worker: 'local-container',
      status: 'running',
      workerThreadId: 'thread_1',
      workerTurnId: 'turn_1',
      continuationIndex: 0,
      createdAt: '2026-07-22T00:00:00.000Z',
      requiresUserAction: false,
    });

    let resolveRpc!: () => void;
    const rpcPromise = new Promise<void>((r) => {
      resolveRpc = r;
    });
    const mockAdapter = {
      steer: vi.fn().mockImplementation(async () => {
        await rpcPromise;
      }),
    };
    (engine as unknown as { adapters: Map<string, unknown> }).adapters.set(agentId, mockAdapter);

    const steerPromise = engine.steer(runId, 'deferred msg');
    await new Promise((r) => setTimeout(r, 25));

    // Advance fence token from 1 to 2 while RPC is in flight
    store.update(runId, { fenceToken: 2 }, 'test.bump_fence', {
      ownerId: 'owner_test',
      expectedFenceToken: 1,
    });

    resolveRpc();
    await steerPromise;

    const after = store.get(runId);
    expect(after?.fenceToken).toBe(2);
    // The steer message was claimed at fence 1 so finalizing at fence 1 was rejected.
    // It must NOT be marked delivered under the new fence token.
    expect(after?.steeringMessages?.find((m) => m.status === 'delivered')).toBeUndefined();
    // Raw events must not contain the item/started log
    const rawPath = join(stateDirectory, 'runs', runId, 'harness', 'raw-events.jsonl');
    if (existsSync(rawPath)) {
      expect(readFileSync(rawPath, 'utf8')).not.toContain('deferred msg');
    }
  });

  it('stops without mutating or raw logging when owner changes while adapter RPC is in flight', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-rpc-owner-'));
    const store = new RunStore(stateDirectory);
    const cfg = config(stateDirectory);
    cfg.security.allowed_roots = [stateDirectory];
    const engine = new LocalEngineer(cfg, store, 'owner_test');

    const runId = 'run_owner_chg_1';
    const agentId = 'agt_owner_chg_1';
    store.add({
      runId,
      agentId,
      ownerId: 'owner_test',
      fenceToken: 1,
      title: 'Owner Change In Flight',
      task: 'Task',
      workingDirectory: stateDirectory,
      worker: 'local-container',
      status: 'running',
      workerThreadId: 'thread_1',
      workerTurnId: 'turn_1',
      continuationIndex: 0,
      createdAt: '2026-07-22T00:00:00.000Z',
      requiresUserAction: false,
    });

    let resolveRpc!: () => void;
    const rpcPromise = new Promise<void>((r) => {
      resolveRpc = r;
    });
    const mockAdapter = {
      steer: vi.fn().mockImplementation(async () => {
        await rpcPromise;
      }),
    };
    (engine as unknown as { adapters: Map<string, unknown> }).adapters.set(agentId, mockAdapter);

    const steerPromise = engine.steer(runId, 'msg for old owner');
    await new Promise((r) => setTimeout(r, 25));

    // Another process adopts the run
    store.update(runId, { ownerId: 'owner_new', fenceToken: 2 }, 'test.adopt', {
      expectedFenceToken: 1,
    });

    resolveRpc();
    await steerPromise;

    const after = store.get(runId);
    expect(after?.ownerId).toBe('owner_new');
    expect(after?.fenceToken).toBe(2);
    expect(after?.steeringMessages?.find((m) => m.status === 'delivered')).toBeUndefined();
    const rawPath = join(stateDirectory, 'runs', runId, 'harness', 'raw-events.jsonl');
    if (existsSync(rawPath)) {
      expect(readFileSync(rawPath, 'utf8')).not.toContain('msg for old owner');
    }
  });

  it('preserves cancelled status and does not allow stale completion when cancelled while RPC in flight', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-rpc-cancel-'));
    const store = new RunStore(stateDirectory);
    const cfg = config(stateDirectory);
    cfg.security.allowed_roots = [stateDirectory];
    const engine = new LocalEngineer(cfg, store, 'owner_test');

    const runId = 'run_cancel_inflight_1';
    const agentId = 'agt_cancel_inflight_1';
    store.add({
      runId,
      agentId,
      ownerId: 'owner_test',
      fenceToken: 1,
      title: 'Cancel In Flight',
      task: 'Task',
      workingDirectory: stateDirectory,
      worker: 'local-container',
      status: 'running',
      workerThreadId: 'thread_1',
      workerTurnId: 'turn_1',
      continuationIndex: 0,
      createdAt: '2026-07-22T00:00:00.000Z',
      requiresUserAction: false,
    });

    let resolveRpc!: () => void;
    const rpcPromise = new Promise<void>((r) => {
      resolveRpc = r;
    });
    const mockAdapter = {
      steer: vi.fn().mockImplementation(async () => {
        await rpcPromise;
      }),
      interrupt: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    (engine as unknown as { adapters: Map<string, unknown> }).adapters.set(agentId, mockAdapter);

    const steerPromise = engine.steer(runId, 'msg to be cancelled');
    await new Promise((r) => setTimeout(r, 25));

    // Cancel the run while steer RPC is in flight
    await engine.cancel(runId);

    resolveRpc();
    await steerPromise;

    const after = store.get(runId);
    expect(after?.status).toBe('cancelled');
    // The steer item must be marked uncertain, never delivered
    expect(after?.steeringMessages?.find((m) => m.status === 'delivered')).toBeUndefined();
    const steerMsg = after?.steeringMessages?.find((m) => m.message === 'msg to be cancelled');
    expect(steerMsg?.status).toBe('uncertain');
    const rawPath = join(stateDirectory, 'runs', runId, 'harness', 'raw-events.jsonl');
    if (existsSync(rawPath)) {
      expect(readFileSync(rawPath, 'utf8')).not.toContain('msg to be cancelled');
    }
  });

  it('does not automatically second-send on bookkeeping failure after successful RPC', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-rpc-bk-fail-'));
    const store = new RunStore(stateDirectory);
    const cfg = config(stateDirectory);
    cfg.security.allowed_roots = [stateDirectory];
    const engine = new LocalEngineer(cfg, store, 'owner_test');

    const runId = 'run_bk_fail_1';
    const agentId = 'agt_bk_fail_1';
    store.add({
      runId,
      agentId,
      ownerId: 'owner_test',
      fenceToken: 1,
      title: 'Bookkeeping Fail Test',
      task: 'Task',
      workingDirectory: stateDirectory,
      worker: 'local-container',
      status: 'running',
      workerThreadId: 'thread_1',
      workerTurnId: 'turn_1',
      continuationIndex: 0,
      createdAt: '2026-07-22T00:00:00.000Z',
      requiresUserAction: false,
    });

    const mockAdapter = {
      steer: vi.fn().mockResolvedValue(undefined),
    };
    (engine as unknown as { adapters: Map<string, unknown> }).adapters.set(agentId, mockAdapter);

    // Spy on finalizeSteerDispatch to throw
    const originalFinalize = store.finalizeSteerDispatch.bind(store);
    vi.spyOn(store, 'finalizeSteerDispatch').mockImplementation(() => {
      throw new Error('DISK_IO_ERROR_DURING_FINALIZATION');
    });

    // Steer call must catch the error in dispatch and not replay
    await engine.steer(runId, 'msg single dispatch');

    expect(mockAdapter.steer).toHaveBeenCalledTimes(1);

    // Restore spy
    vi.spyOn(store, 'finalizeSteerDispatch').mockImplementation(originalFinalize);
  });

  it('preserves strict FIFO ordering across multiple queued steering messages', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-fifo-steer-'));
    const store = new RunStore(stateDirectory);
    const cfg = config(stateDirectory);
    cfg.security.allowed_roots = [stateDirectory];
    const engine = new LocalEngineer(cfg, store, 'owner_test');

    const runId = 'run_fifo_1';
    const agentId = 'agt_fifo_1';
    store.add({
      runId,
      agentId,
      ownerId: 'owner_test',
      fenceToken: 1,
      title: 'FIFO Steer Test',
      task: 'Task',
      workingDirectory: stateDirectory,
      worker: 'local-container',
      status: 'running',
      workerThreadId: 'thread_1',
      workerTurnId: 'turn_1',
      continuationIndex: 0,
      createdAt: '2026-07-22T00:00:00.000Z',
      requiresUserAction: false,
    });

    const received: string[] = [];
    const mockAdapter = {
      steer: vi.fn().mockImplementation(async (_th: string, _tu: string, msg: string) => {
        received.push(msg);
      }),
    };
    (engine as unknown as { adapters: Map<string, unknown> }).adapters.set(agentId, mockAdapter);

    // Steer two messages in sequence
    await engine.steer(runId, 'first message');
    await engine.steer(runId, 'second message');

    expect(received).toEqual(['first message', 'second message']);

    const finalRun = store.get(runId);
    expect(finalRun?.steeringMessages).toHaveLength(2);
    expect(finalRun?.steeringMessages?.[0]?.message).toBe('first message');
    expect(finalRun?.steeringMessages?.[0]?.status).toBe('delivered');
    expect(finalRun?.pendingSteer).toBeUndefined();
    expect(finalRun?.steeringQueue?.filter((m) => m.status === 'pending')).toHaveLength(0);
  });

  it('does not advance fence token when enqueueing steer during starting status', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-start-steer-'));
    const store = new RunStore(stateDirectory);
    const cfg = config(stateDirectory);
    cfg.security.allowed_roots = [stateDirectory];
    const engine = new LocalEngineer(cfg, store, 'owner_test');

    const runId = 'run_start_steer_1';
    const agentId = 'agt_start_steer_1';
    store.add({
      runId,
      agentId,
      ownerId: 'owner_test',
      fenceToken: 3,
      title: 'Starting Steer Test',
      task: 'Task',
      workingDirectory: stateDirectory,
      worker: 'local-container',
      status: 'starting',
      continuationIndex: 0,
      createdAt: '2026-07-22T00:00:00.000Z',
      requiresUserAction: false,
    });

    await engine.steer(runId, 'message enqueued during startup');

    const updated = store.get(runId);
    expect(updated?.status).toBe('starting');
    expect(updated?.fenceToken).toBe(3);
    expect(updated?.steeringVersion).toBe(1);
    expect(updated?.steeringQueue).toHaveLength(1);
    expect(updated?.steeringQueue?.[0]?.message).toBe('message enqueued during startup');
    expect(updated?.steeringQueue?.[0]?.status).toBe('pending');
  });

  it('preserves live command activity and counters updated while steer RPC is in flight', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-rpc-diag-'));
    const store = new RunStore(stateDirectory);
    const cfg = config(stateDirectory);
    cfg.security.allowed_roots = [stateDirectory];
    const engine = new LocalEngineer(cfg, store, 'owner_test');

    const runId = 'run_diag_inflight_1';
    const agentId = 'agt_diag_inflight_1';
    store.add({
      runId,
      agentId,
      ownerId: 'owner_test',
      fenceToken: 1,
      title: 'Diagnostics In Flight',
      task: 'Task',
      workingDirectory: stateDirectory,
      worker: 'local-container',
      status: 'running',
      workerThreadId: 'thread_1',
      workerTurnId: 'turn_1',
      continuationIndex: 0,
      createdAt: '2026-07-22T00:00:00.000Z',
      requiresUserAction: false,
      diagnostics: {
        last_phase: 'running',
        last_activity_at: '2026-07-22T00:00:00.000Z',
        commands_active_count: 1,
        commands_completed_count: 0,
      },
    });

    let resolveRpc!: () => void;
    const rpcPromise = new Promise<void>((r) => {
      resolveRpc = r;
    });
    const mockAdapter = {
      steer: vi.fn().mockImplementation(async () => {
        await rpcPromise;
      }),
    };
    (engine as unknown as { adapters: Map<string, unknown> }).adapters.set(agentId, mockAdapter);

    const steerPromise = engine.steer(runId, 'steer with concurrent worker progress');
    await new Promise((r) => setTimeout(r, 25));

    // While RPC is in flight, worker completes a command and updates diagnostics in the store
    const currentRun = store.get(runId)!;
    store.update(
      runId,
      {
        diagnostics: {
          ...currentRun.diagnostics,
          commands_active_count: 0,
          commands_completed_count: 42,
          last_tool: 'bash',
        },
      },
      'worker.command_completed',
      { ownerId: 'owner_test', expectedFenceToken: 1 },
    );

    resolveRpc();
    await steerPromise;

    const after = store.get(runId);
    expect(after?.status).toBe('running');
    expect(after?.fenceToken).toBe(1);
    expect(after?.diagnostics?.last_phase).toBe('steered');
    expect(after?.diagnostics?.commands_completed_count).toBe(42);
    expect(after?.diagnostics?.commands_active_count).toBe(0);
    expect(after?.diagnostics?.last_tool).toBe('bash');
  });
});
