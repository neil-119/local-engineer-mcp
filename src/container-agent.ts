import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import type { ContainerChangeSet, ContainerConfig, RepositoryChangeSummary, RunRepository, Worker } from './domain.js';
import type { ContainerAppServerWorker } from './codex.js';
import { relayedModelBaseUrl, writeContainerCodexConfigs } from './container-codex-config.js';
import { ContainerRuntime } from './container-runtime.js';
import {
  checkRepositoryPromotion,
  createRepositorySnapshot,
  promoteRepositoryChanges,
  type RepositoryChanges,
  type RepositorySnapshot,
  writePatchArtifact,
} from './repository-snapshot.js';

interface RepositoryRevision {
  runRepository: RunRepository;
  snapshot: RepositorySnapshot;
  changes?: RepositoryChanges;
  patchPath?: string;
  reviewCommits: Map<number, string>;
}

const MANAGED_DEPENDENCY_PATHS = [
  '.local-engineer-dependencies',
  '.local-pkgs',
  '.venv',
  'node_modules',
  '__pypackages__',
] as const;
const DEPENDENCY_ROOT = '/local-engineer-dependencies';

export interface ContainerAgentResources {
  agentId: string;
  image: string;
  profileRepository?: string;
  workerContainer: string;
  proxyContainer: string;
  internalNetwork: string;
  egressNetwork: string;
  workspaceVolume: string;
  workerConfigVolume: string;
  proxyConfigVolume: string;
  proxySharedVolume: string;
  dependencyVolume: string;
  repositories: Map<string, RepositoryRevision>;
  revision: number;
}

export class ContainerAgentManager {
  private readonly runtime: ContainerRuntime;
  private readonly agents = new Map<string, ContainerAgentResources>();
  private readonly successfulProbes = new Map<string, Awaited<ReturnType<ContainerRuntime['probe']>>>();

  constructor(
    private readonly config: ContainerConfig,
    private readonly stateDir: string,
    runtime?: ContainerRuntime,
  ) {
    this.runtime = runtime ?? new ContainerRuntime(config.command);
  }

  async probe(image = this.config.image) {
    const cached = this.successfulProbes.get(image);
    if (cached) return cached;
    const result = await this.runtime.probe(image);
    if (result.supported) this.successfulProbes.set(image, result);
    return result;
  }

