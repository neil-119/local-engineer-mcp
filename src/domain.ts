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
export type AgentOperation = 'reply' | 'promote' | 'delete';
export interface AgentOperationClaim {
  operation: AgentOperation;
  claimedAt: string;
}
export interface RunRecovery {
  kind: 'container_cleanup' | 'settled_operation';
  targetStatus?: 'failed' | 'cancelled';
  operation?: AgentOperation;
}
export type RepositoryAccess = 'read-only' | 'read-write';
export type ContainerPlatform = 'linux' | 'windows';
export interface ContainerNetworkConfig {
  /** Exact model endpoint hosts reachable only through the fixed-target relay. */
  model_domains: string[];
  /** Exact dependency hosts limited to GET, HEAD, and OPTIONS by the TLS-inspecting proxy. */
  read_only_domains: string[];
  allow_private_model_endpoint: boolean;
}
export interface ContainerConfig {
  command: string;
  platform: ContainerPlatform;
  /** Optional Docker-compatible CLI context (for example Rancher Desktop's default Moby context). */
  context?: string;
  /** Reserved /16 from which Local Engineer allocates isolated per-agent /24 networks. */
  agent_network_pool?: string;
  image: string;
  base_image: string;
  dockerfile?: string;
  codex_version: string;
  workspace_path: string;
  worker_user: string;
  codex_command: string;
  /** Mandatory resource ceilings for every Hyper-V isolated Windows container. */
  windows_memory_limit?: string;
  windows_cpu_count?: number;
  windows_workspace_mode?: 'volume-copy' | 'isolated-bind';
  network: ContainerNetworkConfig;
}
export type DependencyMode = 'read-only' | 'private-install';

export interface PrivateInstallTarget {
  repository: string;
  relativePath: string;
  containerPath: string;
  volume: string;
}

export interface WindowsDependencyMount {
  relativePath: string;
  hostPath: string;
  containerPath: string;
  fingerprint: string;
}
export interface WindowsRepositoryMount {
  repository: string;
  baselineSnapshotPath: string;
  workingClonePath: string;
  containerPath: string;
  access: 'read-write' | 'read-only';
  dependencyMounts: WindowsDependencyMount[];
}
export interface ContainerPreparationTimings {
  baselineCreationMs?: number;
  workingCloneCreationMs?: number;
  dependencyValidationMs?: number;
  networkAllocationMs?: number;
  setupContainerExecutionMs?: number;
  workerStartupMs?: number;
  appServerReadinessMs?: number;
  totalPreparationMs?: number;
}
export interface ContainerModelProvider {
  base_url: string;
  wire_api: 'responses' | 'chat';
  wire_api_compatibility?: 'standard' | 'flatten_namespaces';
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
  /** Pending host delta after an earlier successful promotion; full review remains relative to the original baseline. */
  promotion_base_revision?: number;
  promotion_changed_paths?: string[];
  promotion_patch_digest?: string;
  repository: string;
  changed_paths: string[];
  additions: number;
  deletions: number;
  patch_digest: string;
  delta_changed_paths: string[];
  delta_additions: number;
  delta_deletions: number;
  delta_patch_digest: string;
  dependency_manifest_stale?: boolean;
}
export interface ContainerChangeSet {
  revision: number;
  previous_revision: number;
  digest: string;
  repositories: RepositoryChangeSummary[];
  dependency_manifest_stale?: boolean;
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
  auto_compact_token_limit?: number;
  model_catalog_json_file?: string;
}
export interface Config {
  version: 1;
  default_worker?: string;
  default_dependency_mode?: DependencyMode;
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
  /** Monotonically increasing fencing token for write operations on this run. */
  fenceToken?: number;
  /** ISO timestamp when the current owner lease expires. */
  leaseExpiresAt?: string;
  /** ISO timestamp of the most recent owner heartbeat. */
  leaseHeartbeatAt?: string;
  /** Internal durable claim that serializes side-effecting operations for an agent. */
  operationClaim?: AgentOperationClaim;
  /** Internal recovery state. Container cleanup recovery consumes concurrency capacity. */
  recovery?: RunRecovery;
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
  dependencyMode?: DependencyMode;
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
  pendingSteer?: { message: string; requestedAt: string; id: string };
  steeringQueue?: SteeringMessage[];
  steeringMessages?: SteeringMessage[];
  steeringVersion?: number;
}
export type SteeringStatus = 'pending' | 'dispatching' | 'delivered' | 'failed' | 'uncertain';

export interface SteeringMessage {
  id: string;
  message: string;
  status: SteeringStatus;
  queuedAt: string;
  dispatchingAt?: string;
  dispatchOwnerId?: string;
  dispatchFenceToken?: number;
  sentAt?: string;
  error?: string;
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
  last_agent_message_excerpt?: string;
  last_agent_message_at?: string;
  agent_messages_completed_count?: number;
  turn_completed_at?: string;
  exit_reason?: string;
  resources_deleted_at?: string;
  recovery_error_excerpt?: string;
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
    starting: ['running', 'failed', 'cancel_requested', 'timed_out', 'recovery_required'],
    running: ['ready_for_review', 'failed', 'timed_out', 'cancel_requested', 'recovery_required'],
    failed: [],
    timed_out: [],
    cancel_requested: ['cancelled', 'failed', 'recovery_required'],
    cancelled: [],
    ready_for_review: ['queued', 'promoted', 'rejected', 'superseded', 'cancel_requested', 'recovery_required'],
    promoted: [],
    rejected: [],
    superseded: [],
    recovery_required: ['failed', 'cancelled'],
  };
  if (!allowed[from].includes(to)) throw new Error(`INVALID_STATE_TRANSITION:${from}->${to}`);
};

export interface RunSummaryResult {
  schema_version: 1;
  run_id: string;
  agent_id: string;
  title: string;
  status: RunStatus;
  duration_seconds?: number;
  in_progress: boolean;
  summary_source: 'model' | 'deterministic_fallback';
  summary_advisory: true;
  model_summary_error?: string;
  summary: string;
  key_blockers: string[];
  files_changed: string[];
  commands_count: number;
  failed_commands_count: number;
  timeline_items_analyzed: number;
  history_truncated: boolean;
}
