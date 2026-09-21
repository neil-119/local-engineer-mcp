import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/domain.js';
import { ImageProfileManager } from '../src/image-profile.js';
import { ContainerRuntime } from '../src/container-runtime.js';

describe('project image profiles', () => {
  it('plans detected Python and pnpm dependencies without guessing a Dockerfile', () => {
    const root = project();
    const manager = new ImageProfileManager(config(root, []), join(root, '.state'));

    const plan = manager.plan(root, 'project-tools');

    expect(plan).toMatchObject({
      supported: true,
      source: 'generated',
      detected: {
        python: { manager: 'requirements', files: ['requirements.txt'] },
        node: { manager: 'pnpm', files: ['package.json', 'pnpm-lock.yaml'], version: '10.20.0' },
      },
      required_domains: ['files.pythonhosted.org', 'pypi.org', 'registry.npmjs.org'],
      missing_read_only_domains: ['files.pythonhosted.org', 'pypi.org', 'registry.npmjs.org'],
    });
    expect(plan.plan_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('builds, registers, resolves, and invalidates an approved plan', async () => {
    const root = project();
    const state = join(root, '.state');
    const calls: string[][] = [];
    const runtime = new ContainerRuntime('docker', async (_executable, arguments_) => {
      calls.push([...arguments_]);
      return {
        exitCode: 0,
        stdout: arguments_[0] === 'image' && arguments_[1] === 'inspect' ? `sha256:${'a'.repeat(64)}\n` : '',
        stderr: '',
      };
    });
    const manager = new ImageProfileManager(
      config(root, ['files.pythonhosted.org', 'pypi.org', 'registry.npmjs.org']),
      state,
      runtime,
    );
    const plan = manager.plan(root, 'project-tools');

    const record = await manager.build(plan, plan.plan_digest);

    expect(record.image_reference).toBe(`sha256:${'a'.repeat(64)}`);
    expect(manager.resolve(root, 'project-tools')).toMatchObject({ plan_digest: plan.plan_digest });
    expect(calls.some((arguments_) => arguments_[0] === 'commit' && arguments_.includes(plan.image_tag))).toBe(true);
    expect(calls.some((arguments_) => arguments_[0] === 'run' && arguments_.includes('--read-only'))).toBe(true);
    expect(calls.some((arguments_) => arguments_.includes('--cap-add') && arguments_.includes('CHOWN'))).toBe(true);
    expect(
      calls.some(
        (arguments_) =>
          arguments_[0] === 'exec' &&
          arguments_.includes('node') &&
          arguments_.some((argument) =>
            argument.includes("writeFileSync('/opt/local-engineer-profile/cargo/src/lib.rs'"),
          ),
      ),
    ).toBe(false);

    writeFileSync(join(root, 'requirements.txt'), 'pytest==8.4.2\n');
    expect(() => manager.resolve(root, 'project-tools')).toThrow('IMAGE_PROFILE_STALE');
  });

  it('fails closed for toolchains outside the generated planner', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'unsupported-profile-'));
    const manager = new ImageProfileManager(config(root, []), join(root, '.state'));

    const plan = manager.plan(root, 'custom-tools');

    expect(plan).toMatchObject({ source: 'generated', supported: false, required_domains: [] });
    await expect(manager.build(plan, plan.plan_digest)).rejects.toThrow('IMAGE_PLAN_UNSUPPORTED');
  });

  it('fails closed instead of building Linux profiles in Windows mode', async () => {
    const root = project();
    const plan = new ImageProfileManager(config(root, []), join(root, '.linux-state')).plan(root, 'project-tools');
    const windowsConfig = config(root, []);
    windowsConfig.container = {
      ...windowsConfig.container,
      platform: 'windows',
      image: 'local-engineer/codex-worker-windows:0.144.6',
      base_image: 'mcr.microsoft.com/windows/servercore:ltsc2025',
      workspace_path: 'C:/workspace',
      worker_user: 'ContainerUser',
    };
    const manager = new ImageProfileManager(windowsConfig, join(root, '.state'));

    expect(() => manager.plan(root, 'project-tools')).toThrow('IMAGE_PROFILE_WINDOWS_UNSUPPORTED');
    expect(() => manager.resolve(root, 'project-tools')).toThrow('IMAGE_PROFILE_WINDOWS_UNSUPPORTED');
    await expect(manager.build(plan, plan.plan_digest)).rejects.toThrow('IMAGE_PROFILE_WINDOWS_UNSUPPORTED');
  });

  it('discovers one direct child project deterministically when the workspace root has no manifest', () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'nested-profile-'));
    const frontend = join(root, 'frontend');
    mkdirSync(frontend);
    writeFileSync(join(frontend, 'package.json'), JSON.stringify({ name: 'frontend', packageManager: 'pnpm@10.20.0' }));
    writeFileSync(join(frontend, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n');

    const plan = new ImageProfileManager(config(root, []), join(root, '.state')).plan(root, 'frontend-tools');

    expect(plan.detected.node).toEqual({
      manager: 'pnpm',
      files: ['frontend/package.json', 'frontend/pnpm-lock.yaml'],
      version: '10.20.0',
    });
    expect(plan.inputs.map((input) => input.path)).toEqual(['frontend/package.json', 'frontend/pnpm-lock.yaml']);
  });

  it('plans locked Cargo dependencies with only the standard crate registry hosts', () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'cargo-profile-'));
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "example"\nversion = "0.1.0"\nedition = "2024"\n');
    writeFileSync(join(root, 'Cargo.lock'), '# This file is automatically @generated by Cargo.\nversion = 4\n');

    const plan = new ImageProfileManager(config(root, []), join(root, '.state')).plan(root, 'rust-tools');

    expect(plan.detected.cargo).toEqual({ manager: 'cargo', files: ['Cargo.toml', 'Cargo.lock'] });
    expect(plan.install_steps).toContain(
      'cargo fetch --locked --manifest-path /opt/local-engineer-profile/cargo/Cargo.toml',
    );
    expect(plan.required_domains).toEqual(['index.crates.io', 'static.crates.io']);
    expect(plan.missing_read_only_domains).toEqual(['index.crates.io', 'static.crates.io']);
  });

  it('adds an empty generated target before fetching a Cargo-only profile', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'cargo-build-profile-'));
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "example"\nversion = "0.1.0"\nedition = "2024"\n');
    writeFileSync(join(root, 'Cargo.lock'), '# This file is automatically @generated by Cargo.\nversion = 4\n');
    const calls: string[][] = [];
    const runtime = new ContainerRuntime('docker', async (_executable, arguments_) => {
      calls.push([...arguments_]);
      return {
        exitCode: 0,
        stdout: arguments_[0] === 'image' && arguments_[1] === 'inspect' ? `sha256:${'b'.repeat(64)}\n` : '',
        stderr: '',
      };
    });
    const manager = new ImageProfileManager(
      config(root, ['index.crates.io', 'static.crates.io']),
      join(root, '.state'),
      runtime,
    );
    const plan = manager.plan(root, 'rust-tools');

    await manager.build(plan, plan.plan_digest);

    const targetWrite = calls.find(
      (arguments_) =>
        arguments_.includes('node') &&
        arguments_.some((argument) =>
          argument.includes("writeFileSync('/opt/local-engineer-profile/cargo/src/lib.rs'"),
        ),
    );
    const fetch = calls.find((arguments_) => arguments_.includes('cargo') && arguments_.includes('fetch'));
    expect(targetWrite).toBeDefined();
    expect(fetch).toBeDefined();
    expect(calls.indexOf(targetWrite!)).toBeLessThan(calls.indexOf(fetch!));
  });
});