  async prepare(
    agentId: string,
    worker: Worker,
    repositories: RunRepository[],
    image = this.config.image,
    profileRepository?: string,
  ): Promise<ContainerAgentResources> {
    const existing = this.agents.get(agentId);
    if (existing) return existing;
    const suffix = createHash('sha256').update(agentId).digest('hex').slice(0, 20);
    const prefix = `le-${suffix}`;
    const resources: ContainerAgentResources = {
      agentId,
      image,
      profileRepository,
      workerContainer: `${prefix}-worker`,
      proxyContainer: `${prefix}-proxy`,
      internalNetwork: `${prefix}-internal`,
      egressNetwork: `${prefix}-egress`,
      workspaceVolume: `${prefix}-workspace`,
      workerConfigVolume: `${prefix}-worker-config`,
      proxyConfigVolume: `${prefix}-proxy-config`,
      proxySharedVolume: `${prefix}-proxy-shared`,
      dependencyVolume: `${prefix}-dependencies`,
      repositories: new Map(),
      revision: 0,
    };
    const labels = {
      'local-engineer.agent-id': agentId,
      'local-engineer.managed': 'true',
    };
    const agentState = join(this.stateDir, 'container-agents', agentId);
    mkdirSync(agentState, { recursive: true });
    try {
      for (const repository of repositories) {
        const snapshot = await createRepositorySnapshot(
          repository.parentPath,
          join(agentState, 'snapshots', repository.name),
        );
        repository.parentHead = snapshot.parentHead;
        repository.baselineCommit = snapshot.baselineCommit;
        repository.baselineKind = snapshot.baselineKind;
        resources.repositories.set(repository.name, {
          runRepository: repository,
          snapshot,
          reviewCommits: new Map([[0, snapshot.baselineCommit]]),
        });
      }
      const workerConfigPath = join(agentState, 'worker-config.toml');
      const proxyConfigPath = join(agentState, 'proxy-config.toml');
      writeContainerCodexConfigs(worker, this.config, workerConfigPath, proxyConfigPath);

      await this.runtime.createNetwork(resources.internalNetwork, true, labels);
      await this.runtime.createNetwork(resources.egressNetwork, false, labels);
      await this.runtime.createVolume(resources.workspaceVolume, labels);
      await this.runtime.createVolume(resources.workerConfigVolume, labels);
      await this.runtime.createVolume(resources.proxyConfigVolume, labels);
      await this.runtime.createVolume(resources.proxySharedVolume, labels);
      await this.runtime.createVolume(resources.dependencyVolume, labels);
      await this.seedConfigVolume(
        `${prefix}-worker-config-seed`,
        resources.image,
        resources.workerConfigVolume,
        workerConfigPath,
        resources.internalNetwork,
        labels,
      );
      await this.seedDependencyVolume(
        `${prefix}-dependency-seed`,
        resources.image,
        resources.dependencyVolume,
        resources.internalNetwork,
        labels,
      );
      await this.seedConfigVolume(
        `${prefix}-proxy-config-seed`,
        resources.image,
        resources.proxyConfigVolume,
        proxyConfigPath,
        resources.internalNetwork,
        labels,
      );
      await this.runtime.createContainer({
        name: resources.proxyContainer,
        image: resources.image,
        network: resources.internalNetwork,
        networkAliases: ['local-engineer-proxy'],
        labels,
        mounts: [
          `type=volume,src=${resources.proxyConfigVolume},dst=/home/codex/.codex`,
          `type=volume,src=${resources.proxySharedVolume},dst=/proxy-shared`,
        ],
        environment: {
          CODEX_HOME: '/home/codex/.codex',
          LOCAL_ENGINEER_MODEL_UPSTREAM: worker.container_model_provider!.base_url,
        },
        command: ['node', '/usr/local/lib/local-engineer/proxy-sidecar.mjs'],
      });
      await this.runtime.connectNetwork(resources.egressNetwork, resources.proxyContainer);
      await this.runtime.startContainer(resources.proxyContainer);

      await this.seedWorkspaceVolume(`${prefix}-workspace-seed`, resources, labels);
      await this.runtime.createContainer({
        name: resources.workerContainer,
        image: resources.image,
        network: resources.internalNetwork,
        user: this.config.worker_user,
        labels,
        mounts: [
          `type=volume,src=${resources.workspaceVolume},dst=${this.config.workspace_path}`,
          `type=volume,src=${resources.workerConfigVolume},dst=/home/codex/.codex`,
          `type=volume,src=${resources.proxySharedVolume},dst=/proxy-shared,readonly`,
          `type=volume,src=${resources.dependencyVolume},dst=${DEPENDENCY_ROOT}`,
        ],
        environment: {
          CODEX_HOME: '/home/codex/.codex',
          HTTP_PROXY: `http://${resources.proxyContainer}:3128`,
          HTTPS_PROXY: `http://${resources.proxyContainer}:3128`,
          WS_PROXY: `http://${resources.proxyContainer}:3128`,
          WSS_PROXY: `http://${resources.proxyContainer}:3128`,
          ALL_PROXY: `socks5h://${resources.proxyContainer}:8081`,
          NO_PROXY: 'local-engineer-proxy',
          CODEX_CA_CERTIFICATE: '/proxy-shared/ca.pem',
          SSL_CERT_FILE: '/proxy-shared/ca.pem',
          REQUESTS_CA_BUNDLE: '/proxy-shared/ca.pem',
          CURL_CA_BUNDLE: '/proxy-shared/ca.pem',
          NODE_EXTRA_CA_CERTS: '/proxy-shared/ca.pem',
          GIT_SSL_CAINFO: '/proxy-shared/ca.pem',
          PIP_CERT: '/proxy-shared/ca.pem',
          npm_config_cafile: '/proxy-shared/ca.pem',
          LOCAL_ENGINEER_DEPENDENCY_ROOT: DEPENDENCY_ROOT,
          PIP_CACHE_DIR: `${DEPENDENCY_ROOT}/pip-cache`,
          npm_config_cache: `${DEPENDENCY_ROOT}/npm-cache`,
          YARN_CACHE_FOLDER: `${DEPENDENCY_ROOT}/yarn-cache`,
          ...worker.environment,
          ...gitSafeDirectoryEnvironment(repositories),
        },
        inheritEnvironment: worker.environment_from_host,
      });
      await this.runtime.startContainer(resources.workerContainer);
      try {
        await this.runtime.execContainer(resources.workerContainer, [
          'node',
          '--eval',
          [
            "const fs=require('node:fs');",
            'let attempts=0;',
            "const ready=()=>fs.existsSync('/proxy-shared/ready')&&fs.statSync('/proxy-shared/ca.pem').size>0;",
            'const check=()=>{if(ready())process.exit(0);if(++attempts>=120)process.exit(1);setTimeout(check,100)};',
            'check();',
          ].join(''),
        ]);
      } catch {
        const logs = await this.runtime.containerLogs(resources.proxyContainer, 80).catch(() => undefined);
        const excerpt = `${logs?.stdout ?? ''}\n${logs?.stderr ?? ''}`.trim().slice(-4000);
        throw new Error(`CONTAINER_PROXY_NOT_READY:${excerpt || 'no proxy logs'}`);
      }
      writeFileSync(
        join(agentState, 'resources.json'),
        JSON.stringify(
          {
            schema_version: 1,
            agent_id: agentId,
            worker_container: resources.workerContainer,
            proxy_container: resources.proxyContainer,
            internal_network: resources.internalNetwork,
            egress_network: resources.egressNetwork,
            workspace_volume: resources.workspaceVolume,
            worker_config_volume: resources.workerConfigVolume,
            proxy_config_volume: resources.proxyConfigVolume,
            proxy_shared_volume: resources.proxySharedVolume,
            dependency_volume: resources.dependencyVolume,
          },
          null,
          2,
        ),
        { encoding: 'utf8', mode: 0o600 },
      );
      this.agents.set(agentId, resources);
      return resources;
    } catch (cause) {
      await this.cleanupResources(resources);
      rmSync(agentState, { recursive: true, force: true });
      throw cause;
    }
  }

