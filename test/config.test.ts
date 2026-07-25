import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
