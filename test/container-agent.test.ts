import { execFileSync } from 'node:child_process';
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertNoReparsePoints, ContainerAgentManager, type ContainerAgentResources } from '../src/container-agent.js';
import { ContainerRuntime, type RuntimeCommandExecutor } from '../src/container-runtime.js';
import type { ContainerConfig, RunRepository, Worker } from '../src/domain.js';
import * as repoSnapshot from '../src/repository-snapshot.js';

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

  it('uses the fully qualified native Codex executable for Windows workers', () => {
    const manager = new ContainerAgentManager(windowsContainerConfig(), testTemporaryDirectory());
    const appServer = manager.appServerWorker(worker(), {
      agentId: 'agt_windows_codex',
      image: 'worker:test',
      workerContainer: 'le-windows-codex-worker',
      proxyContainer: 'le-windows-codex-proxy',
      internalNetwork: 'le-windows-codex-internal',
      egressNetwork: 'le-windows-codex-egress',
      workspaceVolume: 'le-windows-codex-workspace',
      workerConfigVolume: 'le-windows-codex-worker-config',
      proxyConfigVolume: 'le-windows-codex-proxy-config',
      proxySharedVolume: 'le-windows-codex-proxy-shared',
      dependencyVolume: 'le-windows-codex-dependencies',
      proxyAddress: '10.240.7.2',
      repositories: new Map(),
      revision: 0,
    } satisfies ContainerAgentResources);

    expect(appServer.args).toContain(
      'C:/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
    );
    expect(appServer.args).not.toContain('codex');
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

describe('Windows isolated-bind workspace mode', () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  function createWindowsMock(calls: string[][]): RuntimeCommandExecutor {
    const stoppedContainers = new Set<string>();
    return async (_executable, arguments_) => {
      const args = [...arguments_];
      calls.push(args);
      if (args[0] === 'stop' || args.includes('stop')) {
        const target = args.at(-1);
        if (target) stoppedContainers.add(target);
      }
      if (args[0] === 'start' || args.includes('start')) {
        const target = args.at(-1);
        if (target) stoppedContainers.delete(target);
      }
      if (args.includes('{{.HostConfig.Isolation}}')) return { exitCode: 0, stdout: 'hyperv\n', stderr: '' };
      if (args.includes('{{.State.Running}}')) {
        const target = args.at(-1);
        if (target && stoppedContainers.has(target)) {
          return { exitCode: 0, stdout: 'false\n', stderr: '' };
        }
        return { exitCode: 0, stdout: 'true\n', stderr: '' };
      }
      if (args.includes('{{json .NetworkSettings.Networks}}')) {
        const target = args.at(-1)!;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            [target.replace(
              /-(?:proxy|worker|consolidated-setup|proxy-shared-seed|worker-config-seed|dependency-seed|proxy-config-seed|workspace-seed)$/,
              '-internal',
            )]: {
              IPAddress: target.endsWith('-proxy') ? '10.240.7.2' : '10.240.7.3',
              MacAddress: target.endsWith('-proxy') ? '00:15:5d:00:00:02' : '00:15:5d:00:00:03',
            },
          }),
          stderr: '',
        };
      }
      if (args.some((argument) => argument.endsWith('/configure-worker-network.ps1')))
        return { exitCode: 0, stdout: 'LOCAL_ENGINEER_NETWORK_OK\n', stderr: '' };
      if (args.some((argument) => argument.endsWith('whoami.exe')))
        return { exitCode: 0, stdout: 'BUILTIN\\Users S-1-5-32-545 Enabled group\n', stderr: '' };
      if (args.some((argument) => argument.includes('read-only-probe') || argument.includes('.probe-')))
        return { exitCode: 0, stdout: 'LOCKED', stderr: '' };
      if (args.some((a) => a.includes("require('node:fs').readFileSync"))) {
        const targetPath = args.at(-1)!.replace(/\\/g, '/');
        for (const root of temporaryRoots) {
          const agentsDir = join(root, 'state', 'container-agents');
          if (existsSync(agentsDir)) {
            for (const agentId of readdirSync(agentsDir)) {
              const workspacesDir = join(agentsDir, agentId, 'workspaces');
              if (existsSync(workspacesDir)) {
                for (const repo of readdirSync(workspacesDir)) {
                  const repoDir = join(workspacesDir, repo);
                  if (targetPath.includes(`/${repo}/`)) {
                    const subpath = targetPath.slice(targetPath.indexOf(`/${repo}/`) + repo.length + 2);
                    const candidate = join(repoDir, subpath);
                    if (existsSync(candidate)) {
                      return { exitCode: 0, stdout: readFileSync(candidate, 'utf8'), stderr: '' };
                    }
                  }
                }
              }
            }
          }
        }
        return { exitCode: 2, stdout: '', stderr: 'ENOENT' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
  }

  function createWindowsRuntime(config: ContainerConfig, calls: string[][] = []): ContainerRuntime {
    return new ContainerRuntime('docker', createWindowsMock(calls), config.context, config.platform, {
      memoryLimit: config.windows_memory_limit ?? '4g',
      cpuCount: config.windows_cpu_count ?? 2,
    });
  }

  function setupTestRepo(root: string, name: string): string {
    const repoPath = join(root, name);
    mkdirSync(repoPath, { recursive: true });
    git(repoPath, ['init']);
    git(repoPath, ['config', 'user.name', 'Test']);
    git(repoPath, ['config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(repoPath, '.gitignore'), 'node_modules/\n.env\n');
    writeFileSync(join(repoPath, 'package.json'), '{"name":"test-repo","version":"1.0.0"}\n');
    writeFileSync(join(repoPath, 'source.ts'), 'export const value = 1;\n');
    writeFileSync(join(repoPath, '.env'), 'SECRET_TOKEN=super-secret-password\n');
    mkdirSync(join(repoPath, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(repoPath, 'node_modules', 'dep', 'index.js'), 'module.exports = 42;\n');
    git(repoPath, ['add', '.gitignore', 'package.json', 'source.ts']);
    git(repoPath, ['commit', '-m', 'initial']);
    return repoPath;
  }

  it('mounts the disposable clone and node_modules read-only, never the parent repo or baseline clone, and hides .env', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'iso-bind-test-'));
    temporaryRoots.push(root);
    const parent = setupTestRepo(root, 'parent');
    const state = join(root, 'state');

    const calls: string[][] = [];
    const config = windowsIsolatedBindConfig();
    const manager = new ContainerAgentManager(config, state, createWindowsRuntime(config, calls));

    const resources = await manager.prepare('agt_iso_mounts', worker(), [
      {
        name: 'application',
        parentPath: parent,
        containerPath: 'C:/repos/application',
        access: 'read-write',
      },
    ]);

    const creates = calls.filter((args) => args.includes('create') && args.includes('--isolation'));
    expect(creates.some((args) => args.some((arg) => arg.includes('consolidated-setup')))).toBe(true);

    const workerCreate = calls.find((args) => args.includes('create') && args.includes(resources.workerContainer))!;
    expect(workerCreate).toBeDefined();

    const mountArgs = workerCreate.filter((arg) => arg.startsWith('type=bind,'));
    expect(mountArgs).toHaveLength(2);

    const workingCloneMount = mountArgs[0]!;
    const dependencyMount = mountArgs[1]!;

    const expectedWorkingClone = join(state, 'container-agents', 'agt_iso_mounts', 'workspaces', 'application').replace(
      /\\/g,
      '/',
    );
    expect(workingCloneMount).toBe(`type=bind,src=${expectedWorkingClone},dst=C:/repos/application`);

    const expectedNodeModules = join(parent, 'node_modules').replace(/\\/g, '/');
    expect(dependencyMount).toBe(`type=bind,src=${expectedNodeModules},dst=C:/repos/application/node_modules,readonly`);

    const baselinePath = join(state, 'container-agents', 'agt_iso_mounts', 'snapshots', 'application').replace(
      /\\/g,
      '/',
    );
    for (const call of calls) {
      for (const arg of call) {
        if (arg.includes('type=bind')) {
          expect(arg).not.toContain(`src=${parent.replace(/\\/g, '/')},`);
          expect(arg).not.toContain(`src=${baselinePath}`);
          expect(arg).not.toContain('.env');
        }
      }
    }

    expect(resources.timings).toBeDefined();
    expect(resources.timings?.baselineCreationMs).toBeGreaterThanOrEqual(0);
    expect(resources.timings?.workingCloneCreationMs).toBeGreaterThanOrEqual(0);
    expect(resources.timings?.dependencyValidationMs).toBeGreaterThanOrEqual(0);
    expect(resources.timings?.networkAllocationMs).toBeGreaterThanOrEqual(0);
    expect(resources.timings?.setupContainerExecutionMs).toBeGreaterThanOrEqual(0);
    expect(resources.timings?.workerStartupMs).toBeGreaterThanOrEqual(0);
    expect(resources.timings?.totalPreparationMs).toBeGreaterThanOrEqual(0);
  });

  it('produces correct mount arguments for read/write and read-only repositories', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'iso-rw-ro-'));
    temporaryRoots.push(root);
    const parentRW = setupTestRepo(root, 'repo-rw');
    const parentRO = setupTestRepo(root, 'repo-ro');
    const state = join(root, 'state');

    const calls: string[][] = [];
    const config = windowsIsolatedBindConfig();
    const manager = new ContainerAgentManager(config, state, createWindowsRuntime(config, calls));

    const resources = await manager.prepare('agt_iso_rw_ro', worker(), [
      { name: 'repo-rw', parentPath: parentRW, containerPath: 'C:/repos/repo-rw', access: 'read-write' },
      { name: 'repo-ro', parentPath: parentRO, containerPath: 'C:/repos/repo-ro', access: 'read-only' },
    ]);

    const workerCreate = calls.find((args) => args.includes('create') && args.includes(resources.workerContainer))!;
    const bindMounts = workerCreate.filter((arg) => arg.startsWith('type=bind,'));

    expect(bindMounts).toHaveLength(4);

    const rwClone = bindMounts.find((m) => m.includes('dst=C:/repos/repo-rw,') || m.endsWith('dst=C:/repos/repo-rw'))!;
    const rwDeps = bindMounts.find((m) => m.includes('dst=C:/repos/repo-rw/node_modules'))!;
    const roClone = bindMounts.find((m) => m.includes('dst=C:/repos/repo-ro,') || m.endsWith('dst=C:/repos/repo-ro'))!;
    const roDeps = bindMounts.find((m) => m.includes('dst=C:/repos/repo-ro/node_modules'))!;

    expect(rwClone).not.toContain('readonly');
    expect(rwDeps).toContain('readonly');
    expect(roClone).toContain('readonly');
    expect(roDeps).toContain('readonly');
  });

  it('fails closed when workspace repository drive is not C:', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'iso-drive-'));
    temporaryRoots.push(root);
    const parent = setupTestRepo(root, 'parent');
    const state = join(root, 'state');

    const config = windowsIsolatedBindConfig();
    const manager = new ContainerAgentManager(config, state, createWindowsRuntime(config));

    await expect(
      manager.prepare('agt_iso_drive', worker(), [
        { name: 'app', parentPath: parent, containerPath: 'D:/repos/app', access: 'read-write' },
      ]),
    ).rejects.toThrow('CONTAINER_WORKSPACE_DRIVE_UNSUPPORTED');
  });

  it('rejects escaping junctions in dependency directory before container launch', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'iso-escape-'));
    temporaryRoots.push(root);
    const parent = setupTestRepo(root, 'parent');
    const state = join(root, 'state');

    const { symlinkSync } = await import('node:fs');
    symlinkSync(root, join(parent, 'node_modules', 'escape'), 'junction');

    const calls: string[][] = [];
    const config = windowsIsolatedBindConfig();
    const manager = new ContainerAgentManager(config, state, createWindowsRuntime(config, calls));

    await expect(
      manager.prepare('agt_iso_escape', worker(), [
        { name: 'app', parentPath: parent, containerPath: 'C:/repos/app', access: 'read-write' },
      ]),
    ).rejects.toThrow(/CONTAINER_DEPENDENCY_MOUNT_UNSAFE/);

    expect(calls.filter((c) => c.includes('create'))).toHaveLength(0);
  });

  it('recovery rejects tampered paths in resources.json', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'iso-recover-'));
    temporaryRoots.push(root);
    const parent = setupTestRepo(root, 'parent');
    const state = join(root, 'state');

    const config = windowsIsolatedBindConfig();
    const manager = new ContainerAgentManager(config, state, createWindowsRuntime(config));

    const resources = await manager.prepare('agt_iso_tamper', worker(), [
      { name: 'app', parentPath: parent, containerPath: 'C:/repos/app', access: 'read-write' },
    ]);

    const resourcePath = join(state, 'container-agents', resources.agentId, 'resources.json');
    const data = JSON.parse(readFileSync(resourcePath, 'utf8'));

    data.windows_repository_mounts[0].working_clone_path = 'C:/malicious/escape';
    writeFileSync(resourcePath, JSON.stringify(data, null, 2), 'utf8');

    const recoverManager = new ContainerAgentManager(config, state, createWindowsRuntime(config));

    await expect(
      recoverManager.recover({
        agentId: resources.agentId,
        image: resources.image,
        repositories: [{ name: 'app', parentPath: parent, containerPath: 'C:/repos/app', access: 'read-write' }],
      }),
    ).rejects.toThrow('CONTAINER_AGENT_RETAINED_STATE_INVALID');
  });

  it('cleanup cannot delete dependency sources or paths outside the agent directory', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'iso-cleanup-'));
    temporaryRoots.push(root);
    const parent = setupTestRepo(root, 'parent');
    const state = join(root, 'state');

    const config = windowsIsolatedBindConfig();
    const manager = new ContainerAgentManager(config, state, createWindowsRuntime(config));

    const resources = await manager.prepare('agt_iso_clean', worker(), [
      { name: 'app', parentPath: parent, containerPath: 'C:/repos/app', access: 'read-write' },
    ]);

    expect(existsSync(join(parent, 'source.ts'))).toBe(true);
    expect(existsSync(join(parent, 'node_modules', 'dep', 'index.js'))).toBe(true);

    await manager.delete(resources.agentId);

    expect(existsSync(join(parent, 'source.ts'))).toBe(true);
    expect(existsSync(join(parent, 'node_modules', 'dep', 'index.js'))).toBe(true);

    expect(existsSync(join(state, 'container-agents', resources.agentId))).toBe(false);

    await expect(manager.delete('../malicious')).rejects.toThrow('CONTAINER_AGENT_CLEANUP_PATH_INVALID');
  });

  it('patch capture uses host Git index, ignores worker-controlled Git metadata, and excludes node_modules', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'iso-capture-'));
    temporaryRoots.push(root);
    const parent = setupTestRepo(root, 'parent');
    const state = join(root, 'state');

    const config = windowsIsolatedBindConfig();
    const manager = new ContainerAgentManager(config, state, createWindowsRuntime(config));

    const resources = await manager.prepare('agt_iso_cap', worker(), [
      { name: 'app', parentPath: parent, containerPath: 'C:/repos/app', access: 'read-write' },
    ]);

    const workingClone = join(state, 'container-agents', resources.agentId, 'workspaces', 'app');

    writeFileSync(join(workingClone, 'source.ts'), 'export const value = 999;\n', 'utf8');

    mkdirSync(join(workingClone, 'node_modules', 'tampered'), { recursive: true });
    writeFileSync(join(workingClone, 'node_modules', 'tampered', 'evil.js'), 'evil();\n', 'utf8');

    writeFileSync(join(workingClone, '.git', 'HEAD'), 'corrupt\n', 'utf8');

    const changeSet = await manager.capture(resources.agentId);

    expect(changeSet.repositories).toHaveLength(1);
    const summary = changeSet.repositories[0]!;
    expect(summary.changed_paths).toEqual(['source.ts']);
    expect(summary.changed_paths).not.toContain('node_modules/tampered/evil.js');

    const patch = manager.getPatch(resources.agentId, 'app');
    expect(patch).toContain('+export const value = 999;');
    expect(patch).not.toContain('evil();');

    const diff = await manager.getPatchBetween(resources.agentId, 'app', 0, 1);
    expect(diff).toContain('+export const value = 999;');

    const content = await manager.getFile(resources.agentId, 'app', 'source.ts', 1000);
    expect(content).toBe('export const value = 999;\n');
  });

  it('marks dependency validation stale when worker changes package.json', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'iso-stale-'));
    temporaryRoots.push(root);
    const parent = setupTestRepo(root, 'parent');
    const state = join(root, 'state');

    const config = windowsIsolatedBindConfig();
    const manager = new ContainerAgentManager(config, state, createWindowsRuntime(config));

    const resources = await manager.prepare('agt_iso_stale', worker(), [
      { name: 'app', parentPath: parent, containerPath: 'C:/repos/app', access: 'read-write' },
    ]);

    const workingClone = join(state, 'container-agents', resources.agentId, 'workspaces', 'app');

    writeFileSync(
      join(workingClone, 'package.json'),
      '{"name":"test-repo","version":"2.0.0","dependencies":{"new-dep":"1.0.0"}}\n',
      'utf8',
    );

    await manager.capture(resources.agentId);

    const rev = resources.repositories.get('app')!;
    expect(rev.dependencyManifestStale).toBe(true);
  });

  it('rejects worker-created junction in working clone during capture', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'iso-junction-'));
    temporaryRoots.push(root);
    const parent = setupTestRepo(root, 'parent');
    const outside = mkdtempSync(join(testTemporaryDirectory(), 'outside-target-'));
    temporaryRoots.push(outside);
    const state = join(root, 'state');

    const config = windowsIsolatedBindConfig();
    const manager = new ContainerAgentManager(config, state, createWindowsRuntime(config));

    const resources = await manager.prepare('agt_iso_junction', worker(), [
      { name: 'app', parentPath: parent, containerPath: 'C:/repos/app', access: 'read-write' },
    ]);

    const workingClone = join(state, 'container-agents', resources.agentId, 'workspaces', 'app');
    symlinkSync(outside, join(workingClone, 'planted-junction'), 'junction');

    await expect(manager.capture(resources.agentId)).rejects.toThrow(
      /CONTAINER_PATCH_INVALID:reparse_point_detected:planted-junction/,
    );
  });

  it('refuses promotion when dependency manifest is stale unless allowStaleDependencies is set', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'iso-stale-promote-'));
    temporaryRoots.push(root);
    const parent = setupTestRepo(root, 'parent');
    const state = join(root, 'state');

    const config = windowsIsolatedBindConfig();
    const manager = new ContainerAgentManager(config, state, createWindowsRuntime(config));

    const resources = await manager.prepare('agt_iso_stale_promote', worker(), [
      { name: 'app', parentPath: parent, containerPath: 'C:/repos/app', access: 'read-write' },
    ]);

    const workingClone = join(state, 'container-agents', resources.agentId, 'workspaces', 'app');
    writeFileSync(
      join(workingClone, 'package.json'),
      '{"name":"test-repo","version":"2.0.0","dependencies":{"new-dep":"1.0.0"}}\n',
      'utf8',
    );

    const changeSet = await manager.capture(resources.agentId);
    expect(changeSet.dependency_manifest_stale).toBe(true);

    // Attempt promote without allowStaleDependencies -> throws PROMOTION_DEPENDENCY_MANIFEST_STALE
    await expect(manager.promote(resources.agentId, changeSet.revision, changeSet.digest)).rejects.toThrow(
      /PROMOTION_DEPENDENCY_MANIFEST_STALE/,
    );

    // Attempt promote with allowStaleDependencies: true -> succeeds
    await expect(
      manager.promote(resources.agentId, changeSet.revision, changeSet.digest, {
        allowStaleDependencies: true,
      }),
    ).resolves.not.toThrow();

    // Verify parent repo has the updated package.json
    expect(readFileSync(join(parent, 'package.json'), 'utf8')).toContain('"new-dep":"1.0.0"');
  });

  it('capture fails closed immediately if stopContainer fails, before host inspection', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'iso-stop-fail-'));
    temporaryRoots.push(root);
    const parent = setupTestRepo(root, 'parent');
    const state = join(root, 'state');

    const config = windowsIsolatedBindConfig();
    const runtime = createWindowsRuntime(config);
    const stopSpy = vi.spyOn(runtime, 'stopContainer').mockRejectedValueOnce(new Error('DOCKER_STOP_FAILED'));

    const manager = new ContainerAgentManager(config, state, runtime);
    const resources = await manager.prepare('agt_iso_stop_fail', worker(), [
      { name: 'app', parentPath: parent, containerPath: 'C:/repos/app', access: 'read-write' },
    ]);

    const workingClone = join(state, 'container-agents', resources.agentId, 'workspaces', 'app');
    writeFileSync(join(workingClone, 'source.ts'), 'export const mutated = true;\n');

    // Plant an escaping junction in the working clone.
    // If host inspection (assertNoReparsePoints) were ever reached, it would throw
    // CONTAINER_PATCH_INVALID:reparse_point_detected:reparse-trap instead of DOCKER_STOP_FAILED.
    symlinkSync(parent, join(workingClone, 'reparse-trap'), 'junction');

    // Track Git execution during host inspection
    const gitSpy = vi.spyOn(repoSnapshot, 'git');
    gitSpy.mockClear();

    // Capture must fail closed with DOCKER_STOP_FAILED before any host inspection
    await expect(manager.capture(resources.agentId)).rejects.toThrow('DOCKER_STOP_FAILED');

    // Host inspection must never have been reached
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(gitSpy).not.toHaveBeenCalled();

    const agentDir = join(state, 'container-agents', resources.agentId);
    const patchesDir = join(agentDir, 'patches');
    expect(existsSync(patchesDir)).toBe(false);
    expect(resources.revision).toBe(0);
    expect(resources.repositories.get('app')?.reviewCommits.has(1)).toBe(false);
    expect(existsSync(join(agentDir, 'review-commits.json'))).toBe(false);
    expect(existsSync(join(agentDir, 'dependency-manifest-stale.json'))).toBe(false);
  });

  it('capture fails closed if container remains running after stopContainer', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'iso-stop-running-'));
    temporaryRoots.push(root);
    const parent = setupTestRepo(root, 'parent');
    const state = join(root, 'state');

    const config = windowsIsolatedBindConfig();
    const runtime = createWindowsRuntime(config);
    vi.spyOn(runtime, 'stopContainer').mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    vi.spyOn(runtime, 'isContainerRunning').mockResolvedValue(true);

    const manager = new ContainerAgentManager(config, state, runtime);
    const resources = await manager.prepare('agt_iso_stop_running', worker(), [
      { name: 'app', parentPath: parent, containerPath: 'C:/repos/app', access: 'read-write' },
    ]);

    await expect(manager.capture(resources.agentId)).rejects.toThrow('CONTAINER_STOP_FAILED');
  });

  it('capture fails closed immediately if pauseContainer fails on non-windows platform, before host inspection', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'iso-pause-fail-'));
    temporaryRoots.push(root);
    const parent = setupTestRepo(root, 'parent');
    const state = join(root, 'state');

    const config = windowsIsolatedBindConfig();
    const runtime = createWindowsRuntime(config);
    const pauseSpy = vi.spyOn(runtime, 'pauseContainer').mockRejectedValueOnce(new Error('DOCKER_PAUSE_FAILED'));

    const manager = new ContainerAgentManager(config, state, runtime);
    const resources = await manager.prepare('agt_iso_pause_fail', worker(), [
      { name: 'app', parentPath: parent, containerPath: 'C:/repos/app', access: 'read-write' },
    ]);

    // Switch platform to linux to exercise the non-windows pauseContainer path in capture
    (manager as unknown as { config: { platform: string } }).config.platform = 'linux';

    const workingClone = join(state, 'container-agents', resources.agentId, 'workspaces', 'app');
    writeFileSync(join(workingClone, 'source.ts'), 'export const mutated = true;\n');

    // Plant an escaping junction in the working clone.
    // If host inspection (assertNoReparsePoints) were ever reached, it would throw
    // CONTAINER_PATCH_INVALID:reparse_point_detected:reparse-trap instead of DOCKER_PAUSE_FAILED.
    symlinkSync(parent, join(workingClone, 'reparse-trap'), 'junction');

    const gitSpy = vi.spyOn(repoSnapshot, 'git');
    gitSpy.mockClear();

    // Capture must fail closed with DOCKER_PAUSE_FAILED before any host inspection
    await expect(manager.capture(resources.agentId)).rejects.toThrow('DOCKER_PAUSE_FAILED');

    // Host inspection must never have been reached
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(gitSpy).not.toHaveBeenCalled();

    const agentDir = join(state, 'container-agents', resources.agentId);
    const patchesDir = join(agentDir, 'patches');
    expect(existsSync(patchesDir)).toBe(false);
    expect(resources.revision).toBe(0);
    expect(resources.repositories.get('app')?.reviewCommits.has(1)).toBe(false);
    expect(existsSync(join(agentDir, 'review-commits.json'))).toBe(false);
    expect(existsSync(join(agentDir, 'dependency-manifest-stale.json'))).toBe(false);
  });

  it('capture succeeds without stop when worker container is already verified stopped', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'iso-verified-stop-'));
    temporaryRoots.push(root);
    const parent = setupTestRepo(root, 'parent');
    const state = join(root, 'state');

    const config = windowsIsolatedBindConfig();
    const runtime = createWindowsRuntime(config);
    const isRunningSpy = vi.spyOn(runtime, 'isContainerRunning').mockResolvedValue(false);
    const stopSpy = vi.spyOn(runtime, 'stopContainer');

    const manager = new ContainerAgentManager(config, state, runtime);
    const resources = await manager.prepare('agt_iso_stopped', worker(), [
      { name: 'app', parentPath: parent, containerPath: 'C:/repos/app', access: 'read-write' },
    ]);

    const workingClone = join(state, 'container-agents', resources.agentId, 'workspaces', 'app');
    writeFileSync(join(workingClone, 'source.ts'), 'export const frozen = true;\n');

    const changeSet = await manager.capture(resources.agentId);
    expect(changeSet.revision).toBe(1);
    expect(changeSet.repositories[0]?.changed_paths).toEqual(['source.ts']);

    expect(isRunningSpy).toHaveBeenCalledWith(resources.workerContainer);
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it('prepare restarts stopped worker container and reapplies network and mount assertions', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'iso-prepare-restart-'));
    temporaryRoots.push(root);
    const parent = setupTestRepo(root, 'parent');
    const state = join(root, 'state');

    const calls: string[][] = [];
    const config = windowsIsolatedBindConfig();
    const runtime = createWindowsRuntime(config, calls);
    const manager = new ContainerAgentManager(config, state, runtime);
    const resources = await manager.prepare('agt_iso_restart', worker(), [
      { name: 'app', parentPath: parent, containerPath: 'C:/repos/app', access: 'read-write' },
    ]);

    const workingClone = join(state, 'container-agents', resources.agentId, 'workspaces', 'app');
    writeFileSync(join(workingClone, 'source.ts'), 'export const step1 = true;\n');

    await manager.capture(resources.agentId);
    expect(await runtime.isContainerRunning(resources.workerContainer)).toBe(false);

    calls.length = 0;
    const resumed = await manager.prepare(resources.agentId, worker(), [
      { name: 'app', parentPath: parent, containerPath: 'C:/repos/app', access: 'read-write' },
    ]);

    expect(resumed).toBe(resources);
    expect(await runtime.isContainerRunning(resources.workerContainer)).toBe(true);
    expect(calls.some((args) => args.includes('start') && args.includes(resources.workerContainer))).toBe(true);
    expect(calls.some((args) => args.some((a) => a.endsWith('/configure-worker-network.ps1')))).toBe(true);
  });

  it('getFile returns immutable reviewed revision content even if working clone is mutated after capture', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'iso-getfile-immut-'));
    temporaryRoots.push(root);
    const parent = setupTestRepo(root, 'parent');
    const state = join(root, 'state');

    const config = windowsIsolatedBindConfig();
    const manager = new ContainerAgentManager(config, state, createWindowsRuntime(config));

    const resources = await manager.prepare('agt_iso_getfile', worker(), [
      { name: 'app', parentPath: parent, containerPath: 'C:/repos/app', access: 'read-write' },
    ]);

    const workingClone = join(state, 'container-agents', resources.agentId, 'workspaces', 'app');
    writeFileSync(join(workingClone, 'source.ts'), 'export const value = 42;\n');

    const changeSet = await manager.capture(resources.agentId);
    expect(changeSet.revision).toBe(1);

    // Working clone is mutated after capture (simulating worker changes after unpause)
    writeFileSync(join(workingClone, 'source.ts'), 'export const value = 999999_TAMPERED;\n');

    // getFile for the reviewed revision returns the reviewed commit content (42), not working tree content
    const content = await manager.getFile(resources.agentId, 'app', 'source.ts', 1000);
    expect(content).toBe('export const value = 42;\n');
  });

  it('recovers dependencyManifestStale from disk, blocks unstale promotion, and rejects forged changeSet', async () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'iso-stale-recov-'));
    temporaryRoots.push(root);
    const parent = setupTestRepo(root, 'parent');
    const state = join(root, 'state');

    const config = windowsIsolatedBindConfig();
    const manager1 = new ContainerAgentManager(config, state, createWindowsRuntime(config));

    const resources = await manager1.prepare('agt_iso_recov_stale', worker(), [
      { name: 'app', parentPath: parent, containerPath: 'C:/repos/app', access: 'read-write' },
    ]);

    const workingClone = join(state, 'container-agents', resources.agentId, 'workspaces', 'app');
    writeFileSync(
      join(workingClone, 'package.json'),
      '{"name":"test-repo","version":"2.0.0","dependencies":{"new-pkg":"1.0.0"}}\n',
    );

    const changeSet = await manager1.capture(resources.agentId);
    expect(changeSet.dependency_manifest_stale).toBe(true);

    const staleJsonPath = join(state, 'container-agents', resources.agentId, 'dependency-manifest-stale.json');
    expect(existsSync(staleJsonPath)).toBe(true);
    expect(JSON.parse(readFileSync(staleJsonPath, 'utf8'))).toEqual({ app: true });

    // Test tamper resistance: forged changeSet claiming dependency_manifest_stale: false
    const manager2 = new ContainerAgentManager(config, state, createWindowsRuntime(config));
    const forgedChangeSet = {
      ...changeSet,
      dependency_manifest_stale: false,
      repositories: changeSet.repositories.map((r) => ({ ...r, dependency_manifest_stale: false })),
    };

    await expect(
      manager2.recover({
        agentId: resources.agentId,
        image: config.image,
        repositories: [
          {
            name: 'app',
            parentPath: parent,
            containerPath: 'C:/repos/app',
            access: 'read-write',
            baselineCommit: resources.repositories.get('app')!.snapshot.baselineCommit,
            parentHead: resources.repositories.get('app')!.snapshot.parentHead,
          },
        ],
        changeSet: forgedChangeSet,
      }),
    ).rejects.toThrow('CONTAINER_AGENT_RETAINED_STATE_INVALID');

    // Valid recovery restores dependencyManifestStale
    const manager3 = new ContainerAgentManager(config, state, createWindowsRuntime(config));
    const recovered = await manager3.recover({
      agentId: resources.agentId,
      image: config.image,
      repositories: [
        {
          name: 'app',
          parentPath: parent,
          containerPath: 'C:/repos/app',
          access: 'read-write',
          baselineCommit: resources.repositories.get('app')!.snapshot.baselineCommit,
          parentHead: resources.repositories.get('app')!.snapshot.parentHead,
        },
      ],
      changeSet,
    });

    expect(recovered.repositories.get('app')!.dependencyManifestStale).toBe(true);

    // Promotion without allowStaleDependencies must fail
    await expect(manager3.promote(resources.agentId, changeSet.revision, changeSet.digest)).rejects.toThrow(
      /PROMOTION_DEPENDENCY_MANIFEST_STALE/,
    );

    // Promotion with allowStaleDependencies succeeds
    await expect(
      manager3.promote(resources.agentId, changeSet.revision, changeSet.digest, { allowStaleDependencies: true }),
    ).resolves.not.toThrow();
  });

  it('assertNoReparsePoints fails closed on symlink root, unreadable directory, or unreadable path', () => {
    const root = mkdtempSync(join(testTemporaryDirectory(), 'reparse-check-'));
    temporaryRoots.push(root);

    // 1. Root is a junction/symlink
    const targetDir = join(root, 'target');
    mkdirSync(targetDir);
    const symlinkRoot = join(root, 'link-root');
    symlinkSync(targetDir, symlinkRoot, 'junction');

    expect(() => assertNoReparsePoints(symlinkRoot)).toThrow('CONTAINER_PATCH_INVALID:reparse_point_detected:.');

    // 2. Normal directory passes
    const validDir = join(root, 'valid');
    mkdirSync(validDir);
    writeFileSync(join(validDir, 'file.txt'), 'hello');
    expect(() => assertNoReparsePoints(validDir)).not.toThrow();

    // 3. Nested symlink fails closed
    const nestedLink = join(validDir, 'sublink');
    symlinkSync(targetDir, nestedLink, 'junction');
    expect(() => assertNoReparsePoints(validDir)).toThrow('CONTAINER_PATCH_INVALID:reparse_point_detected:sublink');

    // 4. Unreadable directory fails closed
    const unreadableDir = join(root, 'unreadable-dir');
    mkdirSync(unreadableDir);
    const readdirSpy = vi.spyOn(fs, 'readdirSync');
    readdirSpy.mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied');
    });
    expect(() => assertNoReparsePoints(unreadableDir)).toThrow(/CONTAINER_PATCH_INVALID:unreadable_directory/);
    readdirSpy.mockRestore();

    // 5. Unreadable child path fails closed
    const pathDir = join(root, 'path-check');
    mkdirSync(pathDir);
    writeFileSync(join(pathDir, 'entry.txt'), 'content');
    const lstatSpy = vi.spyOn(fs, 'lstatSync');
    // Root lstat succeeds, child lstat throws
    let lstatCall = 0;
    lstatSpy.mockImplementation((() => {
      lstatCall++;
      if (lstatCall > 1) {
        throw new Error('EACCES: permission denied');
      }
      return {
        isSymbolicLink: () => false,
        isDirectory: () => true,
      } as unknown as fs.Stats;
    }) as unknown as typeof fs.lstatSync);
    expect(() => assertNoReparsePoints(pathDir)).toThrow(/CONTAINER_PATCH_INVALID:unreadable_path/);
    lstatSpy.mockRestore();

    // 6. Unreadable root path fails closed
    const lstatRootSpy = vi.spyOn(fs, 'lstatSync');
    lstatRootSpy.mockImplementationOnce(() => {
      throw new Error('ENOENT: no such file or directory');
    });
    expect(() => assertNoReparsePoints(join(root, 'nonexistent'))).toThrow(/CONTAINER_PATCH_INVALID:unreadable_path/);
    lstatRootSpy.mockRestore();
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

function windowsIsolatedBindConfig(): ContainerConfig {
  return {
    ...windowsContainerConfig(),
    windows_workspace_mode: 'isolated-bind',
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
