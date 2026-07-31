import { describe, expect, it } from 'vitest';
import { transition, type Run } from '../src/domain.js';
import { buildPrompt } from '../src/prompt.js';
import { eventMatchesRun, normalize, safe, waitDurationSeconds } from '../src/service.js';

describe('container lifecycle', () => {
  it('allows normal start and review transitions', () => {
    expect(() => transition('queued', 'starting')).not.toThrow();
    expect(() => transition('running', 'ready_for_review')).not.toThrow();
    expect(() => transition('ready_for_review', 'superseded')).not.toThrow();
  });

  it('rejects terminal reactivation', () => {
    expect(() => transition('promoted', 'running')).toThrow('INVALID_STATE_TRANSITION');
  });
});

describe('worker prompt', () => {
  it('keeps constraints and requires a JSON final report', () => {
    const prompt = buildPrompt('Review parser', 'run_1', 'Fix the parser.', {
      constraints: ['Do not change public APIs.'],
    });
    expect(prompt).toContain('Do not change public APIs.');
    expect(prompt).toContain('Return exactly one JSON object and nothing else');
    expect(prompt).toContain('If work is blocked before editing or verification, still return this JSON schema');
  });

  it('prohibits whole-file shell replacement', () => {
    const prompt = buildPrompt('Review parser', 'run_1', 'Fix the parser.', undefined, 'Be concise.');
    expect(prompt).toContain('NEVER create or replace a complete source or document file through shell execution');
  });

  it('keeps temporary dependency installations outside the repository', () => {
    const prompt = buildPrompt('Dependency test', 'run_2', 'Run a targeted check.');
    expect(prompt).toContain('Use the LOCAL_ENGINEER_DEPENDENCY_ROOT environment variable');
    expect(prompt).toContain('do not create .local-pkgs');
  });
});

describe('result normalization', () => {
  it('returns a structured report for valid JSON', () => {
    const result = normalize(
      {
        final_message: JSON.stringify({
          summary: 'Fixed parser.',
          files_changed: ['src/parser.ts'],
          verification: [{ name: 'pnpm test', status: 'passed' }],
          unresolved_risks: [],
          requires_user_action: false,
        }),
      },
      6000,
    );
    expect(result).toMatchObject({
      reportStatus: 'valid',
      summary: 'Fixed parser.',
      filesChanged: ['src/parser.ts'],
    });
  });

  it('labels missing and invalid reports', () => {
    expect(normalize({}, 6000).reportStatus).toBe('missing');
    expect(normalize({ final_message: 'not json' }, 6000).reportStatus).toBe('invalid');
  });

  it('extracts a final fenced JSON report', () => {
    const result = normalize(
      {
        final_message:
          'Done.\n```json\n{"summary":"Reviewed","files_changed":[],"verification":[],"unresolved_risks":[],"requires_user_action":false}\n```',
      },
      6000,
    );
    expect(result).toMatchObject({ reportStatus: 'valid', summary: 'Reviewed' });
  });
});

describe('bounded projections', () => {
  const run: Run = {
    runId: 'run_test',
    agentId: 'agt_test',
    ownerId: 'owner_test',
    title: 'Container task',
    task: 'Do work.',
    workingDirectory: 'C:\\work\\project',
    containerWorkingDirectory: '/workspace/primary',
    worker: 'local-container',
    status: 'running',
    continuationIndex: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    workerThreadId: 'thread-private',
    workerTurnId: 'turn-private',
    requiresUserAction: false,
  };

  it('does not expose private thread identifiers', () => {
    expect(safe(run)).toEqual({
      schema_version: 1,
      run_id: 'run_test',
      agent_id: 'agt_test',
      status: 'running',
      title: 'Container task',
      worker: 'local-container',
      continuation_index: 0,
      requires_user_action: false,
    });
  });

  it('projects local token activity as offloaded work, not unmeasured savings', () => {
    const projected = safe({
      ...run,
      stats: {
        worker_tokens: {
          total: 30000,
          input: 24000,
          cached_input: 12000,
          output: 5000,
          reasoning_output: 1000,
          source: 'app_server',
        },
        parent_to_worker: {
          characters: 120,
          estimated_tokens: 30,
          title_characters: 10,
          task_characters: 90,
          grounding_characters: 20,
          task_assignments: 1,
          follow_up_messages: 0,
        },
        parent_visible: {
          characters: 800,
          estimated_tokens: 200,
          changes_characters: 100,
          diff_characters: 600,
          file_characters: 100,
          lifecycle_characters: 0,
        },
        review_requests: { changes: 1, diffs: 1, files: 0 },
      },
    });

    expect(projected.delegation_impact).toMatchObject({
      local_worker_tokens: { total: 30000, output: 5000 },
      parent_to_worker_payload: {
        characters: 120,
        estimated_tokens: 30,
        task_assignments: 1,
      },
      parent_visible_review_tokens_estimate: 200,
      savings_status: 'unmeasured',
    });
    expect(projected.delegation_impact?.human_summary).toContain('30,000 tokens locally');
    expect(projected.delegation_impact?.human_summary).toContain('about 30 tokens');
    expect(projected.delegation_impact?.human_summary).toContain('not a measured parent-token saving');
  });

  it('matches events only to the exact private turn', () => {
    expect(
      eventMatchesRun(run, 'local-container', {
        method: 'item/completed',
        params: { threadId: 'thread-private', turnId: 'turn-private' },
      }),
    ).toBe(true);
    expect(
      eventMatchesRun(run, 'local-container', {
        method: 'item/completed',
        params: { threadId: 'thread-private', turnId: 'other-turn' },
      }),
    ).toBe(false);
  });

  it('returns before the client timeout reserve', () => {
    expect(waitDurationSeconds(300, 900, 10)).toBe(290);
    expect(waitDurationSeconds(5, 900, 10)).toBe(1);
  });
});