  appServerWorker(worker: Worker, resources: ContainerAgentResources): ContainerAppServerWorker {
    return {
      command: this.config.command,
      args: [
        'exec',
        '--interactive',
        resources.workerContainer,
        this.config.codex_command,
        '-c',
        `model_providers.${worker.model_provider}.base_url=${JSON.stringify(
          relayedModelBaseUrl(worker.container_model_provider!.base_url),
        )}`,
        'app-server',
        '--listen',
        'stdio://',
      ],
      environment: {},
      model: worker.model,
      modelProvider: worker.model_provider,
    };
  }

  private async seedConfigVolume(
    container: string,
    image: string,
    volume: string,
    source: string,
    network: string,
    labels: Record<string, string>,
  ): Promise<void> {
    await this.runtime.createContainer({
      name: container,
      image,
      network,
      user: this.config.worker_user,
      labels,
      mounts: [`type=volume,src=${volume},dst=/home/codex/.codex`],
      command: ['sleep', 'infinity'],
    });
    try {
      await this.runtime.startContainer(container);
      await this.runtime.copyToContainer(source, container, '/home/codex/.codex/config.toml');
    } finally {
      await this.runtime.removeContainer(container, true).catch(() => undefined);
    }
  }

  private async seedDependencyVolume(
    container: string,
    image: string,
    volume: string,
    network: string,
    labels: Record<string, string>,
  ): Promise<void> {
    await this.runtime.createContainer({
      name: container,
      image,
      network,
      user: '0',
      capabilities: ['CHOWN'],
      labels,
      mounts: [`type=volume,src=${volume},dst=${DEPENDENCY_ROOT}`],
      command: ['sleep', 'infinity'],
    });
    try {
      await this.runtime.startContainer(container);
      await this.runtime.execContainer(
        container,
        [
          'mkdir',
          '-p',
          `${DEPENDENCY_ROOT}/pip-cache`,
          `${DEPENDENCY_ROOT}/npm-cache`,
          `${DEPENDENCY_ROOT}/yarn-cache`,
        ],
        {
          user: '0',
        },
      );
      await this.runtime.execContainer(container, ['chown', '-R', this.config.worker_user, DEPENDENCY_ROOT], {
        user: '0',
      });
    } finally {
      await this.runtime.removeContainer(container, true).catch(() => undefined);
    }
  }

