import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('container network configuration', () => {
  it('accepts disjoint model and read-only domains', () => {
    const fixture = configFixture(true);
    const config = loadConfig(fixture.path);

    expect(config.container.network).toEqual({
      model_domains: ['192.168.10.20'],
      read_only_domains: ['registry.npmjs.org'],
      allow_private_model_endpoint: true,
    });
  });

  it('rejects domain overlap and private model endpoints without opt-in', () => {
    const privateDisabled = configFixture(false);
    expect(() => loadConfig(privateDisabled.path)).toThrow('CONFIG_CONTAINER_PRIVATE_MODEL_ENDPOINT_DISABLED');

    const overlap = configFixture(true, ['192.168.10.20']);
    expect(() => loadConfig(overlap.path)).toThrow('CONFIG_CONTAINER_NETWORK_DOMAIN_OVERLAP');
  });

  it('requires ContainerUser and an absolute Windows path for Windows containers', () => {
    const fixture = configFixture(true);
    const text = readFileSync(fixture.path, 'utf8')
      .replace('  command: docker', '  command: docker\n  platform: windows')
      .replace('  workspace_path: /workspace', '  workspace_path: C:/workspace')
      .replace('  worker_user: codex', '  worker_user: ContainerUser');
    writeFileSync(fixture.path, text);
    expect(loadConfig(fixture.path).container).toMatchObject({
      platform: 'windows',
      workspace_path: 'C:/workspace',
      worker_user: 'ContainerUser',
      windows_memory_limit: '4g',
      windows_cpu_count: 2,
    });

    writeFileSync(fixture.path, text.replace('worker_user: ContainerUser', 'worker_user: ContainerAdministrator'));
    expect(() => loadConfig(fixture.path)).toThrow();

    writeFileSync(fixture.path, text.replace('workspace_path: C:/workspace', 'workspace_path: C:/workspace,readonly'));
    expect(() => loadConfig(fixture.path)).toThrow();

    writeFileSync(
      fixture.path,
      text.replace('workspace_path: C:/workspace', 'workspace_path: C:/workspace/../Windows'),
    );
    expect(() => loadConfig(fixture.path)).toThrow();
  });
});

function configFixture(allowPrivate: boolean, readOnlyDomains = ['registry.npmjs.org']) {
  const root = mkdtempSync(join(testTemporaryDirectory(), 'config-'));
  const path = join(root, 'config.yaml');
  writeFileSync(
    path,
    [
      'version: 1',
      'server:',
      `  state_dir: ${yaml(root)}`,
      'security:',
      `  allowed_roots: [${yaml(root)}]`,
      'container:',
      '  command: docker',
      '  image: local-engineer/worker:test',
      '  base_image: node:24-bookworm-slim',
      '  workspace_path: /workspace',
      '  worker_user: codex',
      '  codex_command: codex',
      '  network:',
      '    model_domains: [192.168.10.20]',
      `    read_only_domains: [${readOnlyDomains.join(', ')}]`,
      `    allow_private_model_endpoint: ${allowPrivate}`,
      'workers:',
      '  - name: local',
      '    enabled: true',
      '    harness: codex',
      '    model: local-model',
      '    model_provider: local-provider',
      '    max_concurrency: 1',
      '    timeout_seconds: 300',
      '    container_model_provider:',
      '      base_url: http://192.168.10.20:8000/v1',
      '      wire_api: responses',
      '      requires_openai_auth: false',
      '',
    ].join('\n'),
  );
  return { path };
}

function yaml(value: string): string {
  return JSON.stringify(value);
}

function testTemporaryDirectory(): string {
  const path = join(process.cwd(), '.tmp', 'tests');
  mkdirSync(path, { recursive: true });
  return path;
}
