import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
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
        wire_api_compatibility: z.enum(['standard', 'flatten_namespaces']).default('standard'),
        api_key_environment_variable: z
          .string()
          .regex(/^[A-Z_][A-Z0-9_]*$/)
          .optional(),
        requires_openai_auth: z.boolean().default(false),
      })
      .strict()
      .optional(),
    container_codex_config_file: z.string().min(1).optional(),
    auto_compact_token_limit: z.number().int().positive().optional(),
    model_catalog_json_file: z.string().min(1).optional(),
  })
  .strict();
const containerSchema = z
  .object({
    command: z.string().trim().min(1),
    platform: z.enum(['linux', 'windows']).default('linux'),
    context: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)
      .optional(),
    agent_network_pool: z
      .string()
      .regex(/^10\.(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.0\.0\/16$/)
      .default('10.240.0.0/16'),
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
      .refine((value) => isSafeWorkspaceMountPath(value), {
        message: 'Container workspace path must be absolute for the selected platform',
      })
      .default('/workspace'),
    worker_user: z.string().trim().min(1).default('codex'),
    codex_command: z.string().trim().min(1).default('codex'),
    windows_memory_limit: z
      .string()
      .regex(/^[1-9][0-9]*(?:[kKmMgG])?[bB]?$/)
      .default('4g'),
    windows_cpu_count: z.number().int().positive().max(64).default(2),
    windows_workspace_mode: z.enum(['volume-copy', 'isolated-bind']).default('volume-copy'),
    network: z
      .object({
        model_domains: z.array(networkDomainSchema).min(1),
        read_only_domains: z.array(networkDomainSchema).default([]),
        allow_private_model_endpoint: z.boolean().default(false),
      })
      .strict(),
  })
  .strict()
  .superRefine((container, context) => {
    const windowsPath = /^[A-Za-z]:[\\/]/.test(container.workspace_path);
    if (container.platform === 'windows') {
      if (!windowsPath)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['workspace_path'],
          message: 'Windows workspace path required',
        });
      if (container.worker_user.toLowerCase() !== 'containeruser')
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['worker_user'],
          message: 'Windows workers must use ContainerUser',
        });
    } else {
      if (windowsPath) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['workspace_path'],
          message: 'Linux workspace path required',
        });
      }
      if (container.windows_workspace_mode === 'isolated-bind') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['windows_workspace_mode'],
          message: 'isolated-bind workspace mode is only supported on Windows platform',
        });
      }
    }
  });
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
    default_dependency_mode: z.enum(['read-only', 'private-install']).default('read-only'),
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
    if (worker.container_model_provider?.wire_api_compatibility === 'flatten_namespaces') {
      if (worker.container_model_provider.wire_api !== 'responses') {
        throw new Error(
          `CONFIG_WIRE_API_COMPATIBILITY_INVALID:${worker.name}:flatten_namespaces requires wire_api=responses`,
        );
      }
    }
    if (worker.model_catalog_json_file) {
      const catalogFile = expandHome(worker.model_catalog_json_file);
      try {
        validateAndReadModelCatalog(catalogFile, worker.model);
      } catch (e) {
        throw new Error(`${worker.name}:${e instanceof Error ? e.message : String(e)}`);
      }
      worker.model_catalog_json_file = catalogFile;
    }
    const reservedContainerEnvironment = new Set([
      'CODEX_HOME',
      'LOCAL_ENGINEER_RESPONSES_COMPATIBILITY',
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
      'LOCAL_ENGINEER_DEPENDENCY_ROOT',
      'PIP_CACHE_DIR',
      'NPM_CONFIG_CACHE',
      'YARN_CACHE_FOLDER',
      'CARGO_HOME',
      'RUSTUP_HOME',
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

function isSafeWorkspaceMountPath(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || /[\r\n\0,]/.test(normalized) || normalized.split('/').includes('..')) return false;
  if (/^\/(?!$)/.test(normalized)) return true;
  if (!/^[A-Za-z]:\/.+/.test(normalized)) return false;
  return !/[<>:"|?*]/.test(normalized.slice(3));
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

export interface ModelCatalogEntry {
  slug: string;
  apply_patch_tool_type?: 'function' | 'freeform';
  supports_parallel_tool_calls?: boolean;
  supports_search_tool?: boolean;
  context_window?: number;
  max_context_window?: number;
  auto_compact_token_limit?: number;
  tool_mode?: 'direct' | 'nested' | 'none';
  web_search_tool_type?: 'text' | 'function';
  [key: string]: unknown;
}

export interface ValidatedModelCatalog {
  contents: string;
  matchedModel: ModelCatalogEntry;
}

export function validateAndReadModelCatalog(
  catalogPath: string,
  expectedModelSlug: string,
  maximumBytes = 5 * 1024 * 1024,
): ValidatedModelCatalog {
  if (!isAbsolute(catalogPath)) {
    throw new Error('CONFIG_MODEL_CATALOG_NOT_ABSOLUTE');
  }

  let fd: number;
  try {
    fd = openSync(catalogPath, 'r');
  } catch {
    throw new Error('CONFIG_MODEL_CATALOG_NOT_FOUND');
  }

  let raw: string;
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      throw new Error('CONFIG_MODEL_CATALOG_NOT_REGULAR_FILE');
    }
    if (stats.size > maximumBytes) {
      throw new Error('CONFIG_MODEL_CATALOG_TOO_LARGE');
    }

    const buffer = Buffer.alloc(maximumBytes + 1);
    let totalRead = 0;
    while (totalRead <= maximumBytes) {
      const bytesRead = readSync(fd, buffer, totalRead, buffer.length - totalRead, null);
      if (bytesRead === 0) break;
      totalRead += bytesRead;
    }
    if (totalRead > maximumBytes) {
      throw new Error('CONFIG_MODEL_CATALOG_TOO_LARGE');
    }
    raw = buffer.subarray(0, totalRead).toString('utf8');
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore errors closing fd
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`CONFIG_MODEL_CATALOG_INVALID_JSON:${e instanceof Error ? e.message : String(e)}`);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('models' in parsed) ||
    !Array.isArray((parsed as Record<string, unknown>).models)
  ) {
    throw new Error('CONFIG_MODEL_CATALOG_MISSING_MODELS');
  }

  const catalogModels = (parsed as { models: unknown[] }).models;
  const matches: ModelCatalogEntry[] = [];
  for (const model of catalogModels) {
    if (typeof model !== 'object' || model === null) {
      throw new Error('CONFIG_MODEL_CATALOG_INVALID_MODEL_ENTRY');
    }
    const entry = model as Record<string, unknown>;
    if (typeof entry.slug !== 'string' || !entry.slug.trim()) {
      throw new Error('CONFIG_MODEL_CATALOG_MODEL_MISSING_SLUG');
    }

    if (entry.apply_patch_tool_type !== undefined) {
      if (
        typeof entry.apply_patch_tool_type !== 'string' ||
        !['function', 'freeform'].includes(entry.apply_patch_tool_type)
      ) {
        throw new Error(`CONFIG_MODEL_CATALOG_INVALID_APPLY_PATCH:${entry.slug}`);
      }
    }
    if (entry.supports_parallel_tool_calls !== undefined && typeof entry.supports_parallel_tool_calls !== 'boolean') {
      throw new Error(`CONFIG_MODEL_CATALOG_INVALID_PARALLEL_TOOL_CALLS:${entry.slug}`);
    }
    if (entry.supports_search_tool !== undefined && typeof entry.supports_search_tool !== 'boolean') {
      throw new Error(`CONFIG_MODEL_CATALOG_INVALID_SEARCH_TOOL:${entry.slug}`);
    }
    if (
      entry.context_window !== undefined &&
      (!Number.isInteger(entry.context_window) || (entry.context_window as number) <= 0)
    ) {
      throw new Error(`CONFIG_MODEL_CATALOG_INVALID_CONTEXT_WINDOW:${entry.slug}`);
    }
    if (
      entry.max_context_window !== undefined &&
      (!Number.isInteger(entry.max_context_window) || (entry.max_context_window as number) <= 0)
    ) {
      throw new Error(`CONFIG_MODEL_CATALOG_INVALID_MAX_CONTEXT_WINDOW:${entry.slug}`);
    }
    if (
      entry.auto_compact_token_limit !== undefined &&
      (!Number.isInteger(entry.auto_compact_token_limit) || (entry.auto_compact_token_limit as number) <= 0)
    ) {
      throw new Error(`CONFIG_MODEL_CATALOG_INVALID_AUTO_COMPACT:${entry.slug}`);
    }
    if (
      entry.tool_mode !== undefined &&
      (typeof entry.tool_mode !== 'string' || !['direct', 'nested', 'none'].includes(entry.tool_mode))
    ) {
      throw new Error(`CONFIG_MODEL_CATALOG_INVALID_TOOL_MODE:${entry.slug}`);
    }
    if (
      entry.web_search_tool_type !== undefined &&
      (typeof entry.web_search_tool_type !== 'string' || !['text', 'function'].includes(entry.web_search_tool_type))
    ) {
      throw new Error(`CONFIG_MODEL_CATALOG_INVALID_WEB_SEARCH:${entry.slug}`);
    }

    if (entry.slug === expectedModelSlug) {
      matches.push(entry as unknown as ModelCatalogEntry);
    }
  }

  if (matches.length === 0) {
    throw new Error(`CONFIG_MODEL_CATALOG_MODEL_NOT_FOUND:${expectedModelSlug}`);
  }
  if (matches.length > 1) {
    throw new Error(`CONFIG_MODEL_CATALOG_DUPLICATE_MODEL:${expectedModelSlug}`);
  }

  return { contents: raw, matchedModel: matches[0]! };
}