  private async seedWorkspaceVolume(
    container: string,
    resources: ContainerAgentResources,
    labels: Record<string, string>,
  ): Promise<void> {
    await this.runtime.createContainer({
      name: container,
      image: resources.image,
      network: resources.internalNetwork,
      user: '0',
      capabilities: ['CHOWN'],
      labels,
      mounts: [`type=volume,src=${resources.workspaceVolume},dst=${this.config.workspace_path}`],
      command: ['sleep', 'infinity'],
    });
    try {
      await this.runtime.startContainer(container);
      for (const repository of resources.repositories.values())
        await this.runtime.execContainer(container, ['mkdir', '-p', repository.runRepository.containerPath], {
          user: '0',
        });
      for (const repository of resources.repositories.values())
        await this.runtime.copyToContainer(
          `${repository.snapshot.snapshotPath}/.`,
          container,
          repository.runRepository.containerPath,
        );
      for (const repository of resources.repositories.values()) {
        for (const path of repository.snapshot.ignoredPaths) {
          const hostPath = join(repository.snapshot.parentPath, path);
          const containerDirectory = posix.dirname(posix.join(repository.runRepository.containerPath, path));
          await this.runtime.execContainer(container, ['mkdir', '-p', containerDirectory], { user: '0' });
          await this.runtime.copyToContainer(hostPath, container, containerDirectory);
        }
      }
      for (const repository of resources.repositories.values()) {
        const privateGitDirectory = posix.join(repository.runRepository.containerPath, '.git');
        await this.runtime.execContainer(container, ['rm', '-rf', privateGitDirectory], { user: '0' });
        await this.runtime.execContainer(container, ['mkdir', '-p', privateGitDirectory], { user: '0' });
        await this.runtime.copyToContainer(
          `${repository.snapshot.snapshotPath}/.git/.`,
          container,
          privateGitDirectory,
        );
        await this.runtime.execContainer(container, ['rm', '-f', posix.join(privateGitDirectory, 'index')], {
          user: '0',
        });
        await this.runtime.execContainer(
          container,
          [
            'sh',
            '-c',
            'target=$1; shift; printf "%s\\n" "$@" >> "$target"',
            'local-engineer-private-exclude',
            posix.join(privateGitDirectory, 'info', 'exclude'),
            ...MANAGED_DEPENDENCY_PATHS.map((path) => `/${path}/`),
          ],
          { user: '0' },
        );
      }
      const profileRepository = resources.profileRepository
        ? resources.repositories.get(resources.profileRepository)
        : undefined;
      if (profileRepository)
        await this.runtime.execContainer(
          container,
          [
            'sh',
            '-c',
            'if [ -d /opt/local-engineer-profile/node/node_modules ]; then rm -rf "$1/node_modules"; cp -a /opt/local-engineer-profile/node/node_modules "$1/node_modules"; fi',
            'local-engineer-profile-seed',
            profileRepository.runRepository.containerPath,
          ],
          { user: '0' },
        );
      await this.runtime.execContainer(
        container,
        ['chown', '-R', this.config.worker_user, this.config.workspace_path],
        {
          user: '0',
        },
      );
      for (const repository of resources.repositories.values())
        await this.runtime.execContainer(
          container,
          ['git', '-C', repository.runRepository.containerPath, 'reset', '--mixed', '--quiet', 'HEAD'],
          { user: this.config.worker_user },
        );
      for (const repository of resources.repositories.values())
        await this.runtime.execContainer(
          container,
          ['git', '-C', repository.runRepository.containerPath, 'diff', '--quiet', '--no-ext-diff'],
          { user: this.config.worker_user },
        );
      for (const repository of resources.repositories.values()) {
        if (repository.runRepository.access !== 'read-only') continue;
        await this.runtime.execContainer(container, ['chown', '-R', '0:0', repository.runRepository.containerPath], {
          user: '0',
        });
        await this.runtime.execContainer(container, ['chmod', '-R', 'a-w', repository.runRepository.containerPath], {
          user: '0',
        });
      }
    } finally {
      await this.runtime.removeContainer(container, true).catch(() => undefined);
    }
  }

