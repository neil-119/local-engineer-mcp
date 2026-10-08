import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertNoUnreachableHostCatalog,
  generatedFileToolsConfig,
  generatedProxyConfig,
  generatedWorkerConfig,
  injectAutoCompactTokenLimit,
  injectModelCatalogPath,
  scanTomlForRootKey,
  validateCustomCodexConfig,
  writeContainerCodexConfigs,
} from '../src/container-codex-config.js';
import { validateAndReadModelCatalog } from '../src/config.js';
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
  platform: 'linux',
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
  it('generates an autonomous worker config with internal container file tools MCP registration', () => {
    const config = generatedWorkerConfig(worker, container);
    expect(config).toContain('approval_policy = "never"');
    expect(config).toContain('sandbox_mode = "danger-full-access"');
    expect(config).toContain('base_url = "http://local-engineer-proxy:8090/v1"');
    expect(config).toContain('env_key = "MODEL_API_KEY"');
    expect(config).toContain('[mcp_servers.file_tools]');
    expect(config).toContain('command = "/usr/local/bin/node"');
    expect(config).toContain('"/usr/local/lib/local-engineer/file-tools-server.mjs"');
    expect(config).not.toMatch(/hooks|plugins/i);
  });

  it('generates exact immutable paths for Linux and Windows file tools MCP servers', () => {
    const linuxConfig = generatedFileToolsConfig(container, [{ containerPath: '/workspace', access: 'read-write' }]);
    expect(linuxConfig).toContain('command = "/usr/local/bin/node"');
    expect(linuxConfig).toContain('"/usr/local/lib/local-engineer/file-tools-server.mjs"');

    const windowsContainer: ContainerConfig = { ...container, platform: 'windows', workspace_path: 'C:/workspace' };
    const windowsConfig = generatedFileToolsConfig(windowsContainer, [
      { containerPath: 'C:/workspace', access: 'read-write' },
    ]);
    expect(windowsConfig).toContain('command = "C:/Node/node.exe"');
    expect(windowsConfig).toContain('"C:/local-engineer/file-tools-server.mjs"');
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

  it('binds both Windows proxy listeners only to the dedicated private address', () => {
    const windows = { ...container, platform: 'windows' as const };
    const config = generatedProxyConfig(windows, '10.240.20.2');
    expect(config).toContain('proxy_url = "http://10.240.20.2:3128"');
    expect(config).toContain('socks_url = "http://10.240.20.2:8081"');
    expect(config).not.toContain('0.0.0.0');
    expect(() => generatedProxyConfig(windows)).toThrow('CONTAINER_PROXY_BIND_ADDRESS_INVALID');
    expect(() => generatedProxyConfig(windows, '172.28.32.42')).toThrow('CONTAINER_PROXY_BIND_ADDRESS_INVALID');
  });

  it('rejects custom configs that could restore worker-to-parent communication', () => {
    expect(() => validateCustomCodexConfig('[mcp_servers.parent]\ncommand = "parent-mcp"')).toThrow(
      'CONTAINER_CODEX_CONFIG_UNSAFE',
    );
    expect(() => validateCustomCodexConfig('[hooks]\nafter_tool = "notify-parent"')).toThrow(
      'CONTAINER_CODEX_CONFIG_UNSAFE',
    );
  });

  it('generates file tools config with --ro and --rw flags for workspace mounts', () => {
    const config = generatedFileToolsConfig(container, [
      { containerPath: '/workspace/main', access: 'read-write' },
      { containerPath: '/workspace/secondary', access: 'read-only' },
      '/workspace/string-path',
    ]);

    expect(config).toContain('[mcp_servers.file_tools]');
    expect(config).toContain('command = "/usr/local/bin/node"');
    expect(config).toContain('"--rw", "/workspace/main"');
    expect(config).toContain('"--ro", "/workspace/secondary"');
    expect(config).toContain('"--rw", "/workspace/string-path"');
  });

  it('appends generated file tools config to custom codex configuration', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'codex-custom-cfg-'));
    try {
      const customPath = join(tempDir, 'custom.toml');
      writeFileSync(customPath, 'model = "custom-model"\napproval_policy = "never"\n', 'utf8');

      const workerWithCustom = {
        ...worker,
        container_codex_config_file: customPath,
      };

      const outWorkerCfg = join(tempDir, 'worker-config.toml');
      const outProxyCfg = join(tempDir, 'proxy-config.toml');

      writeContainerCodexConfigs(workerWithCustom, container, outWorkerCfg, outProxyCfg, undefined, [
        { containerPath: '/workspace', access: 'read-write' },
      ]);

      const contents = readFileSync(outWorkerCfg, 'utf8');
      expect(contents).toContain('model = "custom-model"');
      expect(contents).toContain('[mcp_servers.file_tools]');
      expect(contents).toContain('"--rw", "/workspace"');
    } finally {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('includes auto_compact_token_limit when configured on worker', () => {
    const workerWithCompaction = {
      ...worker,
      auto_compact_token_limit: 120000,
    };
    const config = generatedWorkerConfig(workerWithCompaction, container);
    expect(config).toContain('model_auto_compact_token_limit = 120000');
    expect(config).not.toContain('model_post_turn_compact_threshold_percent');
  });

  it('safely injects auto_compact_token_limit at root level in custom codex configs', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'codex-custom-compact-'));
    try {
      const customPath = join(tempDir, 'custom.toml');
      writeFileSync(
        customPath,
        ['model = "custom-model"', 'approval_policy = "never"', '', '[features]', 'custom_feat = true', ''].join('\n'),
        'utf8',
      );

      const workerWithCustomAndCompaction = {
        ...worker,
        container_codex_config_file: customPath,
        auto_compact_token_limit: 120000,
      };

      const outWorkerCfg = join(tempDir, 'worker-config.toml');
      const outProxyCfg = join(tempDir, 'proxy-config.toml');

      writeContainerCodexConfigs(workerWithCustomAndCompaction, container, outWorkerCfg, outProxyCfg, undefined, [
        { containerPath: '/workspace', access: 'read-write' },
      ]);

      const contents = readFileSync(outWorkerCfg, 'utf8');
      expect(contents).toContain('model_auto_compact_token_limit = 120000');
      // Verify model_auto_compact_token_limit appears before the first table [features]
      const compactIndex = contents.indexOf('model_auto_compact_token_limit = 120000');
      const tableIndex = contents.indexOf('[features]');
      expect(compactIndex).toBeLessThan(tableIndex);
      expect(contents).toContain('[mcp_servers.file_tools]');
    } finally {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('replaces existing auto_compact_token_limit without duplicate keys in custom configs', () => {
    const original = 'model_auto_compact_token_limit = 50000\nmodel = "custom-model"\n[features]\nfeat = true';
    const updated = injectAutoCompactTokenLimit(original, 120000);
    expect(updated).toContain('model_auto_compact_token_limit = 120000');
    expect(updated).not.toContain('50000');
    const occurrences = (updated.match(/model_auto_compact_token_limit/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it('leaves table-scoped keys untouched and injects at root table', () => {
    const original = '[some_table]\nmodel_auto_compact_token_limit = 42\n';
    const updated = injectAutoCompactTokenLimit(original, 120000);
    expect(updated.startsWith('model_auto_compact_token_limit = 120000\n')).toBe(true);
    expect(updated).toContain('[some_table]\nmodel_auto_compact_token_limit = 42');
  });

  it('replaces quoted root keys', () => {
    const doubleQuoted = '"model_auto_compact_token_limit" = 50000\nmodel = "test"';
    expect(injectAutoCompactTokenLimit(doubleQuoted, 120000)).toBe(
      'model_auto_compact_token_limit = 120000\nmodel = "test"',
    );

    const singleQuoted = '\'model_auto_compact_token_limit\' = 50000\nmodel = "test"';
    expect(injectAutoCompactTokenLimit(singleQuoted, 120000)).toBe(
      'model_auto_compact_token_limit = 120000\nmodel = "test"',
    );
  });

  it('preserves UTF-8 BOM when injecting auto_compact_token_limit', () => {
    const originalWithBom = '\uFEFFmodel = "test"\n';
    const updated = injectAutoCompactTokenLimit(originalWithBom, 120000);
    expect(updated.startsWith('\uFEFFmodel_auto_compact_token_limit = 120000\n')).toBe(true);
    expect(updated).toContain('model = "test"');
  });

  it('throws CONTAINER_CODEX_CONFIG_AMBIGUOUS_ROOT_COMPACTION on duplicate root definitions', () => {
    const duplicateRoot =
      'model_auto_compact_token_limit = 50000\nmodel_auto_compact_token_limit = 60000\nmodel = "test"';
    expect(() => injectAutoCompactTokenLimit(duplicateRoot, 120000)).toThrow(
      'CONTAINER_CODEX_CONFIG_AMBIGUOUS_ROOT_COMPACTION',
    );
  });

  it('correctly parses multiline basic strings (triple-double) containing table-like content before root key', () => {
    const original = [
      'multiline_basic = """',
      '[not_a_table]',
      'inner = "value"',
      '"""',
      'model_auto_compact_token_limit = 50000',
      'model = "custom-model"',
    ].join('\n');

    const updated = injectAutoCompactTokenLimit(original, 120000);
    expect(updated).toContain('model_auto_compact_token_limit = 120000');
    expect(updated).not.toContain('50000');
    const occurrences = (updated.match(/model_auto_compact_token_limit/g) || []).length;
    expect(occurrences).toBe(1);
    expect(updated).toContain('[not_a_table]');
  });

  it('correctly parses multiline literal strings (triple-single) containing table-like content before root key', () => {
    const original = [
      "multiline_literal = '''",
      '[not_a_table]',
      "inner = 'value'",
      "'''",
      'model_auto_compact_token_limit = 50000',
      'model = "custom-model"',
    ].join('\n');

    const updated = injectAutoCompactTokenLimit(original, 120000);
    expect(updated).toContain('model_auto_compact_token_limit = 120000');
    expect(updated).not.toContain('50000');
    const occurrences = (updated.match(/model_auto_compact_token_limit/g) || []).length;
    expect(occurrences).toBe(1);
    expect(updated).toContain('[not_a_table]');
  });

  it('validates custom config with multiline strings and injected compaction against real Codex strict parser', () => {
    const codexBinary =
      process.platform === 'win32' && process.env.APPDATA
        ? join(
            process.env.APPDATA,
            'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
          )
        : undefined;

    if (!codexBinary || !existsSync(codexBinary)) return;

    const tempDir = mkdtempSync(join(tmpdir(), 'codex-strict-custom-multiline-'));
    try {
      const customToml = [
        'developer_instructions = """',
        '[not_a_table]',
        'focus = "correctness"',
        '"""',
        'model = "custom-model"',
        'model_auto_compact_token_limit = 50000',
      ].join('\n');

      const customPath = join(tempDir, 'custom.toml');
      writeFileSync(customPath, customToml, 'utf8');

      const workerWithCustom = {
        ...worker,
        container_codex_config_file: customPath,
        auto_compact_token_limit: 120000,
      };

      const outWorkerCfg = join(tempDir, 'worker-config.toml');
      const outProxyCfg = join(tempDir, 'proxy-config.toml');
      writeContainerCodexConfigs(workerWithCustom, container, outWorkerCfg, outProxyCfg, undefined, [
        { containerPath: '/workspace', access: 'read-write' },
      ]);

      const contents = readFileSync(outWorkerCfg, 'utf8');
      expect(contents).toContain('model_auto_compact_token_limit = 120000');
      expect((contents.match(/model_auto_compact_token_limit/g) || []).length).toBe(1);

      // Validate with real codex --strict-config
      writeFileSync(join(tempDir, 'config.toml'), contents, 'utf8');
      const result = spawnSync(codexBinary, ['--strict-config', 'app-server', '--listen', 'stdio://'], {
        env: { ...process.env, CODEX_HOME: tempDir },
        input: '',
        encoding: 'utf8',
      });
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      expect(output).not.toContain('unknown configuration field');
      expect(output).not.toContain('duplicate key');
    } finally {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('validates generated worker configuration against real Codex strict parser when available', () => {
    const codexBinary =
      process.platform === 'win32' && process.env.APPDATA
        ? join(
            process.env.APPDATA,
            'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
          )
        : undefined;

    if (!codexBinary || !existsSync(codexBinary)) return;

    const tempDir = mkdtempSync(join(tmpdir(), 'codex-strict-validate-'));
    try {
      const workerWithCompaction = {
        ...worker,
        auto_compact_token_limit: 120000,
      };
      const validConfig = generatedWorkerConfig(workerWithCompaction, container);
      writeFileSync(join(tempDir, 'config.toml'), validConfig, 'utf8');

      // Valid config must pass strict-config parsing without unknown configuration field errors
      const validResult = spawnSync(codexBinary, ['--strict-config', 'app-server', '--listen', 'stdio://'], {
        env: { ...process.env, CODEX_HOME: tempDir },
        input: '',
        encoding: 'utf8',
      });
      const validOutput = `${validResult.stdout ?? ''}\n${validResult.stderr ?? ''}`;
      expect(validOutput).not.toContain('unknown configuration field');

      // Injected unknown field must fail closed under --strict-config
      writeFileSync(
        join(tempDir, 'config.toml'),
        `model_post_turn_compact_threshold_percent = 70\n${validConfig}`,
        'utf8',
      );
      const invalidResult = spawnSync(codexBinary, ['--strict-config', 'app-server', '--listen', 'stdio://'], {
        env: { ...process.env, CODEX_HOME: tempDir },
        input: '',
        encoding: 'utf8',
      });
      const invalidOutput = `${invalidResult.stdout ?? ''}\n${invalidResult.stderr ?? ''}`;
      expect(invalidOutput).toContain('unknown configuration field `model_post_turn_compact_threshold_percent`');
    } finally {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  describe('model catalog validation and TOML injection', () => {
    it('validates and reads a valid model catalog file matching worker model', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'catalog-val-'));
      try {
        const catalogPath = join(tempDir, 'catalog.json');
        const catalogData = {
          models: [
            {
              slug: 'test-model',
              display_name: 'Test Model',
              apply_patch_tool_type: 'function',
              supports_parallel_tool_calls: false,
              context_window: 128000,
              max_context_window: 128000,
              auto_compact_token_limit: 100000,
              tool_mode: 'direct',
            },
          ],
        };
        writeFileSync(catalogPath, JSON.stringify(catalogData), 'utf8');
        const result = validateAndReadModelCatalog(catalogPath, 'test-model');
        expect(result.matchedModel.slug).toBe('test-model');
        expect(JSON.parse(result.contents).models[0].slug).toBe('test-model');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('rejects relative path, missing file, directory, or invalid JSON', () => {
      expect(() => validateAndReadModelCatalog('relative/path.json', 'test-model')).toThrow(
        'CONFIG_MODEL_CATALOG_NOT_ABSOLUTE',
      );

      const tempDir = mkdtempSync(join(tmpdir(), 'catalog-val-err-'));
      try {
        expect(() => validateAndReadModelCatalog(join(tempDir, 'missing.json'), 'test-model')).toThrow(
          'CONFIG_MODEL_CATALOG_NOT_FOUND',
        );

        expect(() => validateAndReadModelCatalog(tempDir, 'test-model')).toThrow(
          'CONFIG_MODEL_CATALOG_NOT_REGULAR_FILE',
        );

        const badJsonPath = join(tempDir, 'bad.json');
        writeFileSync(badJsonPath, '{ not valid json', 'utf8');
        expect(() => validateAndReadModelCatalog(badJsonPath, 'test-model')).toThrow(
          /CONFIG_MODEL_CATALOG_INVALID_JSON/,
        );

        const noModelsPath = join(tempDir, 'no-models.json');
        writeFileSync(noModelsPath, '{"foo": "bar"}', 'utf8');
        expect(() => validateAndReadModelCatalog(noModelsPath, 'test-model')).toThrow(
          'CONFIG_MODEL_CATALOG_MISSING_MODELS',
        );
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('rejects catalog when model is missing, duplicated, or has invalid capabilities', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'catalog-val-caps-'));
      try {
        const notFoundPath = join(tempDir, 'not-found.json');
        writeFileSync(notFoundPath, JSON.stringify({ models: [{ slug: 'other-model' }] }), 'utf8');
        expect(() => validateAndReadModelCatalog(notFoundPath, 'test-model')).toThrow(
          'CONFIG_MODEL_CATALOG_MODEL_NOT_FOUND:test-model',
        );

        const dupPath = join(tempDir, 'duplicate.json');
        writeFileSync(dupPath, JSON.stringify({ models: [{ slug: 'test-model' }, { slug: 'test-model' }] }), 'utf8');
        expect(() => validateAndReadModelCatalog(dupPath, 'test-model')).toThrow(
          'CONFIG_MODEL_CATALOG_DUPLICATE_MODEL:test-model',
        );

        const badPatchPath = join(tempDir, 'bad-patch.json');
        writeFileSync(
          badPatchPath,
          JSON.stringify({ models: [{ slug: 'test-model', apply_patch_tool_type: 'unsupported' }] }),
          'utf8',
        );
        expect(() => validateAndReadModelCatalog(badPatchPath, 'test-model')).toThrow(
          'CONFIG_MODEL_CATALOG_INVALID_APPLY_PATCH:test-model',
        );

        const badParallelPath = join(tempDir, 'bad-parallel.json');
        writeFileSync(
          badParallelPath,
          JSON.stringify({ models: [{ slug: 'test-model', supports_parallel_tool_calls: 'not-a-bool' }] }),
          'utf8',
        );
        expect(() => validateAndReadModelCatalog(badParallelPath, 'test-model')).toThrow(
          'CONFIG_MODEL_CATALOG_INVALID_PARALLEL_TOOL_CALLS:test-model',
        );
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('injects model_catalog_json at root before first table or at beginning', () => {
      const tomlWithTable = '# comment\n[section]\nkey = "val"\n';
      const injected1 = injectModelCatalogPath(tomlWithTable, '/container/catalog.json');
      expect(injected1).toContain('model_catalog_json = "/container/catalog.json"\n\n[section]');

      const tomlNoTable = 'model = "test"\n';
      const injected2 = injectModelCatalogPath(tomlNoTable, '/container/catalog.json');
      expect(injected2).toBe('model_catalog_json = "/container/catalog.json"\nmodel = "test"\n');
    });

    it('rewrites existing root model_catalog_json assignment and preserves custom TOML', () => {
      const tomlExisting = 'model = "test"\nmodel_catalog_json = "C:/old/host/catalog.json"\n\n[table]\nfoo = "bar"\n';
      const rewritten = injectModelCatalogPath(tomlExisting, '/container/catalog.json');
      expect(rewritten).toContain('model_catalog_json = "/container/catalog.json"');
      expect(rewritten).not.toContain('C:/old/host/catalog.json');
      expect(rewritten).toContain('[table]\nfoo = "bar"');
    });

    it('ignores comments, basic strings, multiline strings, and nested tables containing model_catalog_json', () => {
      const tomlTricky = [
        '# model_catalog_json = "C:/ignored/comment.json"',
        'instruction = "Use model_catalog_json = \\"foo\\""',
        'ml_basic = """',
        'model_catalog_json = "inside multiline"',
        '"""',
        "ml_literal = '''",
        'model_catalog_json = "inside literal"',
        "'''",
        '[nested_table]',
        'model_catalog_json = "/nested/table/key"',
      ].join('\n');

      const scan = scanTomlForRootKey(tomlTricky, 'model_catalog_json');
      expect(scan.rootKeyMatches).toHaveLength(0);

      const injected = injectModelCatalogPath(tomlTricky, '/container/catalog.json');
      expect(injected).toContain('model_catalog_json = "/container/catalog.json"\n\n[nested_table]');
      expect(injected).toContain('[nested_table]\nmodel_catalog_json = "/nested/table/key"');
    });

    it('rejects ambiguous duplicate root model_catalog_json declarations', () => {
      const tomlDuplicate = 'model_catalog_json = "cat1"\nmodel_catalog_json = "cat2"\n[table]';
      expect(() => injectModelCatalogPath(tomlDuplicate, '/container/catalog.json')).toThrow(
        'CONTAINER_CODEX_CONFIG_AMBIGUOUS_ROOT_CATALOG',
      );
    });

    it('assertNoUnreachableHostCatalog rejects unreachable and unprovisioned catalog paths', () => {
      const unreachableHostToml = 'model_catalog_json = "C:/Users/example/host.json"\n[table]';
      expect(() => assertNoUnreachableHostCatalog(unreachableHostToml, container)).toThrow(
        'CONTAINER_CODEX_CONFIG_UNREACHABLE_HOST_CATALOG',
      );

      // Without explicit provided catalog, reject root references you cannot actually provision
      expect(() => assertNoUnreachableHostCatalog(unreachableHostToml)).toThrow(
        'CONTAINER_CODEX_CONFIG_UNREACHABLE_HOST_CATALOG',
      );
      const anyCatalogToml = 'model_catalog_json = "/home/codex/.codex/model-catalog.json"\n[table]';
      expect(() => assertNoUnreachableHostCatalog(anyCatalogToml)).toThrow(
        'CONTAINER_CODEX_CONFIG_UNREACHABLE_HOST_CATALOG',
      );

      // Rejects substring tricks and trailing garbage
      const subpathToml = 'model_catalog_json = "/home/codex/.codex/model-catalog.json/nested"\n[table]';
      expect(() => assertNoUnreachableHostCatalog(subpathToml, container)).toThrow(
        'CONTAINER_CODEX_CONFIG_UNREACHABLE_HOST_CATALOG',
      );
      const garbageToml = 'model_catalog_json = "/home/codex/.codex/model-catalog.json" trailing_garbage\n[table]';
      expect(() => assertNoUnreachableHostCatalog(garbageToml, container)).toThrow(
        'CONTAINER_CODEX_CONFIG_UNREACHABLE_HOST_CATALOG',
      );

      // Accepts exact match with inline comments or single quotes
      const commentToml = 'model_catalog_json = "/home/codex/.codex/model-catalog.json" # valid comment\n[table]';
      expect(() => assertNoUnreachableHostCatalog(commentToml, container)).not.toThrow();
      const singleQuoteToml = "model_catalog_json = '/home/codex/.codex/model-catalog.json'\n[table]";
      expect(() => assertNoUnreachableHostCatalog(singleQuoteToml, container)).not.toThrow();

      // Config without catalog passes cleanly
      const noCatalogToml = 'model = "foo"\n[table]';
      expect(() => assertNoUnreachableHostCatalog(noCatalogToml, container)).not.toThrow();
      expect(() => assertNoUnreachableHostCatalog(noCatalogToml)).not.toThrow();

      // Table-scoped key is not root, so passes
      const tableScopedToml = '[table]\nmodel_catalog_json = "/somewhere"';
      expect(() => assertNoUnreachableHostCatalog(tableScopedToml)).not.toThrow();
    });

    it('writeContainerCodexConfigs provisions validated catalog and injects into config', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'write-catalog-'));
      try {
        const catalogSource = join(tempDir, 'host-catalog.json');
        writeFileSync(
          catalogSource,
          JSON.stringify({
            models: [
              {
                slug: 'local-model',
                apply_patch_tool_type: 'function',
                supports_parallel_tool_calls: false,
              },
            ],
          }),
          'utf8',
        );

        const workerWithCatalog: Worker = {
          ...worker,
          model_catalog_json_file: catalogSource,
        };

        const workerConfigPath = join(tempDir, 'worker-config.toml');
        const proxyConfigPath = join(tempDir, 'proxy-config.toml');

        const paths = writeContainerCodexConfigs(workerWithCatalog, container, workerConfigPath, proxyConfigPath);
        expect(paths.modelCatalogPath).toBe(join(tempDir, 'model-catalog.json'));
        expect(existsSync(paths.modelCatalogPath!)).toBe(true);

        const workerToml = readFileSync(workerConfigPath, 'utf8');
        expect(workerToml).toContain('model_catalog_json = "/home/codex/.codex/model-catalog.json"');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
