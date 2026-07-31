import { describe, expect, it } from 'vitest';
import type { Run } from '../src/domain.js';
import { parseSince, summarizeStats } from '../src/stats.js';

describe('statistics summary', () => {
  it('separates measured worker usage, estimated MCP delivery, and supplied A/B savings', () => {
    const summary = summarizeStats(
      [
        {
          runId: 'run_1',
          agentId: 'agt_1',
          ownerId: 'owner',
          title: 'Example',
          task: 'Example',
          workingDirectory: 'C:/work/example',
          worker: 'local',
          status: 'promoted',
          continuationIndex: 0,
          createdAt: '2026-07-24T00:00:00.000Z',
          requiresUserAction: false,
          stats: {
            worker_tokens: {
              total: 1000,
              input: 800,
              cached_input: 600,
              output: 200,
              reasoning_output: 0,
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
              characters: 400,
              estimated_tokens: 100,
              changes_characters: 40,
              diff_characters: 300,
              file_characters: 60,
              lifecycle_characters: 0,
            },
            review_requests: { changes: 1, diffs: 1, files: 1 },
          },
        } satisfies Run,
      ],
      { baselineParentTokens: 5000, delegatedParentTokens: 2000 },
    );

    expect(summary.worker_tokens.total).toBe(1000);
    expect(summary.parent_to_worker_payload).toMatchObject({
      characters: 120,
      estimated_tokens: 30,
      task_assignments: 1,
      follow_up_messages: 0,
      token_estimate_method: 'characters_divided_by_4_per_assignment_or_follow_up',
    });
    expect(summary.parent_visible_mcp.estimated_tokens).toBe(100);
    expect(summary.measured_savings).toMatchObject({ saved_parent_tokens: 3000, savings_percent: 60 });
  });

  it('parses bounded relative and absolute since values', () => {
    expect(parseSince('2h', 10_000_000)).toBe(2_800_000);
    expect(parseSince('2026-07-24T00:00:00Z')).toBe(Date.parse('2026-07-24T00:00:00Z'));
    expect(() => parseSince('later')).toThrow('CLI_STATS_SINCE_INVALID');
  });

  it('derives parent-to-worker payload totals from retained historical run fields', () => {
    const summary = summarizeStats([
      {
        runId: 'run_historical',
        agentId: 'agt_historical',
        ownerId: 'owner',
        title: 'Review',
        task: 'Inspect this change.',
        grounding: { constraints: ['Do not edit.'] },
        workingDirectory: 'C:/work/example',
        worker: 'local',
        status: 'promoted',
        continuationIndex: 0,
        createdAt: '2026-07-24T00:00:00.000Z',
        requiresUserAction: false,
      } satisfies Run,
    ]);

    expect(summary.parent_to_worker_payload).toMatchObject({
      characters: 'Review'.length + 'Inspect this change.'.length + 'Do not edit.'.length,
      task_assignments: 1,
      follow_up_messages: 0,
    });
  });

  it('requires both sides of an A/B token comparison', () => {
    expect(() => summarizeStats([], { baselineParentTokens: 1000 })).toThrow('CLI_STATS_AB_REQUIRES_BOTH_TOKEN_COUNTS');
  });
});
