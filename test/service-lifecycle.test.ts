import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Config, Run } from '../src/domain.js';
import { LocalEngineer, completedAgentMessage, safe } from '../src/service.js';
import { RunStore } from '../src/store.js';

describe('agent lifecycle history', () => {
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

  it('supersedes the prior review run when a continuation is queued', () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'service-reply-'));
    const store = new RunStore(stateDirectory);
    const engine = new LocalEngineer(config(stateDirectory), store, 'owner_test');
    const reviewed = {
      ...run('run_review', 'ready_for_review', 0),
      workerThreadId: 'thread_private',
    };
    store.add(reviewed);
    Object.defineProperty(engine, 'queue', { value: () => undefined });

    const continuation = engine.reply({
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
});

function run(runId: string, status: Run['status'], continuationIndex: number): Run {
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
