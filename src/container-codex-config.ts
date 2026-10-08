import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ContainerConfig, Worker } from './domain.js';
import { expandHome, validateAndReadModelCatalog } from './config.js';
import { containerLayout, joinContainerPath } from './container-platform.js';

export interface GeneratedCodexConfigPaths {
  workerConfigPath: string;
  proxyConfigPath: string;
  modelCatalogPath?: string;
}

export type WorkspaceMountSpec = string | { containerPath: string; access?: 'read-write' | 'read-only' };

export function writeContainerCodexConfigs(
  worker: Worker,
  container: ContainerConfig,
  workerConfigPath: string,
  proxyConfigPath: string,
  proxyBindAddress?: string,
  workspaceRoots?: WorkspaceMountSpec[],
): GeneratedCodexConfigPaths {
  mkdirSync(dirname(workerConfigPath), { recursive: true });
  mkdirSync(dirname(proxyConfigPath), { recursive: true });
  let modelCatalogPath: string | undefined;
  if (worker.model_catalog_json_file) {
    const source = expandHome(worker.model_catalog_json_file);
    const validated = validateAndReadModelCatalog(source, worker.model);
    modelCatalogPath = join(dirname(workerConfigPath), 'model-catalog.json');
    writeFileSync(modelCatalogPath, validated.contents, { encoding: 'utf8', mode: 0o600 });
  }
  if (worker.container_codex_config_file) {
    const source = expandHome(worker.container_codex_config_file);
    let customConfig = readCustomCodexConfig(source);
    validateCustomCodexConfig(customConfig);
    if (worker.auto_compact_token_limit !== undefined) {
      customConfig = injectAutoCompactTokenLimit(customConfig, worker.auto_compact_token_limit);
    }
    if (worker.model_catalog_json_file) {
      customConfig = injectModelCatalogPath(customConfig, workerModelCatalogPath(container));
    } else {
      assertNoUnreachableHostCatalog(customConfig);
    }
    const fileToolsSection = generatedFileToolsConfig(container, workspaceRoots);
    writeFileSync(workerConfigPath, `${customConfig.trimEnd()}\n\n${fileToolsSection}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } else {
    writeFileSync(workerConfigPath, generatedWorkerConfig(worker, container, workspaceRoots), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
  writeFileSync(proxyConfigPath, generatedProxyConfig(container, proxyBindAddress), { encoding: 'utf8', mode: 0o600 });
  return { workerConfigPath, proxyConfigPath, ...(modelCatalogPath ? { modelCatalogPath } : {}) };
}

export function generatedFileToolsConfig(container?: ContainerConfig, workspaceRoots?: WorkspaceMountSpec[]): string {
  const layout = container ? containerLayout(container) : undefined;
  const nodeExecutable = layout
    ? layout.nodeExecutable
    : process.platform === 'win32'
      ? 'C:/Node/node.exe'
      : '/usr/local/bin/node';
  const serverScript = layout
    ? layout.fileToolsServer
    : process.platform === 'win32'
      ? 'C:/local-engineer/file-tools-server.mjs'
      : '/usr/local/lib/local-engineer/file-tools-server.mjs';

  const scriptArgs: string[] = [serverScript];
  if (workspaceRoots && workspaceRoots.length > 0) {
    for (const root of workspaceRoots) {
      if (typeof root === 'string') {
        scriptArgs.push('--rw', root);
      } else {
        if (root.access === 'read-only') {
          scriptArgs.push('--ro', root.containerPath);
        } else {
          scriptArgs.push('--rw', root.containerPath);
        }
      }
    }
  }

  return [
    '[mcp_servers.file_tools]',
    `command = ${toml(nodeExecutable)}`,
    `args = [${scriptArgs.map(toml).join(', ')}]`,
  ].join('\n');
}

export function workerModelCatalogPath(container?: ContainerConfig): string {
  const layout = container ? containerLayout(container) : undefined;
  if (!layout) {
    return process.platform === 'win32'
      ? 'C:/local-engineer/codex-home/model-catalog.json'
      : '/home/codex/.codex/model-catalog.json';
  }
  return joinContainerPath(container?.platform ?? 'linux', layout.codexHome, 'model-catalog.json');
}

export function generatedWorkerConfig(
  worker: Worker,
  container?: ContainerConfig,
  workspaceRoots?: WorkspaceMountSpec[],
): string {
  const provider = worker.container_model_provider;
  if (!worker.model_provider || !provider) throw new Error('CONTAINER_CODEX_PROVIDER_MISSING');
  const fileToolsSection = generatedFileToolsConfig(container, workspaceRoots);

  return [
    `model = ${toml(worker.model)}`,
    `model_provider = ${toml(worker.model_provider)}`,
    ...(worker.reasoning_effort ? [`model_reasoning_effort = ${toml(worker.reasoning_effort)}`] : []),
    ...(worker.auto_compact_token_limit !== undefined
      ? [`model_auto_compact_token_limit = ${worker.auto_compact_token_limit}`]
      : []),
    ...(worker.model_catalog_json_file ? [`model_catalog_json = ${toml(workerModelCatalogPath(container))}`] : []),
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
    fileToolsSection,
    '',
  ].join('\n');
}

export function generatedProxyConfig(container: ContainerConfig, bindAddress?: string): string {
  const domains = [...new Set(container.network.read_only_domains)].sort();
  if (domains.includes('*')) throw new Error('CONTAINER_NETWORK_ALLOWLIST_INVALID');
  if (container.platform === 'windows' && !/^10\.\d{1,3}\.\d{1,3}\.2$/.test(bindAddress ?? ''))
    throw new Error('CONTAINER_PROXY_BIND_ADDRESS_INVALID');
  const listenAddress = bindAddress ?? '0.0.0.0';
  return [
    '[network]',
    'enabled = true',
    `proxy_url = "http://${listenAddress}:3128"`,
    'enable_socks5 = true',
    `socks_url = "http://${listenAddress}:8081"`,
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

export function relayedModelBaseUrl(upstreamBaseUrl: string, relayAuthority = 'local-engineer-proxy'): string {
  if (!/^(?:[A-Za-z0-9][A-Za-z0-9.-]{0,252}|\d{1,3}(?:\.\d{1,3}){3})$/.test(relayAuthority))
    throw new Error('CONTAINER_MODEL_RELAY_AUTHORITY_INVALID');
  const upstream = new URL(upstreamBaseUrl);
  const path = upstream.pathname.replace(/\/+$/, '');
  return `http://${relayAuthority}:8090${path}`;
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

export interface TomlRootKeyScan {
  firstTableIndex: number;
  rootKeyMatches: Array<{ lineStartIndex: number; lineEndIndex: number }>;
}

export type TomlRootCompactionScan = TomlRootKeyScan;

export function scanTomlForRootKey(content: string, keyName: string): TomlRootKeyScan {
  let inComment = false;
  let inBasicString = false;
  let inLiteralString = false;
  let inMlBasicString = false;
  let inMlLiteralString = false;
  let bracketDepth = 0;
  let braceDepth = 0;
  let atLineStart = true;
  let lineStartIndex = 0;
  let firstTableIndex = -1;
  const rootKeyMatches: Array<{ lineStartIndex: number; lineEndIndex: number }> = [];

  const escapedKey = keyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyRegex = new RegExp(`^(?:${escapedKey}|"${escapedKey}"|'${escapedKey}')[ \t]*=`);

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;

    if (ch === '\n') {
      inComment = false;
      if (!inMlBasicString && !inMlLiteralString) {
        inBasicString = false;
        inLiteralString = false;
      }
      atLineStart = true;
      lineStartIndex = i + 1;
      continue;
    }
    if (ch === '\r') {
      continue;
    }

    if (inComment) {
      continue;
    }

    if (inMlBasicString) {
      if (ch === '"' && content.slice(i, i + 3) === '"""') {
        let backslashes = 0;
        let b = i - 1;
        while (b >= 0 && content[b] === '\\') {
          backslashes++;
          b--;
        }
        if (backslashes % 2 === 0) {
          inMlBasicString = false;
          i += 2;
          continue;
        }
      }
      continue;
    }

    if (inMlLiteralString) {
      if (ch === "'" && content.slice(i, i + 3) === "'''") {
        inMlLiteralString = false;
        i += 2;
        continue;
      }
      continue;
    }

    if (inBasicString) {
      if (ch === '"') {
        let backslashes = 0;
        let b = i - 1;
        while (b >= 0 && content[b] === '\\') {
          backslashes++;
          b--;
        }
        if (backslashes % 2 === 0) {
          inBasicString = false;
        }
      }
      continue;
    }

    if (inLiteralString) {
      if (ch === "'") {
        inLiteralString = false;
      }
      continue;
    }

    // Outside any string or comment
    if (ch === '#') {
      inComment = true;
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      continue;
    }

    // First non-whitespace character on this line
    if (atLineStart) {
      atLineStart = false;
      if (bracketDepth === 0 && braceDepth === 0) {
        if (ch === '[') {
          if (firstTableIndex === -1) {
            firstTableIndex = lineStartIndex;
          }
        } else if (firstTableIndex === -1) {
          const restOfLine = content.slice(i);
          const match = restOfLine.match(keyRegex);
          if (match) {
            let lineEndIndex = content.indexOf('\n', i);
            if (lineEndIndex === -1) {
              lineEndIndex = content.length;
            } else if (lineEndIndex > 0 && content[lineEndIndex - 1] === '\r') {
              lineEndIndex--;
            }
            rootKeyMatches.push({ lineStartIndex, lineEndIndex });
          }
        }
      }
    }

    if (ch === '"') {
      if (content.slice(i, i + 3) === '"""') {
        inMlBasicString = true;
        i += 2;
      } else {
        inBasicString = true;
      }
      continue;
    }

    if (ch === "'") {
      if (content.slice(i, i + 3) === "'''") {
        inMlLiteralString = true;
        i += 2;
      } else {
        inLiteralString = true;
      }
      continue;
    }

    if (ch === '[') {
      bracketDepth++;
      continue;
    }

    if (ch === ']') {
      if (bracketDepth > 0) bracketDepth--;
      continue;
    }

    if (ch === '{') {
      braceDepth++;
      continue;
    }

    if (ch === '}') {
      if (braceDepth > 0) braceDepth--;
      continue;
    }
  }

  return { firstTableIndex, rootKeyMatches };
}

export function scanTomlForRootCompaction(content: string): TomlRootCompactionScan {
  return scanTomlForRootKey(content, 'model_auto_compact_token_limit');
}

export function injectAutoCompactTokenLimit(tomlContent: string, tokenLimit: number): string {
  let content = tomlContent;
  let hasBom = false;
  if (content.startsWith('\uFEFF')) {
    hasBom = true;
    content = content.slice(1);
  }

  const { rootKeyMatches } = scanTomlForRootCompaction(content);

  if (rootKeyMatches.length > 1) {
    throw new Error('CONTAINER_CODEX_CONFIG_AMBIGUOUS_ROOT_COMPACTION');
  }

  let updated: string;
  if (rootKeyMatches.length === 1) {
    const match = rootKeyMatches[0]!;
    const before = content.slice(0, match.lineStartIndex);
    const after = content.slice(match.lineEndIndex);
    updated = `${before}model_auto_compact_token_limit = ${tokenLimit}${after}`;
  } else {
    const prefix = `model_auto_compact_token_limit = ${tokenLimit}\n`;
    updated = `${prefix}${content}`;
  }

  return `${hasBom ? '\uFEFF' : ''}${updated}`;
}

export function injectModelCatalogPath(tomlContent: string, containerCatalogPath: string): string {
  let content = tomlContent;
  let hasBom = false;
  if (content.startsWith('\uFEFF')) {
    hasBom = true;
    content = content.slice(1);
  }

  const { firstTableIndex, rootKeyMatches } = scanTomlForRootKey(content, 'model_catalog_json');

  if (rootKeyMatches.length > 1) {
    throw new Error('CONTAINER_CODEX_CONFIG_AMBIGUOUS_ROOT_CATALOG');
  }

  let updated: string;
  if (rootKeyMatches.length === 1) {
    const match = rootKeyMatches[0]!;
    const before = content.slice(0, match.lineStartIndex);
    const after = content.slice(match.lineEndIndex);
    updated = `${before}model_catalog_json = ${toml(containerCatalogPath)}${after}`;
  } else if (firstTableIndex !== -1) {
    const before = content.slice(0, firstTableIndex);
    const after = content.slice(firstTableIndex);
    updated = `${before}model_catalog_json = ${toml(containerCatalogPath)}\n\n${after}`;
  } else {
    updated = `model_catalog_json = ${toml(containerCatalogPath)}\n${content}`;
  }

  return `${hasBom ? '\uFEFF' : ''}${updated}`;
}

export function parseTomlStringValue(rawRhs: string): string | null {
  const trimmed = rawRhs.trim();
  if (trimmed.startsWith('"')) {
    let escaped = false;
    for (let i = 1; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        const quotedStr = trimmed.slice(0, i + 1);
        const remainder = trimmed.slice(i + 1).trim();
        if (remainder && !remainder.startsWith('#')) {
          return null;
        }
        try {
          return JSON.parse(quotedStr) as string;
        } catch {
          return null;
        }
      }
    }
    return null;
  } else if (trimmed.startsWith("'")) {
    const endIdx = trimmed.indexOf("'", 1);
    if (endIdx === -1) return null;
    const remainder = trimmed.slice(endIdx + 1).trim();
    if (remainder && !remainder.startsWith('#')) {
      return null;
    }
    return trimmed.slice(1, endIdx);
  }
  return null;
}

export function assertNoUnreachableHostCatalog(
  content: string,
  expectedContainerPathOrContainer?: string | ContainerConfig,
): void {
  const { rootKeyMatches } = scanTomlForRootKey(content, 'model_catalog_json');
  if (rootKeyMatches.length > 1) {
    throw new Error('CONTAINER_CODEX_CONFIG_AMBIGUOUS_ROOT_CATALOG');
  }
  if (rootKeyMatches.length === 1) {
    let expectedContainerPath: string | undefined;
    if (typeof expectedContainerPathOrContainer === 'string') {
      expectedContainerPath = expectedContainerPathOrContainer;
    } else if (expectedContainerPathOrContainer && typeof expectedContainerPathOrContainer === 'object') {
      const layout = containerLayout(expectedContainerPathOrContainer);
      expectedContainerPath = joinContainerPath(
        expectedContainerPathOrContainer.platform ?? 'linux',
        layout.codexHome,
        'model-catalog.json',
      );
    }

    if (!expectedContainerPath) {
      throw new Error('CONTAINER_CODEX_CONFIG_UNREACHABLE_HOST_CATALOG');
    }

    const match = rootKeyMatches[0]!;
    const line = content.slice(match.lineStartIndex, match.lineEndIndex);
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) {
      throw new Error('CONTAINER_CODEX_CONFIG_UNREACHABLE_HOST_CATALOG');
    }
    const parsed = parseTomlStringValue(line.slice(eqIdx + 1));
    if (parsed !== expectedContainerPath) {
      throw new Error('CONTAINER_CODEX_CONFIG_UNREACHABLE_HOST_CATALOG');
    }
  }
}

function toml(value: string): string {
  return JSON.stringify(value);
}

function tomlKey(value: string): string {
  return JSON.stringify(value);
}
