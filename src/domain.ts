export const terminalStatuses = new Set([
  'failed',
  'timed_out',
  'cancelled',
  'promoted',
  'rejected',
  'superseded',
] as const);
export type RunStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'failed'
  | 'timed_out'
  | 'cancel_requested'
  | 'cancelled'
  | 'ready_for_review'
  | 'promoted'
  | 'rejected'
  | 'superseded'
  | 'recovery_required';
export type RepositoryAccess = 'read-only' | 'read-write';
export interface ContainerNetworkConfig {
  /** Exact model endpoint hosts reachable only through the fixed-target relay. */
  model_domains: string[];
  /** Exact dependency hosts limited to GET, HEAD, and OPTIONS by the TLS-inspecting proxy. */
  read_only_domains: string[];
  allow_private_model_endpoint: boolean;
}
export interface ContainerConfig {
  command: string;
  image: string;
  base_image: string;
  dockerfile?: string;
  codex_version: string;
  workspace_path: string;
  worker_user: string;
  codex_command: string;
  network: ContainerNetworkConfig;
}
export interface ContainerModelProvider {
  base_url: string;
  wire_api: 'responses' | 'chat';
  api_key_environment_variable?: string;
  requires_openai_auth: boolean;
}
export interface WorkspaceRepositoryConfig {
  name: string;
  path: string;
  default_access: RepositoryAccess;
}
export interface WorkspaceConfig {
  name: string;
  repositories: WorkspaceRepositoryConfig[];
}
export interface RunRepository {
  name: string;
  parentPath: string;
  containerPath: string;
  access: RepositoryAccess;
  parentHead?: string;
  baselineCommit?: string;
  baselineKind?: 'clean_head' | 'ephemeral_dirty_snapshot';
}
export interface RepositoryChangeSummary {
  repository: string;
  changed_paths: string[];
  additions: number;
  deletions: number;
  patch_digest: string;
  delta_changed_paths: string[];
  delta_additions: number;
  delta_deletions: number;
  delta_patch_digest: string;
}
export interface ContainerChangeSet {
  revision: number;
  previous_revision: number;
  digest: string;
  repositories: RepositoryChangeSummary[];
}
export interface GroundingPacket {
  objective?: string;
  known_facts?: string[];
  constraints?: string[];
  acceptance_criteria?: string[];
  references?: string[];
  parent_hypotheses?: string[];
  excluded_approaches?: string[];
  additional_context?: string;
}
export interface ParentToWorkerPayload {
  characters: number;
  estimated_tokens: number;
  title_characters: number;
  task_characters: number;
  grounding_characters: number;
  task_assignments: number;
  follow_up_messages: number;
}
export function parentToWorkerPayload(
  title: string,
  task: string,
  grounding: GroundingPacket | undefined,
  kind: 'assignment' | 'follow_up',
): ParentToWorkerPayload {
  const titleCharacters = title.length;
  const taskCharacters = task.length;
  const groundingCharacters = [
    grounding?.objective,
    ...(grounding?.known_facts ?? []),
    ...(grounding?.constraints ?? []),
    ...(grounding?.acceptance_criteria ?? []),
    ...(grounding?.references ?? []),
    ...(grounding?.parent_hypotheses ?? []),
    ...(grounding?.excluded_approaches ?? []),
    grounding?.additional_context,
  ].reduce((total, value) => total + (value?.length ?? 0), 0);
  const characters = titleCharacters + taskCharacters + groundingCharacters;
  return {
    characters,
    estimated_tokens: Math.ceil(characters / 4),
    title_characters: titleCharacters,
    task_characters: taskCharacters,
    grounding_characters: groundingCharacters,
    task_assignments: kind === 'assignment' ? 1 : 0,
    follow_up_messages: kind === 'follow_up' ? 1 : 0,
  };
}
export interface Worker {
  name: string;
  enabled: boolean;
  required?: boolean;
  harness: 'codex';
  model: string;
  model_provider?: string;
  reasoning_effort?: string;
  max_concurrency: number;
  timeout_seconds: number;
  /** Fail a silent running turn rather than occupying capacity forever. */
  idle_timeout_seconds: number;
  /** Replaces the built-in worker policy for this profile only. */
  worker_prompt?: string;
  environment?: Record<string, string>;
  environment_from_host?: string[];
  container_model_provider?: ContainerModelProvider;
  container_codex_config_file?: string;
}
export interface Config {
  version: 1;
  default_worker?: string;
  server: {
    state_dir: string;
    max_concurrency: number;
    default_timeout_seconds: number;
    max_timeout_seconds: number;
    default_wait_timeout_seconds: number;
    max_wait_timeout_seconds: number;
    /** Returned early to avoid racing the MCP client's outer tool-call deadline. */
    wait_response_reserve_seconds: number;
    max_wait_ids: number;
    cancellation_grace_seconds: number;
    final_result_max_characters_per_run: number;
    max_server_log_bytes: number;
    /** Replaces the built-in strict worker policy for every worker without a profile override. */
    default_worker_prompt?: string;
  };
  security: {
    allowed_roots: string[];
    deny_unc_paths: boolean;
    deny_path_traversal: boolean;
    deny_symlink_escape: boolean;
    allowed_environment_variables: string[];
  };
  container: ContainerConfig;
  workspaces?: WorkspaceConfig[];
  workers: Worker[];
}
export interface Run {
  runId: string;
  agentId: string;
  /** Internal connection-scoped owner; never project this through MCP. */
  ownerId: string;
  title: string;
  task: string;
  grounding?: GroundingPacket;
  workingDirectory: string;
  workspaceName?: string;
  repositories?: RunRepository[];
  containerWorkingDirectory?: string;
  imageProfile?: string;
  imageReference?: string;
  changeSet?: ContainerChangeSet;
  worker: string;
  status: RunStatus;
  continuationIndex: number;
  continuationOfRunId?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  workerThreadId?: string;
  workerTurnId?: string;
  result?: Result;
  errorCode?: string;
  diagnostics?: RunDiagnostics;
  stats?: RunStats;
  requiresUserAction: boolean;
}
export interface RunStats {
  worker_tokens?: {
    total: number;
    input: number;
    cached_input: number;
    output: number;
    reasoning_output: number;
    source: 'app_server';
  };
  /**
   * Text directly supplied by the parent through start/reply. This deliberately
   * excludes Local Engineer's generated policy and prompt framing, so it is a
   * useful proxy for parent delegation effort rather than worker context size.
   */
  parent_to_worker?: ParentToWorkerPayload;
  parent_visible: {
    characters: number;
    estimated_tokens: number;
    changes_characters: number;
    diff_characters: number;
    file_characters: number;
    lifecycle_characters: number;
  };
  review_requests: {
    changes: number;
    diffs: number;
    files: number;
  };
}
export interface RunDiagnostics {
  last_phase: string;
  last_activity_at: string;
  command_started_at?: string;
  command_completed_at?: string;
  commands_started_count?: number;
  commands_completed_count?: number;
  commands_active_count?: number;
  last_command_status?: 'running' | 'succeeded' | 'failed' | 'declined';
  last_command_exit_code?: number;
  last_command_error_excerpt?: string;
  turn_completed_at?: string;
  exit_reason?: string;
  resources_deleted_at?: string;
}
export interface Result {
  reportStatus: 'valid' | 'missing' | 'invalid';
  summary: string;
  filesChanged: string[];
  verification: Array<{ name: string; status: 'passed' | 'failed' | 'not_run' }>;
  unresolvedRisks: string[];
  requiresUserAction: boolean;
  identityVerified: boolean;
  reportExcerpt?: string;
}
export const isSettled = (status: RunStatus) => terminalStatuses.has(status as never) || status === 'ready_for_review';
export const transition = (from: RunStatus, to: RunStatus): void => {
  const allowed: Record<RunStatus, RunStatus[]> = {
    queued: ['starting', 'cancelled'],
    starting: ['running', 'failed', 'cancel_requested', 'timed_out'],
    running: ['ready_for_review', 'failed', 'timed_out', 'cancel_requested'],
    failed: [],
    timed_out: [],
    cancel_requested: ['cancelled', 'failed'],
    cancelled: [],
    ready_for_review: ['queued', 'promoted', 'rejected', 'superseded', 'cancel_requested'],
    promoted: [],
    rejected: [],
    superseded: [],
    recovery_required: ['failed', 'cancelled'],
  };
  if (!allowed[from].includes(to)) throw new Error(`INVALID_STATE_TRANSITION:${from}->${to}`);
};