  async capture(agentId: string): Promise<ContainerChangeSet> {
    const resources = this.require(agentId);
    const previousRevision = resources.revision;
    const nextRevision = previousRevision + 1;
    const summaries: RepositoryChangeSummary[] = [];
    for (const revision of resources.repositories.values()) {
      if (revision.runRepository.access === 'read-only') {
        const status = await this.runtime.execContainer(
          resources.workerContainer,
          ['git', '-C', revision.runRepository.containerPath, 'status', '--porcelain=v1', '--untracked-files=all'],
          { user: '0' },
        );
        if (status.stdout.trim()) throw new Error(`READ_ONLY_REPOSITORY_CHANGED:${revision.runRepository.name}`);
        const previousCommit = revision.reviewCommits.get(previousRevision);
        if (!previousCommit) throw new Error('CONTAINER_REVIEW_COMMIT_NOT_FOUND');
        revision.reviewCommits.set(nextRevision, previousCommit);
        continue;
      }
      await this.runtime.execContainer(resources.workerContainer, [
        'git',
        '-C',
        revision.runRepository.containerPath,
        'add',
        '-A',
      ]);
      await this.runtime.execContainer(resources.workerContainer, [
        'git',
        '-C',
        revision.runRepository.containerPath,
        'reset',
        '--quiet',
        revision.snapshot.baselineCommit,
        '--',
        ...MANAGED_DEPENDENCY_PATHS,
      ]);
      const patch = (
        await this.runtime.execContainer(resources.workerContainer, [
          'git',
          '-C',
          revision.runRepository.containerPath,
          'diff',
          '--cached',
          '--binary',
          '--full-index',
          '--no-renames',
          revision.snapshot.baselineCommit,
        ])
      ).stdout;
      if (Buffer.byteLength(patch) > 16 * 1024 * 1024) throw new Error('CONTAINER_PATCH_TOO_LARGE');
      const names = (
        await this.runtime.execContainer(resources.workerContainer, [
          'git',
          '-C',
          revision.runRepository.containerPath,
          'diff',
          '--cached',
          '--name-only',
          '-z',
          '--no-renames',
          revision.snapshot.baselineCommit,
        ])
      ).stdout;
      const numstat = (
        await this.runtime.execContainer(resources.workerContainer, [
          'git',
          '-C',
          revision.runRepository.containerPath,
          'diff',
          '--cached',
          '--numstat',
          '--no-renames',
          revision.snapshot.baselineCommit,
        ])
      ).stdout;
      const changes = changesFromOutput(patch, names, numstat);
      if (changes.changedPaths.length > 1000) throw new Error('CONTAINER_TOO_MANY_CHANGED_PATHS');
      for (const path of changes.changedPaths) validateRelativePath(path);
      const previousCommit = revision.reviewCommits.get(previousRevision);
      if (!previousCommit) throw new Error('CONTAINER_REVIEW_COMMIT_NOT_FOUND');
      const deltaPatch = (
        await this.runtime.execContainer(resources.workerContainer, [
          'git',
          '-C',
          revision.runRepository.containerPath,
          'diff',
          '--cached',
          '--binary',
          '--full-index',
          '--no-renames',
          previousCommit,
        ])
      ).stdout;
      const deltaNames = (
        await this.runtime.execContainer(resources.workerContainer, [
          'git',
          '-C',
          revision.runRepository.containerPath,
          'diff',
          '--cached',
          '--name-only',
          '-z',
          '--no-renames',
          previousCommit,
        ])
      ).stdout;
      const deltaNumstat = (
        await this.runtime.execContainer(resources.workerContainer, [
          'git',
          '-C',
          revision.runRepository.containerPath,
          'diff',
          '--cached',
          '--numstat',
          '--no-renames',
          previousCommit,
        ])
      ).stdout;
      const deltaChanges = changesFromOutput(deltaPatch, deltaNames, deltaNumstat);
      for (const path of deltaChanges.changedPaths) validateRelativePath(path);
      revision.changes = changes;
      revision.patchPath = join(
        this.stateDir,
        'container-agents',
        agentId,
        'patches',
        `revision-${nextRevision}`,
        `${revision.runRepository.name}.full.patch`,
      );
      writePatchArtifact(revision.patchPath, changes);
      writePatchArtifact(
        join(
          this.stateDir,
          'container-agents',
          agentId,
          'patches',
          `revision-${nextRevision}`,
          `${revision.runRepository.name}.delta.patch`,
        ),
        deltaChanges,
      );
      await this.runtime.execContainer(resources.workerContainer, [
        'git',
        '-c',
        'user.name=Local Engineer Review',
        '-c',
        'user.email=review@local-engineer.invalid',
        '-c',
        'commit.gpgSign=false',
        '-c',
        'core.hooksPath=/dev/null',
        '-C',
        revision.runRepository.containerPath,
        'commit',
        '--allow-empty',
        '--no-verify',
        '--no-gpg-sign',
        '-m',
        `Local Engineer review revision ${nextRevision}`,
      ]);
      const reviewCommit = (
        await this.runtime.execContainer(resources.workerContainer, [
          'git',
          '-C',
          revision.runRepository.containerPath,
          'rev-parse',
          'HEAD',
        ])
      ).stdout.trim();
      if (!/^[0-9a-f]{40,64}$/.test(reviewCommit)) throw new Error('CONTAINER_REVIEW_COMMIT_INVALID');
      revision.reviewCommits.set(nextRevision, reviewCommit);
      if (changes.changedPaths.length)
        summaries.push({
          repository: revision.runRepository.name,
          changed_paths: changes.changedPaths,
          additions: changes.additions,
          deletions: changes.deletions,
          patch_digest: changes.patchDigest,
          delta_changed_paths: deltaChanges.changedPaths,
          delta_additions: deltaChanges.additions,
          delta_deletions: deltaChanges.deletions,
          delta_patch_digest: deltaChanges.patchDigest,
        });
    }
    resources.revision = nextRevision;
    const digest = `sha256:${createHash('sha256')
      .update(JSON.stringify(summaries.map((summary) => [summary.repository, summary.patch_digest])))
      .digest('hex')}`;
    return {
      revision: resources.revision,
      previous_revision: previousRevision,
      digest,
      repositories: summaries,
    };
  }