function project(): string {
  const root = mkdtempSync(join(testTemporaryDirectory(), 'image-profile-'));
  writeFileSync(join(root, 'requirements.txt'), 'pytest==8.4.1\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'example', packageManager: 'pnpm@10.20.0' }));
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n');
  return root;
}

function config(root: string, allowedDomains: string[]): Config {
  return {
    version: 1,
    server: {
      state_dir: join(root, '.state'),
      max_concurrency: 1,
      default_timeout_seconds: 300,
      max_timeout_seconds: 3600,
      default_wait_timeout_seconds: 300,
      max_wait_timeout_seconds: 300,
      wait_response_reserve_seconds: 2,
      max_wait_ids: 10,
      cancellation_grace_seconds: 1,
      final_result_max_characters_per_run: 6000,
      max_server_log_bytes: 1024,
    },
    security: {
      allowed_roots: [root],
      deny_unc_paths: true,
      deny_path_traversal: true,
      deny_symlink_escape: true,
      allowed_environment_variables: [],
    },
    container: {
      command: 'docker',
      platform: 'linux',
      image: 'local-engineer/codex-worker:0.144.6',
      base_image: 'node:24-bookworm-slim',
      codex_version: '0.144.6',
      workspace_path: '/workspace',
      worker_user: 'codex',
      codex_command: 'codex',
      network: {
        model_domains: ['model-provider.example'],
        read_only_domains: allowedDomains,
        allow_private_model_endpoint: false,
      },
    },
    workers: [
      {
        name: 'local',
        enabled: true,
        harness: 'codex',
        model: 'local-model',
        model_provider: 'local-provider',
        max_concurrency: 1,
        timeout_seconds: 300,
        idle_timeout_seconds: 300,
        container_model_provider: {
          base_url: 'https://model-provider.example/v1',
          wire_api: 'responses',
          requires_openai_auth: false,
        },
      },
    ],
  };
}

function testTemporaryDirectory(): string {
  const path = join(process.cwd(), '.tmp', 'tests');
  mkdirSync(path, { recursive: true });
  return path;
}
