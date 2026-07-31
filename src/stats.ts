import { parentToWorkerPayload, type Run } from './domain.js';

export interface StatsOptions {
  since?: string;
  agentId?: string;
  runId?: string;
  baselineParentTokens?: number;
  delegatedParentTokens?: number;
}

export function summarizeStats(runs: Run[], options: StatsOptions = {}) {
  if ((options.baselineParentTokens === undefined) !== (options.delegatedParentTokens === undefined))
    throw new Error('CLI_STATS_AB_REQUIRES_BOTH_TOKEN_COUNTS');
  const since = options.since ? parseSince(options.since) : undefined;
  const selected = runs.filter(
    (run) =>
      (!since || Date.parse(run.createdAt) >= since) &&
      (!options.agentId || run.agentId === options.agentId) &&
      (!options.runId || run.runId === options.runId),
  );
  const worker = selected.reduce(
    (total, run) => ({
      total: total.total + (run.stats?.worker_tokens?.total ?? 0),
      input: total.input + (run.stats?.worker_tokens?.input ?? 0),
      cached_input: total.cached_input + (run.stats?.worker_tokens?.cached_input ?? 0),
      output: total.output + (run.stats?.worker_tokens?.output ?? 0),
      reasoning_output: total.reasoning_output + (run.stats?.worker_tokens?.reasoning_output ?? 0),
    }),
    { total: 0, input: 0, cached_input: 0, output: 0, reasoning_output: 0 },
  );
  const parent = selected.reduce(
    (total, run) => ({
      characters: total.characters + (run.stats?.parent_visible.characters ?? 0),
      estimated_tokens: total.estimated_tokens + (run.stats?.parent_visible.estimated_tokens ?? 0),
      changes_characters: total.changes_characters + (run.stats?.parent_visible.changes_characters ?? 0),
      diff_characters: total.diff_characters + (run.stats?.parent_visible.diff_characters ?? 0),
      file_characters: total.file_characters + (run.stats?.parent_visible.file_characters ?? 0),
      lifecycle_characters: total.lifecycle_characters + (run.stats?.parent_visible.lifecycle_characters ?? 0),
    }),
    {
      characters: 0,
      estimated_tokens: 0,
      changes_characters: 0,
      diff_characters: 0,
      file_characters: 0,
      lifecycle_characters: 0,
    },
  );
  const parentToWorker = selected.reduce(
    (total, run) => {
      const payload =
        run.stats?.parent_to_worker ??
        parentToWorkerPayload(run.title, run.task, run.grounding, run.continuationIndex ? 'follow_up' : 'assignment');
      return {
        characters: total.characters + payload.characters,
        estimated_tokens: total.estimated_tokens + payload.estimated_tokens,
        title_characters: total.title_characters + payload.title_characters,
        task_characters: total.task_characters + payload.task_characters,
        grounding_characters: total.grounding_characters + payload.grounding_characters,
        task_assignments: total.task_assignments + payload.task_assignments,
        follow_up_messages: total.follow_up_messages + payload.follow_up_messages,
      };
    },
    {
      characters: 0,
      estimated_tokens: 0,
      title_characters: 0,
      task_characters: 0,
      grounding_characters: 0,
      task_assignments: 0,
      follow_up_messages: 0,
    },
  );
  const baseline =
    options.baselineParentTokens !== undefined && options.delegatedParentTokens !== undefined
      ? {
          baseline_parent_tokens: options.baselineParentTokens,
          delegated_parent_tokens: options.delegatedParentTokens,
          saved_parent_tokens: options.baselineParentTokens - options.delegatedParentTokens,
          savings_percent:
            options.baselineParentTokens === 0
              ? null
              : Number(
                  (
                    ((options.baselineParentTokens - options.delegatedParentTokens) / options.baselineParentTokens) *
                    100
                  ).toFixed(2),
                ),
          source: 'user_supplied_ab_measurement' as const,
        }
      : null;
  return {
    schema_version: 1,
    filters: {
      ...(options.since ? { since: options.since } : {}),
      ...(options.agentId ? { agent_id: options.agentId } : {}),
      ...(options.runId ? { run_id: options.runId } : {}),
    },
    runs: {
      count: selected.length,
      promoted: selected.filter((run) => run.status === 'promoted').length,
      ready_for_review: selected.filter((run) => run.status === 'ready_for_review').length,
      failed: selected.filter((run) => ['failed', 'timed_out'].includes(run.status)).length,
    },
    worker_tokens: {
      ...worker,
      source: 'codex_app_server_events',
      exact_when_reported: true,
    },
    parent_visible_mcp: {
      ...parent,
      token_estimate_method: 'characters_divided_by_4_per_delivery',
      coverage: 'structured change, diff, and file review payloads recorded after this feature was installed',
    },
    parent_to_worker_payload: {
      ...parentToWorker,
      token_estimate_method: 'characters_divided_by_4_per_assignment_or_follow_up',
      coverage:
        'task/reply titles, messages, and grounding text recorded after this feature was installed; excludes generated Local Engineer policy and prompt framing',
    },
    measured_savings: baseline,
    savings_note: baseline
      ? 'Savings use the user-supplied direct and delegated parent-session token totals.'
      : 'A single delegated run has no exact counterfactual. Supply both --baseline-parent-tokens and --delegated-parent-tokens from a controlled A/B comparison to calculate measured savings.',
  };
}

export function parseSince(value: string, currentTime = Date.now()): number {
  const duration = value.match(/^(\d+)(m|h|d|w)$/);
  if (duration) {
    const amount = Number(duration[1]);
    const milliseconds = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[duration[2]!]!;
    return currentTime - amount * milliseconds;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error('CLI_STATS_SINCE_INVALID');
  return timestamp;
}