  getPatch(agentId: string, repository: string): string {
    const revision = this.require(agentId).repositories.get(repository);
    if (!revision?.patchPath || !existsSync(revision.patchPath)) throw new Error('CONTAINER_PATCH_NOT_FOUND');
    return readFileSync(revision.patchPath, 'utf8');
  }

  async getPatchBetween(
    agentId: string,
    repository: string,
    fromRevision: number,
    toRevision: number,
  ): Promise<string> {
    const resources = this.require(agentId);
    if (
      !Number.isInteger(fromRevision) ||
      !Number.isInteger(toRevision) ||
      fromRevision < 0 ||
      toRevision <= fromRevision ||
      toRevision > resources.revision
    )
      throw new Error('CONTAINER_REVIEW_REVISION_INVALID');
    const revision = resources.repositories.get(repository);
    if (!revision) throw new Error('CONTAINER_REPOSITORY_NOT_FOUND');
    const fromCommit = revision.reviewCommits.get(fromRevision);
    const toCommit = revision.reviewCommits.get(toRevision);
    if (!fromCommit || !toCommit) throw new Error('CONTAINER_REVIEW_COMMIT_NOT_FOUND');
    const patch = (
      await this.runtime.execContainer(resources.workerContainer, [
        'git',
        '-C',
        revision.runRepository.containerPath,
        'diff',
        '--binary',
        '--full-index',
        '--no-renames',
        fromCommit,
        toCommit,
      ])
    ).stdout;
    if (Buffer.byteLength(patch) > 16 * 1024 * 1024) throw new Error('CONTAINER_PATCH_TOO_LARGE');
    return patch;
  }

