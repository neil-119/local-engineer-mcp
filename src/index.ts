import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { configPath, loadConfig } from './config.js';
import { RunStore } from './store.js';
import { LocalEngineer } from './service.js';
import { ContainerRuntime } from './container-runtime.js';
import { ImageProfileError } from './image-profile.js';
import { summarizeStats } from './stats.js';

const grounding = z
  .object({
    objective: z.string().max(8000).optional(),
    known_facts: z.array(z.string().max(2000)).max(100).optional(),
    constraints: z.array(z.string().max(2000)).max(100).optional(),
    acceptance_criteria: z.array(z.string().max(2000)).max(100).optional(),
    references: z.array(z.string().max(2000)).max(100).optional(),
    parent_hypotheses: z.array(z.string().max(2000)).max(100).optional(),
    excluded_approaches: z.array(z.string().max(2000)).max(100).optional(),
    additional_context: z.string().max(16000).optional(),
  })
  .strict();
const asText = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const error = (cause: unknown) => ({
  content: [
    {
      type: 'text' as const,
      text: JSON.stringify(
        cause instanceof ImageProfileError
          ? { schema_version: 1, ...cause.details }
          : { schema_version: 1, error_code: code(cause) },
      ),
    },
  ],
  isError: true,
});
const code = (cause: unknown) => (cause instanceof Error ? cause.message.split(/[:\s]/)[0] : 'INTERNAL_ERROR');
const localWorkerWarning =
  ' SECURITY: Container workers write untrusted code in disposable snapshots. Carefully review requested diffs or files and independently validate promoted changes.';
const toolDescription = (description: string) => description + localWorkerWarning;

