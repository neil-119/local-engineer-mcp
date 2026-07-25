import { existsSync, realpathSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import type { Config, Worker } from './domain.js';

const networkDomainSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (domain) =>
      domain !== '*' &&
      !domain.includes('/') &&
      !domain.includes(':') &&
      !domain.includes('*') &&
      /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(domain),
    'Network domains must be exact hostnames or IPv4 addresses',
  );

const workerSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9-]+$/),
    enabled: z.boolean(),
    required: z.boolean().optional(),
    harness: z.literal('codex'),
    model: z.string().min(1),
    model_provider: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    reasoning_effort: z.string().optional(),
    max_concurrency: z.number().int().positive(),
    timeout_seconds: z.number().int().positive(),
    idle_timeout_seconds: z.number().int().positive().default(600),
    worker_prompt: z.string().min(1).max(16000).optional(),
    environment: z.record(z.string()).optional(),
    environment_from_host: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
    container_model_provider: z
      .object({
        base_url: z.string().url(),
        wire_api: z.enum(['responses', 'chat']).default('responses'),
        api_key_environment_variable: z
          .string()
          .regex(/^[A-Z_][A-Z0-9_]*$/)
          .optional(),
        requires_openai_auth: z.boolean().default(false),
      })
      .strict()
      .optional(),
    container_codex_config_file: z.string().min(1).optional(),
  })
  .strict();
const containerSchema = z
  .object({
    command: z.string().trim().min(1),
    image: z
      .string()
      .trim()
      .regex(/^(?!-)[^\s\0]+$/)
      .default('local-engineer/codex-worker:latest'),
    base_image: z
      .string()
      .trim()
      .regex(/^(?!-)[^\s\0]+$/)
      .default('node:24-bookworm-slim'),
    dockerfile: z.string().min(1).optional(),
    codex_version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .default('0.144.6'),
    workspace_path: z
      .string()
      .regex(/^\/[^\0]*$/)
      .default('/workspace'),
    worker_user: z.string().trim().min(1).default('codex'),
    codex_command: z.string().trim().min(1).default('codex'),
    network: z
      .object({
        model_domains: z.array(networkDomainSchema).min(1),
        read_only_domains: z.array(networkDomainSchema).default([]),
        allow_private_model_endpoint: z.boolean().default(false),
      })
      .strict(),
  })
  .strict();
const workspaceSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9-]+$/),
    repositories: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z0-9-]+$/),
            path: z.string().min(1),
            default_access: z.enum(['read-only', 'read-write']).default('read-write'),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
const schema = z
  .object({
    version: z.literal(1),
    default_worker: z.string().optional(),
    server: z
      .object({
        state_dir: z.string().default('~/.local-engineer'),
        max_concurrency: z.number().int().positive().default(2),
        default_timeout_seconds: z.number().int().positive().default(3600),
        max_timeout_seconds: z.number().int().positive().default(14400),
        default_wait_timeout_seconds: z.number().int().positive().default(300),
        max_wait_timeout_seconds: z.number().int().positive().default(900),
        wait_response_reserve_seconds: z.number().int().nonnegative().default(10),
        max_wait_ids: z.number().int().positive().default(32),
        cancellation_grace_seconds: z.number().int().positive().default(15),
        final_result_max_characters_per_run: z.number().int().positive().default(6000),
        max_server_log_bytes: z
          .number()
          .int()
          .positive()
          .default(25 * 1024 * 1024),
        default_worker_prompt: z.string().min(1).max(16000).optional(),
      })
      .strict(),
    security: z
      .object({
        allowed_roots: z.array(z.string()).min(1),
        deny_unc_paths: z.boolean().default(true),
        deny_path_traversal: z.boolean().default(true),
        deny_symlink_escape: z.boolean().default(true),
        allowed_environment_variables: z.array(z.string()).default(['PATH', 'USERPROFILE', 'TEMP', 'TMP']),
      })
      .strict(),
    container: containerSchema,
    workspaces: z.array(workspaceSchema).optional(),
    workers: z.array(workerSchema).min(1),
  })
  .strict();
export const expandHome = (value: string) => value.replace(/^~(?=$|[\\/])/, homedir());
export const configPath = () =>
  process.env.LOCAL_ENGINEER_CONFIG ?? resolve(homedir(), '.local-engineer', 'config.yaml');