  async getFile(agentId: string, repository: string, path: string, maximumBytes: number): Promise<string> {
    validateRelativePath(path);
    const resources = this.require(agentId);
    const revision = resources.repositories.get(repository);
    if (!revision) throw new Error('CONTAINER_REPOSITORY_NOT_FOUND');
    const result = await this.runtime.execContainer(resources.workerContainer, [
      'cat',
      '--',
      posix.join(revision.runRepository.containerPath, path.replaceAll('\\', '/')),
    ]);
    if (Buffer.byteLength(result.stdout) > maximumBytes) throw new Error('CONTAINER_FILE_TOO_LARGE');
    if (result.stdout.includes('\0')) throw new Error('CONTAINER_FILE_BINARY');
    return result.stdout;
  }

  async promote(agentId: string, expectedRevision: number, expectedDigest: string): Promise<void> {
    const resources = this.require(agentId);
    if (resources.revision !== expectedRevision) throw new Error('CHANGE_SET_REVISION_MISMATCH');
    const summaries = [...resources.repositories.values()]
      .filter((revision) => revision.changes?.changedPaths.length)
      .map((revision) => [revision.runRepository.name, revision.changes!.patchDigest]);
    const digest = `sha256:${createHash('sha256').update(JSON.stringify(summaries)).digest('hex')}`;
    if (digest !== expectedDigest) throw new Error('CHANGE_SET_DIGEST_MISMATCH');
    const changed = [...resources.repositories.values()].filter((revision) => revision.changes?.changedPaths.length);
    const locks = this.acquirePromotionLocks(changed);
    try {
      for (const revision of changed) await checkRepositoryPromotion(revision.snapshot, revision.changes!);
      const applied: RepositoryRevision[] = [];
      try {
        for (const revision of changed) {
          await promoteRepositoryChanges(revision.snapshot, revision.changes!);
          applied.push(revision);
        }
      } catch (cause) {
        for (const revision of applied.reverse())
          await reversePatch(revision.snapshot.parentPath, revision.changes!.patch).catch(() => undefined);
        throw cause;
      }
    } finally {
      for (const lock of locks.reverse()) {
        closeSync(lock.file);
        if (existsSync(lock.path)) unlinkSync(lock.path);
      }
    }
  }

  async delete(agentId: string): Promise<void> {
    const resources = this.agents.get(agentId);
    if (resources) {
      await this.cleanupResources(resources);
      this.agents.delete(agentId);
    }
    rmSync(join(this.stateDir, 'container-agents', agentId), { recursive: true, force: true });
  }

  private require(agentId: string): ContainerAgentResources {
    const resources = this.agents.get(agentId);
    if (!resources) throw new Error('CONTAINER_AGENT_NOT_FOUND');
    return resources;
  }

