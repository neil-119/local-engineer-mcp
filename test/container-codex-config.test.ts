import { describe, expect, it } from 'vitest';
import {
  generatedProxyConfig,
  generatedWorkerConfig,
  validateCustomCodexConfig,
} from '../src/container-codex-config.js';
import type { ContainerConfig, Worker } from '../src/domain.js';

const worker: Worker = {
  name: 'container-worker',
  enabled: true,
  harness: 'codex',
  model: 'local-model',
  model_provider: 'spark',
  max_concurrency: 1,
  timeout_seconds: 60,
  idle_timeout_seconds: 60,
  container_model_provider: {
    base_url: 'https://model.example/v1',
    wire_api: 'responses',
    api_key_environment_variable: 'MODEL_API_KEY',
    requires_openai_auth: false,
  },
};

const container: ContainerConfig = {
  command: 'docker',
  image: 'local-engineer/worker:latest',
  base_image: 'node:24-bookworm-slim',
  codex_version: '0.144.6',
  workspace_path: '/workspace',
  worker_user: 'codex',
  codex_command: 'codex',
  network: {
    model_domains: ['model.example'],
    read_only_domains: ['registry.npmjs.org'],
    allow_private_model_endpoint: false,
  },
};

describe('container Codex configuration', () => {
  it('generates a minimal autonomous worker config without MCP registrations', () => {
    const config = generatedWorkerConfig(worker);
    expect(config).toContain('approval_policy = "never"');
    expect(config).toContain('sandbox_mode = "danger-full-access"');
    expect(config).toContain('base_url = "http://local-engineer-proxy:8090/v1"');
    expect(config).toContain('env_key = "MODEL_API_KEY"');
    expect(config).not.toMatch(/mcp_servers|hooks|plugins/i);
  });

  it('generates a limited sidecar policy for dependency domains', () => {
    const config = generatedProxyConfig(container);
    expect(config).toContain('[network]');
    expect(config).toContain('[network.domains]');
    expect(config).toContain('proxy_url = "http://0.0.0.0:3128"');
    expect(config).toContain('dangerously_allow_non_loopback_proxy = true');
    expect(config).toContain('mode = "limited"');
    expect(config).toContain('mitm = true');
    expect(config).toContain('"registry.npmjs.org" = "allow"');
    expect(config).not.toContain('"model.example" = "allow"');
    expect(config).toContain('allow_local_binding = false');
  });

  it('rejects custom configs that could restore worker-to-parent communication', () => {
    expect(() => validateCustomCodexConfig('[mcp_servers.parent]\ncommand = "parent-mcp"')).toThrow(
      'CONTAINER_CODEX_CONFIG_UNSAFE',
    );
    expect(() => validateCustomCodexConfig('[hooks]\nafter_tool = "notify-parent"')).toThrow(
      'CONTAINER_CODEX_CONFIG_UNSAFE',
    );
  });
});
