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
    expect(summary.parent_visible_mcp.estimated_tokens).toBe(100);
    expect(summary.measured_savings).toMatchObject({ saved_parent_tokens: 3000, savings_percent: 60 });
  });

  it('parses bounded relative and absolute since values', () => {
    expect(parseSince('2h', 10_000_000)).toBe(2_800_000);
    expect(parseSince('2026-07-24T00:00:00Z')).toBe(Date.parse('2026-07-24T00:00:00Z'));
    expect(() => parseSince('later')).toThrow('CLI_STATS_SINCE_INVALID');
  });

  it('requires both sides of an A/B token comparison', () => {
    expect(() => summarizeStats([], { baselineParentTokens: 1000 })).toThrow('CLI_STATS_AB_REQUIRES_BOTH_TOKEN_COUNTS');
  });
});