  private async cleanupResources(resources: ContainerAgentResources): Promise<void> {
    const labels = {
      'local-engineer.agent-id': resources.agentId,
      'local-engineer.managed': 'true',
    };
    if (await this.runtime.hasOwnershipLabels('container', resources.workerContainer, labels))
      await this.runtime.removeContainer(resources.workerContainer, true).catch(() => undefined);
    if (await this.runtime.hasOwnershipLabels('container', resources.proxyContainer, labels))
      await this.runtime.removeContainer(resources.proxyContainer, true).catch(() => undefined);
    if (await this.runtime.hasOwnershipLabels('network', resources.internalNetwork, labels))
      await this.runtime.removeNetwork(resources.internalNetwork).catch(() => undefined);
    if (await this.runtime.hasOwnershipLabels('network', resources.egressNetwork, labels))
      await this.runtime.removeNetwork(resources.egressNetwork).catch(() => undefined);
    if (await this.runtime.hasOwnershipLabels('volume', resources.workspaceVolume, labels))
      await this.runtime.removeVolume(resources.workspaceVolume).catch(() => undefined);
    if (await this.runtime.hasOwnershipLabels('volume', resources.workerConfigVolume, labels))
      await this.runtime.removeVolume(resources.workerConfigVolume).catch(() => undefined);
    if (await this.runtime.hasOwnershipLabels('volume', resources.proxyConfigVolume, labels))
      await this.runtime.removeVolume(resources.proxyConfigVolume).catch(() => undefined);
    if (await this.runtime.hasOwnershipLabels('volume', resources.proxySharedVolume, labels))
      await this.runtime.removeVolume(resources.proxySharedVolume).catch(() => undefined);
    if (await this.runtime.hasOwnershipLabels('volume', resources.dependencyVolume, labels))
      await this.runtime.removeVolume(resources.dependencyVolume).catch(() => undefined);
  }

  private acquirePromotionLocks(revisions: RepositoryRevision[]): Array<{ path: string; file: number }> {
    const directory = join(this.stateDir, 'promotion-locks');
    mkdirSync(directory, { recursive: true });
    const locks: Array<{ path: string; file: number }> = [];
    try {
      for (const revision of [...revisions].sort((left, right) =>
        left.snapshot.parentPath.localeCompare(right.snapshot.parentPath),
      )) {
        const name = `${createHash('sha256').update(revision.snapshot.parentPath.toLowerCase()).digest('hex')}.lock`;
        const path = join(directory, name);
        const file = openSync(path, 'wx', 0o600);
        writeFileSync(file, JSON.stringify({ pid: process.pid, agent_id: revision.runRepository.name }));
        locks.push({ path, file });
      }
      return locks;
    } catch {
      for (const lock of locks.reverse()) {
        closeSync(lock.file);
        if (existsSync(lock.path)) unlinkSync(lock.path);
      }
      throw new Error('PROMOTION_LOCKED');
    }
  }
}

function gitSafeDirectoryEnvironment(repositories: RunRepository[]): Record<string, string> {
  const readOnly = repositories.filter((repository) => repository.access === 'read-only');
  const environment: Record<string, string> = { GIT_CONFIG_COUNT: String(readOnly.length) };
  readOnly.forEach((repository, index) => {
    environment[`GIT_CONFIG_KEY_${index}`] = 'safe.directory';
    environment[`GIT_CONFIG_VALUE_${index}`] = repository.containerPath;
  });
  return environment;
}

function changesFromOutput(patch: string, names: string, numstat: string): RepositoryChanges {
  let additions = 0;
  let deletions = 0;
  for (const line of numstat.split(/\r?\n/)) {
    if (!line) continue;
    const [added, deleted] = line.split('\t');
    if (added && /^\d+$/.test(added)) additions += Number(added);
    if (deleted && /^\d+$/.test(deleted)) deletions += Number(deleted);
  }
  return {
    patch,
    patchDigest: `sha256:${createHash('sha256').update(patch).digest('hex')}`,
    changedPaths: names.split('\0').filter(Boolean),
    additions,
    deletions,
  };
}

function validateRelativePath(path: string): void {
  if (
    !path ||
    /[\0\r\n]/.test(path) ||
    path.startsWith('/') ||
    path.split(/[\\/]+/).includes('..') ||
    path.split(/[\\/]+/)[0]?.toLowerCase() === '.git'
  )
    throw new Error('CONTAINER_FILE_PATH_INVALID');
}

async function reversePatch(parentPath: string, patch: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('git', ['apply', '--reverse', '--binary', '--whitespace=nowarn', '-'], {
      cwd: resolve(parentPath),
      stdio: 'pipe',
      windowsHide: true,
      shell: false,
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`PROMOTION_ROLLBACK_FAILED:${stderr.slice(0, 1000)}`)),
    );
    child.stdin.end(patch);
  });
}
