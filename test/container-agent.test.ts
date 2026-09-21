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
    expect(appServer.args.slice(0, 3)).toEqual(['--context', 'default', 'exec']);
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

  it('rejects invalid, absolute, traversal, ADS, or .git file paths in getFile', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'container-agent-path-'));
    temporaryRoots.push(root);
    const manager = new ContainerAgentManager(
      containerConfig(),
      join(root, 'state'),
      new ContainerRuntime('docker', async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    );

    await expect(manager.getFile('agt_test', 'repo', '/abs/path')).rejects.toThrow('CONTAINER_FILE_PATH_INVALID');
    await expect(manager.getFile('agt_test', 'repo', '\\abs\\path')).rejects.toThrow('CONTAINER_FILE_PATH_INVALID');
    await expect(manager.getFile('agt_test', 'repo', 'C:/Windows/win.ini')).rejects.toThrow(
      'CONTAINER_FILE_PATH_INVALID',
    );
    await expect(manager.getFile('agt_test', 'repo', 'foo:stream')).rejects.toThrow('CONTAINER_FILE_PATH_INVALID');
    await expect(manager.getFile('agt_test', 'repo', '../parent')).rejects.toThrow('CONTAINER_FILE_PATH_INVALID');
    await expect(manager.getFile('agt_test', 'repo', '.git/config')).rejects.toThrow('CONTAINER_FILE_PATH_INVALID');
  });

  it('locks down Windows setup and worker containers before repository commands run', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'container-agent-windows-'));
    temporaryRoots.push(root);
    const parent = join(root, 'parent');
    mkdirSync(parent);
    git(parent, ['init']);
    git(parent, ['config', 'user.name', 'Test']);
    git(parent, ['config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(parent, 'source.ts'), 'export const value = 1;\n');
    git(parent, ['add', 'source.ts']);
    git(parent, ['commit', '-m', 'initial']);

    const calls: string[][] = [];
    const execute: RuntimeCommandExecutor = async (_executable, arguments_) => {
      const args = [...arguments_];
      calls.push(args);
      if (args.includes('{{.HostConfig.Isolation}}')) return { exitCode: 0, stdout: 'hyperv\n', stderr: '' };
      if (args.includes('{{json .NetworkSettings.Networks}}')) {
        const proxy = args.at(-1)!;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            [proxy.replace(
              /-(?:proxy|worker|proxy-shared-seed|worker-config-seed|dependency-seed|proxy-config-seed|workspace-seed)$/,
              '-internal',
            )]: {
              IPAddress: proxy.endsWith('-proxy') ? '10.240.7.2' : '10.240.7.3',
              MacAddress: proxy.endsWith('-proxy') ? '00:15:5d:00:00:02' : '00:15:5d:00:00:03',
            },
          }),
          stderr: '',
        };
      }
      if (args.some((argument) => argument.endsWith('/configure-worker-network.ps1')))
        return { exitCode: 0, stdout: 'LOCAL_ENGINEER_NETWORK_OK\n', stderr: '' };
      if (args.some((argument) => argument.endsWith('whoami.exe')))
        return { exitCode: 0, stdout: 'BUILTIN\\Users S-1-5-32-545 Enabled group\n', stderr: '' };
      if (args.some((argument) => argument.includes('.local-engineer-read-only-probe-')))
        return { exitCode: 0, stdout: 'LOCKED', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const config = windowsContainerConfig();
    const manager = new ContainerAgentManager(
      config,
      join(root, 'state'),
      new ContainerRuntime('docker', execute, config.context, config.platform, {
        memoryLimit: config.windows_memory_limit!,
        cpuCount: config.windows_cpu_count!,
      }),
    );
    const resources = await manager.prepare('agt_windows', worker(), [
      {
        name: 'application',
        parentPath: parent,
        containerPath: 'C:/workspace/application',
        access: 'read-only',
      },
    ]);

    const creates = calls.filter((args) => args.includes('create') && args.includes('--isolation'));
    expect(creates.length).toBeGreaterThanOrEqual(7);
    for (const args of creates) {
      expect(args).toContain('hyperv');
      expect(args).not.toContain('--cap-drop');
      expect(args).not.toContain('--read-only');
    }
    const networkCalls = calls.filter((args) =>
      args.some((argument) => argument.endsWith('/configure-worker-network.ps1')),
    );
    expect(networkCalls).toHaveLength(6);
    expect(networkCalls.filter((args) => args.includes('-ProxyAddress'))).toHaveLength(1);
    const workerCreate = creates.find((args) => args.includes(resources.workerContainer))!;
    expect(workerCreate).toContain('HTTP_PROXY=http://10.240.7.2:3128');
    const workerStart = calls.findIndex((args) => args.includes('start') && args.includes(resources.workerContainer));
    const workerNetworkIsolation = calls.findIndex(
      (args) =>
        args.includes(resources.workerContainer) &&
        args.some((argument) => argument.endsWith('/configure-worker-network.ps1')),
    );
    const workerReadyCheck = calls.findIndex(
      (args) => args.includes(resources.workerContainer) && args.some((argument) => argument.includes('fs.existsSync')),
    );
    expect(workerNetworkIsolation).toBeGreaterThan(workerStart);
    expect(workerReadyCheck).toBeGreaterThan(workerNetworkIsolation);
    expect(
      calls.some(
        (args) =>
          args.some((arg) => arg.endsWith('icacls.exe')) &&
          args.includes('C:/workspace') &&
          args.includes('*S-1-5-93-2-2:(OI)(CI)M') &&
          args.includes('/T') &&
          args.includes('/C'),
      ),
    ).toBe(true);
    const appVolume = resources.repositoryVolumes.get('application')!;
    expect(workerCreate).toContain(`type=volume,src=${appVolume},dst=C:/workspace/application,readonly`);
    expect(
      calls.some(
        (args) =>
          args.includes(resources.workerContainer) &&
          args.some((argument) => argument.includes('.local-engineer-read-only-probe-')),
      ),
    ).toBe(true);
    expect(manager.appServerWorker(worker(), resources).args).toContain(
      'model_providers.local-provider.base_url="http://10.240.7.2:8090/v1"',
    );
    await manager.capture(resources.agentId);
    const readOnlyIntegrityCheck = calls.find(
      (args) => args.includes('status') && args.includes('--porcelain=v1') && args.includes('C:/workspace/application'),
    )!;
    expect(readOnlyIntegrityCheck).toContain('ContainerAdministrator');
    expect(readOnlyIntegrityCheck).toContain('--workdir');
    expect(readOnlyIntegrityCheck).toContain('C:/Windows/System32');
    expect(readOnlyIntegrityCheck).toContain('C:/MinGit/cmd/git.exe');
    expect(readOnlyIntegrityCheck).not.toContain('0');
  });

  it('recursively grants ContainerUser modify permissions on writable repositories in Windows containers', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'container-agent-writable-win-'));
    temporaryRoots.push(root);
    const parent = join(root, 'parent');
    mkdirSync(parent);
    git(parent, ['init']);
    git(parent, ['config', 'user.name', 'Test']);
    git(parent, ['config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(parent, 'source.ts'), 'export const value = 1;\n');
    git(parent, ['add', 'source.ts']);
    git(parent, ['commit', '-m', 'initial']);

    const calls: string[][] = [];
    const execute: RuntimeCommandExecutor = async (_executable, arguments_) => {
      const args = [...arguments_];
      calls.push(args);
      if (args.includes('{{.HostConfig.Isolation}}')) return { exitCode: 0, stdout: 'hyperv\n', stderr: '' };
      if (args.includes('{{json .NetworkSettings.Networks}}')) {
        const proxy = args.at(-1)!;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            [proxy.replace(
              /-(?:proxy|worker|proxy-shared-seed|worker-config-seed|dependency-seed|proxy-config-seed|workspace-seed)$/,
              '-internal',
            )]: {
              IPAddress: proxy.endsWith('-proxy') ? '10.240.7.2' : '10.240.7.3',
              MacAddress: proxy.endsWith('-proxy') ? '00:15:5d:00:00:02' : '00:15:5d:00:00:03',
            },
          }),
          stderr: '',
        };
      }
      if (args.some((argument) => argument.endsWith('/configure-worker-network.ps1')))
        return { exitCode: 0, stdout: 'LOCAL_ENGINEER_NETWORK_OK\n', stderr: '' };
      if (args.some((argument) => argument.endsWith('whoami.exe')))
        return { exitCode: 0, stdout: 'BUILTIN\\Users S-1-5-32-545 Enabled group\n', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const config = windowsContainerConfig();
    const manager = new ContainerAgentManager(
      config,
      join(root, 'state'),
      new ContainerRuntime('docker', execute, config.context, config.platform, {
        memoryLimit: config.windows_memory_limit!,
        cpuCount: config.windows_cpu_count!,
      }),
    );
    await manager.prepare('agt_windows_writable', worker(), [
      {
        name: 'writable-app',
        parentPath: parent,
        containerPath: 'C:/workspace/writable-app',
        access: 'read-write',
      },
    ]);

    expect(
      calls.some(
        (args) =>
          args.some((arg) => arg.endsWith('icacls.exe')) &&
          args.includes('C:/workspace') &&
          args.includes('*S-1-5-93-2-2:(OI)(CI)M') &&
          args.includes('/T') &&
          args.includes('/C'),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (args) =>
          args.some((arg) => arg.endsWith('icacls.exe')) &&
          args.includes('C:/workspace/writable-app') &&
          args.includes('*S-1-5-93-2-2:(OI)(CI)M') &&
          args.includes('/T') &&
          args.includes('/C'),
      ),
    ).toBe(true);
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

  it('throws PROMOTION_ROLLBACK_INCOMPLETE when rollback fails after partial promotion', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'container-agent-rollback-'));
    temporaryRoots.push(root);
    const parent1 = join(root, 'parent1');
    const parent2 = join(root, 'parent2');
    mkdirSync(parent1);
    mkdirSync(parent2);
    git(parent1, ['init']);
    git(parent1, ['config', 'user.name', 'Test']);
    git(parent1, ['config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(parent1, 'file1.txt'), 'base1\n');
    git(parent1, ['add', 'file1.txt']);
    git(parent1, ['commit', '-m', 'init']);

    git(parent2, ['init']);
    git(parent2, ['config', 'user.name', 'Test']);
    git(parent2, ['config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(parent2, 'file2.txt'), 'base2\n');
    git(parent2, ['add', 'file2.txt']);
    git(parent2, ['commit', '-m', 'init']);

    // Prove the deterministic promotion rollback failure sequence:
    // 1. Initial preflight validation (checkRepositoryPromotion) succeeds for every repository.
    // 2. The first repository patch is applied (promoteRepositoryChanges succeeds for repo1).
    // 3. A later repository promotion fails (onBeforePromote triggers on repo2).
    // 4. Rolling back the first repository also fails (reversePatch throws).
    // 5. promote() throws an error beginning with PROMOTION_ROLLBACK_INCOMPLETE.
    // 6. The error identifies repo1 as having failed rollback and preserves the original repo2 promotion error.
    const manager = new ContainerAgentManager(
      containerConfig(),
      join(root, 'state'),
      new ContainerRuntime('docker', async () => ({ exitCode: 0, stdout: '', stderr: '' })),
      {
        onBeforePromote: async (repositoryName, appliedCount) => {
          if (repositoryName === 'repo2' && appliedCount === 1) {
            throw new Error('SIMULATED_PROMOTION_FAILURE_REPO2');
          }
        },
        reversePatch: async () => {
          throw new Error('SIMULATED_ROLLBACK_FAILURE_REPO1');
        },
      },
    );

    const resources = await manager.prepare('agt_rollback', worker(), [
      { name: 'repo1', parentPath: parent1, containerPath: '/workspace/repo1', access: 'read-write' },
      { name: 'repo2', parentPath: parent2, containerPath: '/workspace/repo2', access: 'read-write' },
    ]);

    const patch1 =
      'diff --git a/file1.txt b/file1.txt\nindex b16e026..b024467 100644\n--- a/file1.txt\n+++ b/file1.txt\n@@ -1 +1 @@\n-base1\n+mod1\n';
    const patch2 =
      'diff --git a/file2.txt b/file2.txt\nindex 235aef2..6c498ae 100644\n--- a/file2.txt\n+++ b/file2.txt\n@@ -1 +1 @@\n-base2\n+mod2\n';

    const repo1Rev = resources.repositories.get('repo1')!;
    repo1Rev.changes = {
      patch: patch1,
      patchDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      changedPaths: ['file1.txt'],
      additions: 1,
      deletions: 1,
    };
    const repo2Rev = resources.repositories.get('repo2')!;
    repo2Rev.changes = {
      patch: patch2,
      patchDigest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
      changedPaths: ['file2.txt'],
      additions: 1,
      deletions: 1,
    };
    resources.revision = 1;

    const summaries = [
      ['repo1', repo1Rev.changes.patchDigest],
      ['repo2', repo2Rev.changes.patchDigest],
    ];
    const { createHash } = await import('node:crypto');
    const digest = `sha256:${createHash('sha256').update(JSON.stringify(summaries)).digest('hex')}`;

    await expect(manager.promote(resources.agentId, 1, digest)).rejects.toThrow(
      /^PROMOTION_ROLLBACK_INCOMPLETE: Promotion failed and rollback could not be completed cleanly for repository: repo1: SIMULATED_ROLLBACK_FAILURE_REPO1\. Original error: SIMULATED_PROMOTION_FAILURE_REPO2/,
    );
  });
});

function containerConfig(): ContainerConfig {
  return {
    command: 'docker',
    platform: 'linux',
    context: 'default',
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

function windowsContainerConfig(): ContainerConfig {
  return {
    ...containerConfig(),
    platform: 'windows',
    context: 'desktop-windows',
    image: 'local-engineer/worker:windows',
    base_image: 'mcr.microsoft.com/windows/servercore:ltsc2025',
    workspace_path: 'C:/workspace',
    worker_user: 'ContainerUser',
    windows_memory_limit: '4g',
    windows_cpu_count: 2,
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