export function createServer(engine: LocalEngineer): McpServer {
  const server = new McpServer({ name: 'local-engineer-mcp', version: '0.1.0' });
  server.tool(
    'local_engineer_start',
    toolDescription(
      'Start an autonomous disposable container worker asynchronously. Prefer the repository image_profile documented in AGENTS.md. A missing or stale profile fails closed with exact local_engineer_build_image planning instructions; do not silently fall back or build without user approval.',
    ),
    {
      title: z.string(),
      task: z.string().min(1).max(50000),
      grounding_packet: grounding.optional(),
      working_directory: z.string().optional(),
      workspace: z.string().optional(),
      repositories: z.record(z.enum(['read-only', 'read-write'])).optional(),
      working_repository: z.string().optional(),
      worker: z.string().optional(),
      image_profile: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
        .optional(),
      timeout_seconds: z.number().int().positive().optional(),
    },
    async (input) => {
      try {
        return asText(
          engine.start({
            title: input.title,
            task: input.task,
            grounding: input.grounding_packet,
            workingDirectory: input.working_directory,
            workspaceName: input.workspace,
            repositoryAccess: input.repositories,
            workingRepository: input.working_repository,
            worker: input.worker,
            imageProfile: input.image_profile,
            timeoutSeconds: input.timeout_seconds,
          }),
        );
      } catch (cause) {
        return error(cause);
      }
    },
  );
  server.tool(
    'local_engineer_build_image',
    toolDescription(
      'Plan or build a reusable project image profile. Always call mode plan first, show the detected inputs, install steps, read-only dependency domains, and plan digest to the user, and obtain explicit approval. Build requires that exact digest and user_approved true. Dependency installers run in a temporary container with no direct egress; its only network path is the TLS-inspecting proxy, which permits GET, HEAD, and OPTIONS to configured read_only_domains. Arbitrary project Dockerfiles are not executed.',
    ),
    {
      working_directory: z.string(),
      profile: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
      mode: z.enum(['plan', 'build']).default('plan'),
      expected_plan_digest: z
        .string()
        .regex(/^sha256:[0-9a-f]{64}$/)
        .optional(),
      additional_domains: z.array(z.string()).max(50).optional(),
      user_approved: z.boolean().optional(),
    },
    async (input) => {
      try {
        if (input.mode === 'plan')
          return asText(engine.planImage(input.working_directory, input.profile, input.additional_domains));
        if (!input.expected_plan_digest) throw new Error('IMAGE_PLAN_DIGEST_REQUIRED');
        if (input.user_approved !== true) throw new Error('IMAGE_BUILD_USER_APPROVAL_REQUIRED');
        return asText(
          await engine.buildImage(
            input.working_directory,
            input.profile,
            input.expected_plan_digest,
            input.additional_domains,
          ),
        );
      } catch (cause) {
        return error(cause);
      }
    },
  );
  server.tool(
    'local_engineer_reply',
    toolDescription(
      'Queue a parent-initiated follow-up after reviewing a container revision. Workers cannot initiate questions, call parent tools, or access parent MCP servers.',
    ),
    {
      agent_id: z.string(),
      title: z.string(),
      message: z.string().min(1).max(50000),
      grounding_packet: grounding.optional(),
      timeout_seconds: z.number().int().positive().optional(),
    },
    async (input) => {
      try {
        return asText(
          engine.reply({
            agentId: input.agent_id,
            title: input.title,
            message: input.message,
            grounding: input.grounding_packet,
            timeoutSeconds: input.timeout_seconds,
          }),
        );
      } catch (cause) {
        return error(cause);
      }
    },
  );
  server.tool(
    'local_engineer_wait_for_completion',
    toolDescription(
      'Wait for one or many container runs owned by this parent connection without exposing logs. Prefer wait_for any with timeout_seconds 300 rather than repeated short polls. When a run includes delegation_impact, you may share its local-work token total with the user; call it offloaded work, not measured parent-token savings, unless a controlled A/B comparison establishes savings.',
    ),
    {
      run_ids: z.array(z.string()).min(1),
      wait_for: z.enum(['all', 'any']),
      timeout_seconds: z.number().int().positive().optional(),
    },
    async (input) => {
      try {
        const result = await engine.wait(input.run_ids, input.wait_for, input.timeout_seconds);
        return asText({
          schema_version: 1,
          wait_for: input.wait_for,
          timed_out: result.timedOut,
          settled: result.settled,
          pending: result.pending,
        });
      } catch (cause) {
        return error(cause);
      }
    },
  );
  server.tool(
    'local_engineer_status',
    toolDescription(
      'Get bounded status for container run or agent IDs owned by this parent connection. delegation_impact reports exact local worker tokens when available and a bounded review-context estimate; it is not a measured parent-token saving without a controlled A/B comparison.',
    ),
    { run_ids: z.array(z.string()).optional(), agent_ids: z.array(z.string()).optional() },
    async (input) => {
      try {
        return asText({ schema_version: 1, runs: engine.status(input.run_ids, input.agent_ids) });
      } catch (cause) {
        return error(cause);
      }
    },
  );
  server.tool(
    'local_engineer_cancel',
    toolDescription('Cancel a queued or active run owned by this parent connection.'),
    { run_id: z.string() },
    async (input) => {
      try {
        return asText(await engine.cancel(input.run_id));
      } catch (cause) {
        return error(cause);
      }
    },
  );
  server.tool(
    'local_engineer_list',
    toolDescription('List recent local worker runs owned by this parent connection using opaque handles.'),
    {
      status: z
        .enum([
          'queued',
          'starting',
          'running',
          'failed',
          'timed_out',
          'cancel_requested',
          'cancelled',
          'recovery_required',
          'ready_for_review',
          'promoted',
          'rejected',
          'superseded',
        ])
        .optional(),
      worker: z.string().optional(),
      title: z.string().optional(),
      active_only: z.boolean().optional(),
      limit: z.number().int().positive().max(100).optional(),
    },
    async (input) => {
      try {
        return asText({
          schema_version: 1,
          runs: engine.list({
            status: input.status,
            worker: input.worker,
            title: input.title,
            activeOnly: input.active_only,
            limit: input.limit,
          }),
        });
      } catch (cause) {
        return error(cause);
      }
    },
  );
  server.tool(
    'local_engineer_get_changes',
    toolDescription('Get bounded per-repository change metadata for a container agent that is ready for review.'),
    { agent_id: z.string() },
    async (input) => {
      try {
        return asText(engine.getChanges(input.agent_id));
      } catch (cause) {
        return error(cause);
      }
    },
  );
  server.tool(
    'local_engineer_get_diff',
    toolDescription(
      'Get a bounded patch for one repository. since_last_check returns only changes after the last completely delivered diff for this parent connection; full returns the complete current patch. Truncated responses never advance the delivery cursor. Review remains mandatory before promotion.',
    ),
    {
      agent_id: z.string(),
      repository: z.string(),
      mode: z.enum(['since_last_check', 'full']).default('since_last_check'),
      max_characters: z.number().int().positive().max(100000).optional(),
    },
    async (input) => {
      try {
        return asText(await engine.getDiff(input.agent_id, input.repository, input.mode, input.max_characters));
      } catch (cause) {
        return error(cause);
      }
    },
  );
  server.tool(
    'local_engineer_get_file',
    toolDescription('Get one bounded text file from a container agent revision for focused review.'),
    {
      agent_id: z.string(),
      repository: z.string(),
      path: z.string(),
      max_bytes: z.number().int().positive().max(100000).optional(),
    },
    async (input) => {
      try {
        return asText(await engine.getFile(input.agent_id, input.repository, input.path, input.max_bytes));
      } catch (cause) {
        return error(cause);
      }
    },
  );
  server.tool(
    'local_engineer_keep_changes',
    toolDescription(
      'Promote one exact reviewed container change-set revision into its parent repositories after independent conflict checks. Leaves changes uncommitted.',
    ),
    {
      agent_id: z.string(),
      expected_revision: z.number().int().positive(),
      expected_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    },
    async (input) => {
      try {
        return asText(await engine.keepChanges(input.agent_id, input.expected_revision, input.expected_digest));
      } catch (cause) {
        return error(cause);
      }
    },
  );
  server.tool(
    'local_engineer_delete_agent',
    toolDescription(
      'Delete a disposable container agent and discard unpromoted work, containers, networks, and workspace volume. Returns explicit cleanup confirmation; bounded historical run records remain available for observability.',
    ),
    { agent_id: z.string() },
    async (input) => {
      try {
        return asText(await engine.deleteAgent(input.agent_id));
      } catch (cause) {
        return error(cause);
      }
    },
  );
  return server;
}
async function main(): Promise<void> {
  const config = loadConfig();
  const store = new RunStore(config.server.state_dir, config.server.max_server_log_bytes);
  const engine = new LocalEngineer(config, store);
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === 'doctor') {
    const containerProbe = await new ContainerRuntime(config.container.command).probe(config.container.image);
    console.log(
      JSON.stringify(
        {
          config_path: configPath(),
          state_dir: config.server.state_dir,
          default_worker: config.default_worker ?? config.workers.find((w) => w.enabled)?.name,
          node: process.version,
          status: 'configuration_valid',
          container_runtime: containerProbe,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'image' && arguments_[0] === 'build') {
    const option = (name: string) => {
      const index = arguments_.indexOf(name);
      return index >= 0 ? arguments_[index + 1] : undefined;
    };
    const bundledDockerfile = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'container', 'worker.Dockerfile');
    const dockerfile = option('--dockerfile') ?? config.container.dockerfile ?? bundledDockerfile;
    if (!existsSync(dockerfile)) throw new Error('CONTAINER_DOCKERFILE_NOT_FOUND');
    const runtime = new ContainerRuntime(config.container.command);
    await runtime.buildImage({
      dockerfile,
      context: resolve(dirname(dockerfile)),
      image: option('--tag') ?? config.container.image,
      baseImage: option('--base-image') ?? config.container.base_image,
      codexVersion: config.container.codex_version,
    });
    console.log(
      JSON.stringify(
        {
          status: 'built',
          image: option('--tag') ?? config.container.image,
          base_image: option('--base-image') ?? config.container.base_image,
          runtime: config.container.command,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'sessions' || command === 'list') {
    const limitIndex = arguments_.findIndex((argument) => argument === '-n' || argument === '--limit');
    const limit = limitIndex >= 0 ? Number(arguments_[limitIndex + 1]) : 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('CLI_LIMIT_INVALID');
    const sessions = store
      .list()
      .slice(0, limit)
      .map((run) => ({
        run_id: run.runId,
        agent_id: run.agentId,
        status: run.status,
        title: run.title,
        worker: run.worker,
        created_at: run.createdAt,
        requires_user_action: run.requiresUserAction,
      }));
    console.log(JSON.stringify({ sessions }, null, 2));
    return;
  }
  if (command === 'stats') {
    const option = (name: string) => {
      const index = arguments_.indexOf(name);
      return index >= 0 ? arguments_[index + 1] : undefined;
    };
    const numberOption = (name: string) => {
      const value = option(name);
      if (value === undefined) return undefined;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) throw new Error('CLI_STATS_TOKEN_COUNT_INVALID');
      return parsed;
    };
    console.log(
      JSON.stringify(
        summarizeStats(store.list(), {
          since: option('--since'),
          agentId: option('--agent'),
          runId: option('--run'),
          baselineParentTokens: numberOption('--baseline-parent-tokens'),
          delegatedParentTokens: numberOption('--delegated-parent-tokens'),
        }),
        null,
        2,
      ),
    );
    return;
  }
  const server = createServer(engine);
  await server.connect(new StdioServerTransport());
  const worker =
    config.workers.find((candidate) => candidate.name === config.default_worker) ??
    config.workers.find((candidate) => candidate.enabled);
  const startup = {
    transport: 'stdio',
    pid: process.pid,
    config_path: configPath(),
    state_dir: config.server.state_dir,
    default_worker: worker?.name,
    worker_harness: worker?.harness,
    network_binding: 'none (STDIO transport)',
  };
  store.logServer('server.ready', startup);
  console.error(`Local Engineer MCP ready: ${JSON.stringify(startup)}`);
}
if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js'))
  void main().catch((cause) => {
    console.error(process.argv[2] ? (cause instanceof Error ? cause.message : String(cause)) : code(cause));
    process.exitCode = 1;
  });