export function loadConfig(path = configPath()): Config {
  if (!existsSync(path)) throw new Error(`CONFIG_NOT_FOUND: ${path}`);
  const parsed = schema.parse(YAML.parse(readFileSync(path, 'utf8')));
  const names = new Set<string>();
  for (const worker of parsed.workers) {
    if (names.has(worker.name)) throw new Error(`CONFIG_DUPLICATE_WORKER:${worker.name}`);
    names.add(worker.name);
    if (!worker.model_provider) throw new Error(`CONFIG_CONTAINER_MODEL_PROVIDER_NAME_REQUIRED:${worker.name}`);
    if (!worker.container_model_provider) throw new Error(`CONFIG_CONTAINER_CODEX_PROVIDER_REQUIRED:${worker.name}`);
    if (worker.container_codex_config_file) {
      const codexConfig = expandHome(worker.container_codex_config_file);
      if (!isAbsolute(codexConfig)) throw new Error(`CONFIG_CONTAINER_CODEX_CONFIG_NOT_ABSOLUTE:${worker.name}`);
      if (!existsSync(codexConfig)) throw new Error(`CONFIG_CONTAINER_CODEX_CONFIG_NOT_FOUND:${worker.name}`);
      worker.container_codex_config_file = codexConfig;
    }
    const reservedContainerEnvironment = new Set([
      'CODEX_HOME',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'WS_PROXY',
      'WSS_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'CODEX_CA_CERTIFICATE',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
      'REQUESTS_CA_BUNDLE',
      'CURL_CA_BUNDLE',
      'NODE_EXTRA_CA_CERTS',
      'GIT_SSL_CAINFO',
      'PIP_CERT',
      'BUNDLE_SSL_CA_CERT',
      'NPM_CONFIG_CAFILE',
    ]);
    if (
      [...Object.keys(worker.environment ?? {}), ...worker.environment_from_host].some((name) =>
        reservedContainerEnvironment.has(name.toUpperCase()),
      )
    )
      throw new Error(`CONFIG_CONTAINER_RESERVED_ENVIRONMENT:${worker.name}`);
    for (const variable of worker.environment_from_host)
      if (!parsed.security.allowed_environment_variables.includes(variable))
        throw new Error(`CONFIG_ENVIRONMENT_VARIABLE_NOT_ALLOWED:${worker.name}:${variable}`);
  }
  const workspaceNames = new Set<string>();
  for (const workspace of parsed.workspaces ?? []) {
    if (workspaceNames.has(workspace.name)) throw new Error(`CONFIG_DUPLICATE_WORKSPACE:${workspace.name}`);
    workspaceNames.add(workspace.name);
    const repositoryNames = new Set<string>();
    for (const repository of workspace.repositories) {
      if (repositoryNames.has(repository.name))
        throw new Error(`CONFIG_DUPLICATE_REPOSITORY:${workspace.name}:${repository.name}`);
      repositoryNames.add(repository.name);
      canonicalWorkspace(repository.path, parsed as Config);
    }
  }
  const enabled = parsed.workers.filter((w) => w.enabled);
  if (!enabled.length) throw new Error('CONFIG_NO_ENABLED_WORKER');
  if (parsed.default_worker && !enabled.some((w) => w.name === parsed.default_worker))
    throw new Error('CONFIG_DEFAULT_WORKER_INVALID');
  const modelDomains = new Set(parsed.container.network.model_domains.map(normalizeNetworkDomain));
  const readOnlyDomains = new Set(parsed.container.network.read_only_domains.map(normalizeNetworkDomain));
  for (const domain of modelDomains)
    if (readOnlyDomains.has(domain)) throw new Error(`CONFIG_CONTAINER_NETWORK_DOMAIN_OVERLAP:${domain}`);
  for (const worker of parsed.workers) {
    const provider = worker.container_model_provider!;
    const modelHost = normalizeNetworkDomain(new URL(provider.base_url).hostname);
    if (!modelDomains.has(modelHost))
      throw new Error(`CONFIG_CONTAINER_MODEL_DOMAIN_NOT_ALLOWED:${worker.name}:${modelHost}`);
    if (isPrivateModelHost(modelHost) && !parsed.container.network.allow_private_model_endpoint)
      throw new Error(`CONFIG_CONTAINER_PRIVATE_MODEL_ENDPOINT_DISABLED:${worker.name}:${modelHost}`);
    const providerUrl = new URL(provider.base_url);
    if (providerUrl.username || providerUrl.password)
      throw new Error(`CONFIG_CONTAINER_MODEL_ENDPOINT_CREDENTIALS_FORBIDDEN:${worker.name}`);
  }
  return { ...parsed, server: { ...parsed.server, state_dir: expandHome(parsed.server.state_dir) } } as Config;
}

function normalizeNetworkDomain(value: string): string {
  return value
    .trim()
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
}

function isPrivateModelHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = parts as [number, number, number, number];
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}
export function defaultWorker(config: Config): Worker {
  return config.workers.find((w) => w.name === config.default_worker) ?? config.workers.find((w) => w.enabled)!;
}
export function canonicalWorkspace(input: string, config: Config): string {
  if (config.security.deny_unc_paths && /^\\\\/.test(input)) throw new Error('WORKING_DIRECTORY_UNC_DENIED');
  if (!isAbsolute(input)) throw new Error('WORKING_DIRECTORY_MUST_BE_ABSOLUTE');
  const requested = resolve(input);
  if (config.security.deny_path_traversal && input.split(/[\\/]+/).includes('..'))
    throw new Error('WORKING_DIRECTORY_TRAVERSAL_DENIED');
  if (!existsSync(requested)) throw new Error('WORKING_DIRECTORY_NOT_FOUND');
  const actual = realpathSync.native(requested);
  const allowed = config.security.allowed_roots.map(expandHome).map((root) => realpathSync.native(root));
  if (!allowed.some((root) => actual === root || actual.startsWith(`${root}\\`) || actual.startsWith(`${root}/`)))
    throw new Error('WORKING_DIRECTORY_NOT_ALLOWED');
  return actual;
}
