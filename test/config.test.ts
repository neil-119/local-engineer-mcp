import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, validateAndReadModelCatalog } from '../src/config.js';

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

  it('validates wire_api_compatibility and reserved container environment', () => {
    const fixture = configFixture(true);
    const text = readFileSync(fixture.path, 'utf8');

    // flatten_namespaces with responses wire_api succeeds
    writeFileSync(
      fixture.path,
      text.replace(
        '      requires_openai_auth: false',
        '      requires_openai_auth: false\n      wire_api_compatibility: flatten_namespaces',
      ),
    );
    const config = loadConfig(fixture.path);
    expect(config.workers[0]?.container_model_provider?.wire_api_compatibility).toBe('flatten_namespaces');

    // flatten_namespaces with chat wire_api must fail
    writeFileSync(
      fixture.path,
      text
        .replace('wire_api: responses', 'wire_api: chat')
        .replace(
          '      requires_openai_auth: false',
          '      requires_openai_auth: false\n      wire_api_compatibility: flatten_namespaces',
        ),
    );
    expect(() => loadConfig(fixture.path)).toThrow('CONFIG_WIRE_API_COMPATIBILITY_INVALID');

    // Reserved environment variable LOCAL_ENGINEER_RESPONSES_COMPATIBILITY in worker environment must fail
    writeFileSync(
      fixture.path,
      text + '\n    environment:\n      LOCAL_ENGINEER_RESPONSES_COMPATIBILITY: flatten_namespaces\n',
    );
    expect(() => loadConfig(fixture.path)).toThrow('CONFIG_CONTAINER_RESERVED_ENVIRONMENT');
  });

  describe('validateAndReadModelCatalog', () => {
    it('validates and reads valid catalog with capabilities including supports_search_tool', () => {
      const root = mkdtempSync(join(testTemporaryDirectory(), 'catalog-'));
      const catPath = join(root, 'catalog.json');
      writeFileSync(
        catPath,
        JSON.stringify({
          models: [
            {
              slug: 'glm-5.3-flash',
              apply_patch_tool_type: 'function',
              supports_parallel_tool_calls: true,
              supports_search_tool: false,
              context_window: 131072,
              max_context_window: 131072,
              auto_compact_token_limit: 120000,
              tool_mode: 'direct',
              web_search_tool_type: 'function',
            },
          ],
        }),
      );

      const result = validateAndReadModelCatalog(catPath, 'glm-5.3-flash');
      expect(result.matchedModel.slug).toBe('glm-5.3-flash');
      expect(result.matchedModel.supports_search_tool).toBe(false);
      expect(result.matchedModel.apply_patch_tool_type).toBe('function');
    });

    it('rejects relative path or non-existent file', () => {
      expect(() => validateAndReadModelCatalog('relative/cat.json', 'model')).toThrow(
        'CONFIG_MODEL_CATALOG_NOT_ABSOLUTE',
      );
      const root = mkdtempSync(join(testTemporaryDirectory(), 'catalog-'));
      expect(() => validateAndReadModelCatalog(join(root, 'missing.json'), 'model')).toThrow(
        'CONFIG_MODEL_CATALOG_NOT_FOUND',
      );
    });

    it('rejects directories and non-regular files', () => {
      const root = mkdtempSync(join(testTemporaryDirectory(), 'catalog-'));
      expect(() => validateAndReadModelCatalog(root, 'model')).toThrow('CONFIG_MODEL_CATALOG_NOT_REGULAR_FILE');
    });

    it('rejects files exceeding maximumBytes (bounded read)', () => {
      const root = mkdtempSync(join(testTemporaryDirectory(), 'catalog-'));
      const catPath = join(root, 'large.json');
      writeFileSync(catPath, ' '.repeat(100));
      expect(() => validateAndReadModelCatalog(catPath, 'model', 50)).toThrow('CONFIG_MODEL_CATALOG_TOO_LARGE');
    });

    it('rejects invalid JSON and missing models array', () => {
      const root = mkdtempSync(join(testTemporaryDirectory(), 'catalog-'));
      const catPath = join(root, 'bad.json');
      writeFileSync(catPath, '{ bad json');
      expect(() => validateAndReadModelCatalog(catPath, 'model')).toThrow(/CONFIG_MODEL_CATALOG_INVALID_JSON/);

      writeFileSync(catPath, JSON.stringify({ not_models: [] }));
      expect(() => validateAndReadModelCatalog(catPath, 'model')).toThrow('CONFIG_MODEL_CATALOG_MISSING_MODELS');
    });

    it('rejects invalid capability flag schema', () => {
      const root = mkdtempSync(join(testTemporaryDirectory(), 'catalog-'));
      const catPath = join(root, 'bad-caps.json');
      writeFileSync(
        catPath,
        JSON.stringify({
          models: [{ slug: 'test-model', supports_search_tool: 'not-a-boolean' }],
        }),
      );
      expect(() => validateAndReadModelCatalog(catPath, 'test-model')).toThrow(
        'CONFIG_MODEL_CATALOG_INVALID_SEARCH_TOOL:test-model',
      );

      writeFileSync(
        catPath,
        JSON.stringify({
          models: [{ slug: 'test-model', apply_patch_tool_type: 'invalid_mode' }],
        }),
      );
      expect(() => validateAndReadModelCatalog(catPath, 'test-model')).toThrow(
        'CONFIG_MODEL_CATALOG_INVALID_APPLY_PATCH:test-model',
      );
    });

    it('rejects missing model or duplicate model slug', () => {
      const root = mkdtempSync(join(testTemporaryDirectory(), 'catalog-'));
      const catPath = join(root, 'models.json');
      writeFileSync(
        catPath,
        JSON.stringify({
          models: [{ slug: 'model-a' }],
        }),
      );
      expect(() => validateAndReadModelCatalog(catPath, 'model-b')).toThrow(
        'CONFIG_MODEL_CATALOG_MODEL_NOT_FOUND:model-b',
      );

      writeFileSync(
        catPath,
        JSON.stringify({
          models: [{ slug: 'model-a' }, { slug: 'model-a' }],
        }),
      );
      expect(() => validateAndReadModelCatalog(catPath, 'model-a')).toThrow(
        'CONFIG_MODEL_CATALOG_DUPLICATE_MODEL:model-a',
      );
    });
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
