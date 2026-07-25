import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ContainerConfig, Worker } from './domain.js';
import { expandHome } from './config.js';

export interface GeneratedCodexConfigPaths {
  workerConfigPath: string;
  proxyConfigPath: string;
}

export function writeContainerCodexConfigs(
  worker: Worker,
  container: ContainerConfig,
  workerConfigPath: string,
  proxyConfigPath: string,
): GeneratedCodexConfigPaths {
  mkdirSync(dirname(workerConfigPath), { recursive: true });
  mkdirSync(dirname(proxyConfigPath), { recursive: true });
  if (worker.container_codex_config_file) {
    const source = expandHome(worker.container_codex_config_file);
    validateCustomCodexConfig(readCustomCodexConfig(source));
    copyFileSync(source, workerConfigPath);
  } else {
    writeFileSync(workerConfigPath, generatedWorkerConfig(worker), { encoding: 'utf8', mode: 0o600 });
  }
  writeFileSync(proxyConfigPath, generatedProxyConfig(container), { encoding: 'utf8', mode: 0o600 });
  return { workerConfigPath, proxyConfigPath };
}

export function generatedWorkerConfig(worker: Worker): string {
  const provider = worker.container_model_provider;
  if (!worker.model_provider || !provider) throw new Error('CONTAINER_CODEX_PROVIDER_MISSING');
  return [
    `model = ${toml(worker.model)}`,
    `model_provider = ${toml(worker.model_provider)}`,
    ...(worker.reasoning_effort ? [`model_reasoning_effort = ${toml(worker.reasoning_effort)}`] : []),
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    '',
    `[model_providers.${tomlKey(worker.model_provider)}]`,
    `name = ${toml(worker.model_provider)}`,
    `base_url = ${toml(relayedModelBaseUrl(provider.base_url))}`,
    `wire_api = ${toml(provider.wire_api)}`,
    `requires_openai_auth = ${provider.requires_openai_auth}`,
    ...(provider.api_key_environment_variable ? [`env_key = ${toml(provider.api_key_environment_variable)}`] : []),
    '',
  ].join('\n');
}

export function generatedProxyConfig(container: ContainerConfig): string {
  const domains = [...new Set(container.network.read_only_domains)].sort();
  if (domains.includes('*')) throw new Error('CONTAINER_NETWORK_ALLOWLIST_INVALID');
  return [
    '[network]',
    'enabled = true',
    'proxy_url = "http://0.0.0.0:3128"',
    'enable_socks5 = true',
    'socks_url = "http://0.0.0.0:8081"',
    'enable_socks5_udp = false',
    'allow_upstream_proxy = false',
    'dangerously_allow_non_loopback_proxy = true',
    'mode = "limited"',
    'mitm = true',
    'allow_local_binding = false',
    'dangerously_allow_all_unix_sockets = false',
    '',
    ...(domains.length ? ['[network.domains]', ...domains.map((domain) => `${toml(domain)} = "allow"`)] : []),
    '',
  ].join('\n');
}

export function relayedModelBaseUrl(upstreamBaseUrl: string): string {
  const upstream = new URL(upstreamBaseUrl);
  const path = upstream.pathname.replace(/\/+$/, '');
  return `http://local-engineer-proxy:8090${path}`;
}

export function readCustomCodexConfig(path: string, maximumBytes = 1024 * 1024): string {
  const contents = readFileSync(expandHome(path), 'utf8');
  if (Buffer.byteLength(contents) > maximumBytes) throw new Error('CONTAINER_CODEX_CONFIG_TOO_LARGE');
  return contents;
}

export function validateCustomCodexConfig(contents: string): void {
  const forbidden = [
    /^\s*\[mcp_servers(?:\.|\])/im,
    /^\s*\[hooks?(?:\.|\])/im,
    /^\s*\[plugins?(?:\.|\])/im,
    /^\s*web_search\s*=/im,
  ];
  if (forbidden.some((pattern) => pattern.test(contents))) throw new Error('CONTAINER_CODEX_CONFIG_UNSAFE');
}

function toml(value: string): string {
  return JSON.stringify(value);
}

function tomlKey(value: string): string {
  return JSON.stringify(value);
}
