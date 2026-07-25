import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContainerAgentManager, type ContainerAgentResources } from '../src/container-agent.js';
import { ContainerRuntime, type RuntimeCommandExecutor } from '../src/container-runtime.js';
import type { ContainerConfig, RunRepository, Worker } from '../src/domain.js';

describe('container agent workspace seeding', () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it('passes an unquoted, TOML-safe model-provider path to the Codex override', () => {
    const manager = new ContainerAgentManager(containerConfig(), testTemporaryDirectory());
    const appServer = manager.appServerWorker(worker(), {
      agentId: 'agt_override',
      image: 'worker:test',
      workerContainer: 'le-override-worker',
      proxyContainer: 'le-override-proxy',
      internalNetwork: 'le-override-internal',
      egressNetwork: 'le-override-egress',
      workspaceVolume: 'le-override-workspace',
      workerConfigVolume: 'le-override-worker-config',
      proxyConfigVolume: 'le-override-proxy-config',
      proxySharedVolume: 'le-override-proxy-shared',
      dependencyVolume: 'le-override-dependencies',
      repositories: new Map(),
      revision: 0,
    } satisfies ContainerAgentResources);

    expect(appServer.args).toContain('model_providers.local-provider.base_url="http://local-engineer-proxy:8090/v1"');
  });

  it('copies the immutable Git baseline, overlays ignored dependencies, and locks read-only repositories', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'container-agent-'));
    temporaryRoots.push(root);
    const parent = join(root, 'parent');
    const state = join(root, 'state');
    mkdirSync(parent);
    git(parent, ['init']);
    git(parent, ['config', 'user.name', 'Test']);
    git(parent, ['config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(parent, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(parent, 'source.ts'), 'export const value = 1;\n');
    git(parent, ['add', '.gitignore', 'source.ts']);
    git(parent, ['commit', '-m', 'initial']);
    writeFileSync(join(parent, 'untracked-baseline.ts'), 'export const baseline = true;\n');
    mkdirSync(join(parent, 'node_modules', 'example'), { recursive: true });
    writeFileSync(join(parent, 'node_modules', 'example', 'index.js'), 'module.exports = 1;\n');

    const calls: string[][] = [];
    const execute: RuntimeCommandExecutor = async (_executable, arguments_) => {
      calls.push([...arguments_]);
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const runtime = new ContainerRuntime('docker', execute);
    const manager = new ContainerAgentManager(containerConfig(), state, runtime);
    const repositories: RunRepository[] = [
      {
        name: 'application',
        parentPath: parent,
        containerPath: '/workspace/application',
        access: 'read-only',
      },
    ];

    const resources = await manager.prepare('agt_workspace_copy', worker(), repositories);
    await manager.capture(resources.agentId);

    const workspaceCopy = calls.findIndex(
      (arguments_) =>
        arguments_[0] === 'cp' &&
        arguments_[1] === `${resources.repositories.get('application')!.snapshot.snapshotPath}/.` &&
        arguments_[2]?.endsWith(':/workspace/application'),
    );
    const ignoredDependencyCopy = calls.findIndex(
      (arguments_) =>
        arguments_[0] === 'cp' &&
        arguments_[1] === join(parent, 'node_modules') &&
        arguments_[2]?.endsWith(':/workspace/application'),
    );
    const removeParentGit = calls.findIndex(
      (arguments_) =>
        arguments_.includes('rm') && arguments_.includes('-rf') && arguments_.includes('/workspace/application/.git'),
    );
    const privateGitCopy = calls.findIndex(
      (arguments_) =>
        arguments_[0] === 'cp' &&
        arguments_[1]?.endsWith('/.git/.') &&
        arguments_[2]?.endsWith(':/workspace/application/.git'),
    );
    const verifyPrivateWorktree = calls.findIndex(
      (arguments_) =>
        arguments_.includes('git') &&
        arguments_.includes('/workspace/application') &&
        arguments_.includes('diff') &&
        arguments_.includes('--quiet') &&
        arguments_.includes('--no-ext-diff'),
    );
    const rebuildPrivateIndex = calls.findIndex(
      (arguments_) =>
        arguments_.includes('git') &&
        arguments_.includes('/workspace/application') &&
        arguments_.includes('reset') &&
        arguments_.includes('--mixed') &&
        arguments_.includes('HEAD'),
    );
    const removeHostIndex = calls.findIndex(
      (arguments_) =>
        arguments_.includes('rm') &&
        arguments_.includes('-f') &&
        arguments_.includes('/workspace/application/.git/index'),
    );
    const excludeManagedDependencies = calls.findIndex(
      (arguments_) =>
        arguments_.includes('local-engineer-private-exclude') &&
        arguments_.includes('/workspace/application/.git/info/exclude'),
    );
    const assignWorkerOwnership = calls.findIndex(
      (arguments_) =>
        arguments_.includes('chown') &&
        arguments_.includes('-R') &&
        arguments_.includes('codex') &&
        arguments_.includes('/workspace'),
    );
    const assignRootOwnership = calls.findIndex(
      (arguments_) =>
        arguments_.includes('chown') &&
        arguments_.includes('-R') &&
        arguments_.includes('0:0') &&
        arguments_.includes('/workspace/application'),
    );
    const removeWriteBits = calls.findIndex(
      (arguments_) =>
        arguments_.includes('chmod') &&
        arguments_.includes('-R') &&
        arguments_.includes('a-w') &&
        arguments_.includes('/workspace/application'),
    );
    const configureSafeDirectory = calls.findIndex(
      (arguments_) =>
        arguments_.includes('GIT_CONFIG_COUNT=1') &&
        arguments_.includes('GIT_CONFIG_KEY_0=safe.directory') &&
        arguments_.includes('GIT_CONFIG_VALUE_0=/workspace/application'),
    );
    const inspectReadOnlyAsOwner = calls.findIndex(
      (arguments_) =>
        arguments_.includes('exec') &&
        arguments_.includes('--user') &&
        arguments_.includes('0') &&
        arguments_.includes('git') &&
        arguments_.includes('/workspace/application') &&
        arguments_.includes('status') &&
        arguments_.includes('--porcelain=v1'),
    );

    expect(workspaceCopy).toBeGreaterThanOrEqual(0);
    expect(ignoredDependencyCopy).toBeGreaterThan(workspaceCopy);
    expect(removeParentGit).toBeGreaterThan(workspaceCopy);
    expect(privateGitCopy).toBeGreaterThan(removeParentGit);
    expect(removeHostIndex).toBeGreaterThan(privateGitCopy);
    expect(excludeManagedDependencies).toBeGreaterThan(removeHostIndex);
    expect(assignWorkerOwnership).toBeGreaterThan(removeHostIndex);
    expect(rebuildPrivateIndex).toBeGreaterThan(assignWorkerOwnership);
    expect(verifyPrivateWorktree).toBeGreaterThan(rebuildPrivateIndex);
    expect(assignRootOwnership).toBeGreaterThan(verifyPrivateWorktree);
    expect(removeWriteBits).toBeGreaterThan(assignRootOwnership);
    expect(configureSafeDirectory).toBeGreaterThan(removeWriteBits);
    expect(inspectReadOnlyAsOwner).toBeGreaterThan(configureSafeDirectory);
  });

  it('allows deletion to be retried after setup already cleaned the agent resources', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'container-agent-delete-'));
    temporaryRoots.push(root);
    const manager = new ContainerAgentManager(
      containerConfig(),
      join(root, 'state'),
      new ContainerRuntime('docker', async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    );

    await expect(manager.delete('agt_already_cleaned')).resolves.toBeUndefined();
    await expect(manager.delete('agt_already_cleaned')).resolves.toBeUndefined();
  });

  it('records review commits and returns only the patch between revisions', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'container-agent-revisions-'));
    temporaryRoots.push(root);
    const parent = join(root, 'parent');
    mkdirSync(parent);
    git(parent, ['init']);
    git(parent, ['config', 'user.name', 'Test']);
    git(parent, ['config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(parent, 'source.ts'), 'export const value = 1;\n');
    git(parent, ['add', 'source.ts']);
    git(parent, ['commit', '-m', 'initial']);
    const reviewCommits = ['1'.repeat(40), '2'.repeat(40)];
    let completedCommits = 0;
    const calls: string[][] = [];
    const execute: RuntimeCommandExecutor = async (_executable, arguments_) => {
      const args = [...arguments_];
      calls.push(args);
      if (args.includes('commit')) {
        completedCommits += 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args.includes('rev-parse') && args.includes('HEAD'))
        return { exitCode: 0, stdout: `${reviewCommits[completedCommits - 1]}\n`, stderr: '' };
      if (args.includes('diff') && args.includes('--name-only'))
        return { exitCode: 0, stdout: 'source.ts\0', stderr: '' };
      if (args.includes('diff') && args.includes('--numstat'))
        return { exitCode: 0, stdout: '1\t1\tsource.ts\n', stderr: '' };
      if (args.includes('diff') && args.includes('--binary')) {
        const patch = args.includes(reviewCommits[0])
          ? 'diff --git a/source.ts b/source.ts\n+revision two\n'
          : `diff --git a/source.ts b/source.ts\n+revision ${completedCommits + 1}\n`;
        return { exitCode: 0, stdout: patch, stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const manager = new ContainerAgentManager(
      containerConfig(),
      join(root, 'state'),
      new ContainerRuntime('docker', execute),
    );
    const resources = await manager.prepare('agt_revision_chain', worker(), [
      {
        name: 'application',
        parentPath: parent,
        containerPath: '/workspace/application',
        access: 'read-write',
      },
    ]);

    const first = await manager.capture(resources.agentId);
    const second = await manager.capture(resources.agentId);
    const delta = await manager.getPatchBetween(resources.agentId, 'application', 1, 2);

    expect(first).toMatchObject({ revision: 1, previous_revision: 0 });
    expect(second).toMatchObject({ revision: 2, previous_revision: 1 });
    expect(delta).toContain('revision two');
    expect(
      calls.some(
        (args) =>
          args.includes('git') &&
          args.includes('reset') &&
          args.includes('.local-pkgs') &&
          args.includes('node_modules'),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (args) =>
          args.includes('diff') &&
          args.includes('--binary') &&
          args.includes(reviewCommits[0]) &&
          args.includes(reviewCommits[1]),
      ),
    ).toBe(true);
  });
});

function containerConfig(): ContainerConfig {
  return {
    command: 'docker',
    image: 'local-engineer/worker:test',
    base_image: 'node:24-bookworm-slim',
    codex_version: '0.144.6',
    workspace_path: '/workspace',
    worker_user: 'codex',
    codex_command: 'codex',
    network: {
      model_domains: ['model-provider.example'],
      read_only_domains: [],
      allow_private_model_endpoint: false,
    },
  };
}

function worker(): Worker {
  return {
    name: 'local-container',
    enabled: true,
    harness: 'codex',
    model: 'local-model',
    model_provider: 'local-provider',
    max_concurrency: 1,
    timeout_seconds: 300,
    idle_timeout_seconds: 60,
    environment: {},
    environment_from_host: [],
    container_model_provider: {
      base_url: 'https://model-provider.example/v1',
      wire_api: 'responses',
      requires_openai_auth: false,
    },
  };
}

function git(cwd: string, arguments_: string[]): void {
  execFileSync('git', arguments_, { cwd, stdio: 'pipe' });
}

function testTemporaryDirectory(): string {
  const path = join(process.cwd(), '.tmp', 'tests');
  mkdirSync(path, { recursive: true });
  return path;
}
