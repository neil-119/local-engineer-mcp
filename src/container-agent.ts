import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import type {
  ContainerChangeSet,
  ContainerConfig,
  ContainerPlatform,
  RepositoryChangeSummary,
  RunRepository,
  Worker,
} from './domain.js';
import type { ContainerAppServerWorker } from './codex.js';
import { relayedModelBaseUrl, writeContainerCodexConfigs } from './container-codex-config.js';
import { containerLayout, joinContainerPath, nodeMkdirCommand, nodeRemoveCommand } from './container-platform.js';
import { agentNetworkSubnetCandidates, ContainerRuntime } from './container-runtime.js';
import {
  checkRepositoryPromotion,
  createRepositorySnapshot,
  promoteRepositoryChanges,
  recoverRepositorySnapshot,
  type RepositoryChanges,
  type RepositorySnapshot,
  writePatchArtifact,
} from './repository-snapshot.js';

/**
 * Container Agent Lifecycle & Workspace Isolation
 *
 * Orchestrates disposable Docker container agents across Linux and Windows:
 * - Twin-container architecture: untrusted worker container + strictly brokered proxy sidecar.
 * - Twin-network isolation: internal bridge/NAT (worker <-> proxy) with stripped routes, plus
 *   an external egress network attached strictly to the proxy sidecar.
 * - Volume layout: isolated repository volumes, Codex home, dependency cache, and proxy shared state.
 * - Read-only Windows repositories use Docker read-only volume mounts because Windows named-volume
 *   mount semantics do not reliably enforce in-container NTFS ACL changes.
 * - Atomic Git snapshots and review revisions without polluting the parent repository.
 */

interface RepositoryRevision {
  runRepository: RunRepository;
  snapshot: RepositorySnapshot;
  changes?: RepositoryChanges;
  patchPath?: string;
  reviewCommits: Map<number, string>;
}

/** Dependencies managed outside Git tracking within isolated volumes. */
const MANAGED_DEPENDENCY_PATHS = [
  '.local-engineer-dependencies',
  '.local-pkgs',
  '.venv',
  'node_modules',
  '__pypackages__',
] as const;

/** Complete resource descriptor for an active or recoverable container agent. */
export interface ContainerAgentResources {
  agentId: string;
  image: string;
  profileRepository?: string;
  workerContainer: string;
  proxyContainer: string;
  internalNetwork: string;
  egressNetwork: string;
  workspaceVolume: string;
  repositoryVolumes: Map<string, string>;
  workerConfigVolume: string;
  proxyConfigVolume: string;
  proxySharedVolume: string;
  dependencyVolume: string;
  proxyAddress?: string;
  repositories: Map<string, RepositoryRevision>;
  revision: number;
}

interface RecoveryInput {
  agentId: string;
  image: string;
  repositories: RunRepository[];
  changeSet?: ContainerChangeSet;
}

/**
 * Manages the preparation, network isolation, volume seeding, live supervision,
 * review diff capture, and deletion of containerized worker agents.
 */
export class ContainerAgentManager {
  readonly #promotionHooks?: {
    readonly onBeforePromote?: (repositoryName: string, appliedCount: number) => Promise<void> | void;
    readonly reversePatch?: (parentPath: string, patch: string) => Promise<void>;
  };

  private readonly runtime: ContainerRuntime;
  private readonly agents = new Map<string, ContainerAgentResources>();
  private readonly successfulProbes = new Map<string, Awaited<ReturnType<ContainerRuntime['probe']>>>();

  constructor(
    private readonly config: ContainerConfig,
    private readonly stateDir: string,
    runtime?: ContainerRuntime,
    promotionHooks?: {
      readonly onBeforePromote?: (repositoryName: string, appliedCount: number) => Promise<void> | void;
      readonly reversePatch?: (parentPath: string, patch: string) => Promise<void>;
    },
  ) {
    this.#promotionHooks = promotionHooks ? Object.freeze({ ...promotionHooks }) : undefined;
    this.runtime =
      runtime ??
      new ContainerRuntime(config.command, undefined, config.context, config.platform, {
        memoryLimit: config.windows_memory_limit ?? '4g',
        cpuCount: config.windows_cpu_count ?? 2,
      });
  }

  async probe(image = this.config.image) {
    const cached = this.successfulProbes.get(image);
    if (cached) return cached;
    const result = await this.runtime.probe(image);
    if (result.supported) this.successfulProbes.set(image, result);
    return result;
  }

  async proxyDiagnostic(agentId: string): Promise<string | undefined> {
    const resources = this.agents.get(agentId);
    if (!resources) return undefined;
    const logs = await this.runtime.containerLogs(resources.proxyContainer, 80).catch(() => undefined);
    const text = `${logs?.stdout ?? ''}\n${logs?.stderr ?? ''}`.trim();
    return text ? sanitizeProxyDiagnostic(text) : undefined;
  }

  /** Bounded live change count for parent supervision; paths remain private until review. */
  async liveChangeCount(agentId: string): Promise<number | undefined> {
    const resources = this.agents.get(agentId);
    if (!resources) return undefined;
    let total = 0;
    for (const repository of resources.repositories.values()) {
      const result = await this.runtime
        .execContainer(
          resources.workerContainer,
          ['git', '-C', repository.runRepository.containerPath, 'status', '--porcelain=v1', '-z'],
          { user: this.config.worker_user },
        )
        .catch(() => undefined);
      if (!result || result.exitCode !== 0) return undefined;
      total += result.stdout.split('\0').filter((entry) => /^[ MADRCU?!]{2} /.test(entry)).length;
    }
    return total;
  }

  /**
   * Prepares and initializes the complete container environment for an agent:
   * 1. Takes immutable Git snapshots of all assigned repositories.
   * 2. Creates an isolated internal/egress network pair.
   * 3. Provisions dedicated volumes for workspace, Codex config, proxy shared state, and dependencies.
   * 4. Seeds proxy and worker configuration volumes.
   * 5. Seeds the workspace volume with repository snapshots and strict ACL inheritance.
   * 6. Starts the proxy sidecar and locks down the worker network routing.
   */
  async prepare(
    agentId: string,
    worker: Worker,
    repositories: RunRepository[],
    image = this.config.image,
    profileRepository?: string,
  ): Promise<ContainerAgentResources> {
    const layout = containerLayout(this.config);
    if (this.config.platform === 'windows' && profileRepository) throw new Error('IMAGE_PROFILE_WINDOWS_UNSUPPORTED');
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
      repositoryVolumes: new Map(
        this.config.platform === 'windows'
          ? repositories.map((repository) => [repository.name, repositoryVolumeName(prefix, repository)])
          : [],
      ),
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
      writeFileSync(
        join(agentState, 'snapshots.json'),
        JSON.stringify(
          [...resources.repositories.values()].map(({ runRepository, snapshot }) => ({ runRepository, snapshot })),
          null,
          2,
        ),
        { encoding: 'utf8', mode: 0o600 },
      );
      const workerConfigPath = join(agentState, 'worker-config.toml');
      const proxyConfigPath = join(agentState, 'proxy-config.toml');
      writeContainerCodexConfigs(worker, this.config, workerConfigPath, proxyConfigPath);

      await this.runtime.createNetworkPair({
        internalName: resources.internalNetwork,
        egressName: resources.egressNetwork,
        labels,
        candidates: agentNetworkSubnetCandidates(agentId, this.config.agent_network_pool),
      });
      if (this.config.platform === 'windows') {
        for (const volume of resources.repositoryVolumes.values()) await this.runtime.createVolume(volume, labels);
      } else {
        await this.runtime.createVolume(resources.workspaceVolume, labels);
      }
      await this.runtime.createVolume(resources.workerConfigVolume, labels);
      await this.runtime.createVolume(resources.proxyConfigVolume, labels);
      await this.runtime.createVolume(resources.proxySharedVolume, labels);
      await this.runtime.createVolume(resources.dependencyVolume, labels);
      await this.seedWritableVolume(
        `${prefix}-proxy-shared-seed`,
        resources.image,
        resources.proxySharedVolume,
        layout.proxyShared,
        resources.internalNetwork,
        labels,
      );
      await this.seedConfigVolume(
        `${prefix}-worker-config-seed`,
        resources.image,
        resources.workerConfigVolume,
        workerConfigPath,
        resources.internalNetwork,
        labels,
        true,
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
        true,
      );
      await this.runtime.createContainer({
        name: resources.proxyContainer,
        image: resources.image,
        network: resources.internalNetwork,
        networkAliases: ['local-engineer-proxy'],
        user: this.config.worker_user,
        labels,
        mounts: [
          `type=volume,src=${resources.proxyConfigVolume},dst=${layout.codexHome}`,
          `type=volume,src=${resources.proxySharedVolume},dst=${layout.proxyShared}`,
        ],
        environment: {
          CODEX_HOME: layout.codexHome,
          LOCAL_ENGINEER_MODEL_UPSTREAM: worker.container_model_provider!.base_url,
          LOCAL_ENGINEER_PROXY_SHARED: layout.proxyShared,
          ...(this.config.platform === 'windows'
            ? { LOCAL_ENGINEER_PROXY_EXECUTABLE: 'C:/local-engineer/codex-network-proxy.exe' }
            : {}),
        },
        command: ['node', layout.proxySidecar],
      });
      if (this.config.platform === 'windows') await this.runtime.assertWindowsHyperVIsolation(resources.proxyContainer);
      await this.runtime.connectNetwork(resources.egressNetwork, resources.proxyContainer);
      await this.runtime.startContainer(resources.proxyContainer);
      if (this.config.platform === 'windows')
        resources.proxyAddress = await this.runtime.containerNetworkAddress(
          resources.proxyContainer,
          resources.internalNetwork,
        );

      await this.seedWorkspaceVolume(`${prefix}-workspace-seed`, resources, labels);
      const proxyHost = this.config.platform === 'windows' ? resources.proxyAddress : resources.proxyContainer;
      if (!proxyHost) throw new Error('CONTAINER_PROXY_ADDRESS_MISSING');
      await this.runtime.createContainer({
        name: resources.workerContainer,
        image: resources.image,
        network: resources.internalNetwork,
        user: this.config.worker_user,
        labels,
        mounts: [
          ...this.workerRepositoryMounts(resources),
          `type=volume,src=${resources.workerConfigVolume},dst=${layout.codexHome}`,
          `type=volume,src=${resources.proxySharedVolume},dst=${layout.proxyShared},readonly`,
          `type=volume,src=${resources.dependencyVolume},dst=${layout.dependencyRoot}`,
        ],
        environment: {
          CODEX_HOME: layout.codexHome,
          HTTP_PROXY: `http://${proxyHost}:3128`,
          HTTPS_PROXY: `http://${proxyHost}:3128`,
          WS_PROXY: `http://${proxyHost}:3128`,
          WSS_PROXY: `http://${proxyHost}:3128`,
          ALL_PROXY: `socks5h://${proxyHost}:8081`,
          NO_PROXY: proxyHost,
          CODEX_CA_CERTIFICATE: layout.caFile,
          SSL_CERT_FILE: layout.caFile,
          REQUESTS_CA_BUNDLE: layout.caFile,
          CURL_CA_BUNDLE: layout.caFile,
          NODE_EXTRA_CA_CERTS: layout.caFile,
          GIT_SSL_CAINFO: layout.caFile,
          PIP_CERT: layout.caFile,
          npm_config_cafile: layout.caFile,
          LOCAL_ENGINEER_DEPENDENCY_ROOT: layout.dependencyRoot,
          PIP_CACHE_DIR: `${layout.dependencyRoot}/pip-cache`,
          npm_config_cache: `${layout.dependencyRoot}/npm-cache`,
          YARN_CACHE_FOLDER: `${layout.dependencyRoot}/yarn-cache`,
          ...(this.config.platform === 'windows'
            ? {
                CARGO_HOME: `${layout.dependencyRoot}/cargo-home`,
                RUSTUP_HOME: 'C:/Rust/rustup',
              }
            : {}),
          ...worker.environment,
          ...gitSafeDirectoryEnvironment(repositories, this.config.platform),
        },
        inheritEnvironment: worker.environment_from_host,
      });
      if (this.config.platform === 'windows')
        await this.runtime.assertWindowsHyperVIsolation(resources.workerContainer);
      await this.runtime.startContainer(resources.workerContainer);
      if (this.config.platform === 'windows') await this.configureWindowsWorkerNetwork(resources);
      if (this.config.platform === 'windows') await this.assertWindowsRepositoryMounts(resources);
      try {
        await this.runtime.execContainer(resources.workerContainer, [
          'node',
          '--eval',
          [
            "const fs=require('node:fs');",
            'let attempts=0;',
            `const ready=()=>fs.existsSync(${JSON.stringify(joinContainerPath(this.config.platform, layout.proxyShared, 'ready'))})&&fs.statSync(${JSON.stringify(layout.caFile)}).size>0;`,
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
            schema_version: 2,
            agent_id: agentId,
            worker_container: resources.workerContainer,
            proxy_container: resources.proxyContainer,
            internal_network: resources.internalNetwork,
            egress_network: resources.egressNetwork,
            workspace_volume: resources.workspaceVolume,
            repository_volumes: Object.fromEntries(resources.repositoryVolumes),
            worker_config_volume: resources.workerConfigVolume,
            proxy_config_volume: resources.proxyConfigVolume,
            proxy_shared_volume: resources.proxySharedVolume,
            dependency_volume: resources.dependencyVolume,
            proxy_address: resources.proxyAddress,
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

  /** Reconstruct retained disposable-agent handles after an STDIO MCP process changes. */
  async recover(input: RecoveryInput): Promise<ContainerAgentResources> {
    const existing = this.agents.get(input.agentId);
    if (existing) return existing;
    const suffix = createHash('sha256').update(input.agentId).digest('hex').slice(0, 20);
    const prefix = `le-${suffix}`;
    const state = join(this.stateDir, 'container-agents', input.agentId);
    const resourcePath = join(state, 'resources.json');
    if (!existsSync(resourcePath)) throw new Error('CONTAINER_AGENT_RETAINED_STATE_NOT_FOUND');
    const persisted = JSON.parse(readFileSync(resourcePath, 'utf8')) as Record<string, unknown>;
    const expected = {
      worker_container: `${prefix}-worker`,
      proxy_container: `${prefix}-proxy`,
      internal_network: `${prefix}-internal`,
      egress_network: `${prefix}-egress`,
      workspace_volume: `${prefix}-workspace`,
      worker_config_volume: `${prefix}-worker-config`,
      proxy_config_volume: `${prefix}-proxy-config`,
      proxy_shared_volume: `${prefix}-proxy-shared`,
      dependency_volume: `${prefix}-dependencies`,
    };
    const expectedRepositoryVolumes = Object.fromEntries(
      this.config.platform === 'windows'
        ? input.repositories.map((repository) => [repository.name, repositoryVolumeName(prefix, repository)])
        : [],
    );
    if (
      persisted.agent_id !== input.agentId ||
      Object.entries(expected).some(([key, value]) => persisted[key] !== value) ||
      (this.config.platform === 'windows' &&
        JSON.stringify(persisted.repository_volumes) !== JSON.stringify(expectedRepositoryVolumes))
    )
      throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
    const snapshotsPath = join(state, 'snapshots.json');
    const savedSnapshots = existsSync(snapshotsPath)
      ? (JSON.parse(readFileSync(snapshotsPath, 'utf8')) as Array<{
          runRepository: RunRepository;
          snapshot: RepositorySnapshot;
        }>)
      : [];
    const resources: ContainerAgentResources = {
      agentId: input.agentId,
      image: input.image,
      profileRepository: input.repositories[0]?.name,
      workerContainer: expected.worker_container,
      proxyContainer: expected.proxy_container,
      internalNetwork: expected.internal_network,
      egressNetwork: expected.egress_network,
      workspaceVolume: expected.workspace_volume,
      repositoryVolumes: new Map(Object.entries(expectedRepositoryVolumes)),
      workerConfigVolume: expected.worker_config_volume,
      proxyConfigVolume: expected.proxy_config_volume,
      proxySharedVolume: expected.proxy_shared_volume,
      dependencyVolume: expected.dependency_volume,
      ...(typeof persisted.proxy_address === 'string' ? { proxyAddress: persisted.proxy_address } : {}),
      repositories: new Map(),
      revision: input.changeSet?.revision ?? 0,
    };
    if (this.config.platform === 'windows') {
      if (!resources.proxyAddress) throw new Error('CONTAINER_PROXY_ADDRESS_MISSING');
      await this.runtime.assertWindowsHyperVIsolation(resources.proxyContainer);
      await this.runtime.assertWindowsHyperVIsolation(resources.workerContainer);
      const liveProxyAddress = await this.runtime.containerNetworkAddress(
        resources.proxyContainer,
        resources.internalNetwork,
      );
      if (liveProxyAddress !== resources.proxyAddress) throw new Error('CONTAINER_PROXY_ADDRESS_CHANGED');
      await this.configureWindowsWorkerNetwork(resources);
    }
    for (const repository of input.repositories) {
      const saved = savedSnapshots.find((entry) => entry.runRepository.name === repository.name);
      const snapshotPath = saved?.snapshot.snapshotPath ?? join(state, 'snapshots', repository.name);
      if (!existsSync(snapshotPath) || !repository.baselineCommit || !repository.parentHead)
        throw new Error('CONTAINER_AGENT_RECOVERY_SNAPSHOT_NOT_FOUND');
      const snapshot: RepositorySnapshot =
        saved?.snapshot ??
        (await recoverRepositorySnapshot(
          repository.parentPath,
          snapshotPath,
          repository.parentHead,
          repository.baselineCommit,
          repository.baselineKind ?? 'clean_head',
        ));
      const reviewCommits = new Map<number, string>([[0, snapshot.baselineCommit]]);
      if (resources.revision > 0) {
        const head = (
          await this.runtime.execContainer(resources.workerContainer, [
            'git',
            '-C',
            repository.containerPath,
            'rev-parse',
            'HEAD',
          ])
        ).stdout.trim();
        if (!/^[0-9a-f]{40,64}$/i.test(head)) throw new Error('CONTAINER_AGENT_RECOVERY_REVIEW_COMMIT_INVALID');
        reviewCommits.set(resources.revision, head);
      }
      const summary = input.changeSet?.repositories.find((item) => item.repository === repository.name);
      const patchPath = summary
        ? join(state, 'patches', `revision-${resources.revision}`, `${repository.name}.full.patch`)
        : undefined;
      const changes =
        summary && patchPath && existsSync(patchPath)
          ? {
              patch: readFileSync(patchPath, 'utf8'),
              patchDigest: summary.patch_digest,
              changedPaths: summary.changed_paths,
              additions: summary.additions,
              deletions: summary.deletions,
            }
          : undefined;
      resources.repositories.set(repository.name, {
        runRepository: repository,
        snapshot,
        changes,
        patchPath,
        reviewCommits,
      });
    }
    this.agents.set(input.agentId, resources);
    return resources;
  }

  appServerWorker(worker: Worker, resources: ContainerAgentResources): ContainerAppServerWorker {
    const relayAuthority = this.config.platform === 'windows' ? resources.proxyAddress : undefined;
    if (this.config.platform === 'windows' && !relayAuthority) throw new Error('CONTAINER_PROXY_ADDRESS_MISSING');
    return {
      command: this.config.command,
      args: [
        ...(this.config.context ? ['--context', this.config.context] : []),
        'exec',
        '--interactive',
        resources.workerContainer,
        this.config.codex_command,
        '-c',
        `model_providers.${worker.model_provider}.base_url=${JSON.stringify(
          relayedModelBaseUrl(worker.container_model_provider!.base_url, relayAuthority),
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

  /**
   * Seeds Codex configuration into an isolated volume.
   * On Windows, locks down `$CODEX_HOME/tmp/arg0` to prevent Codex from dynamically
   * creating PATH aliases that shadow container tools (such as apply_patch).
   */
  private async seedConfigVolume(
    container: string,
    image: string,
    volume: string,
    source: string,
    network: string,
    labels: Record<string, string>,
    writable: boolean,
  ): Promise<void> {
    const layout = containerLayout(this.config);
    await this.runtime.createContainer({
      name: container,
      image,
      network,
      user: this.config.platform === 'windows' ? layout.administratorUser : this.config.worker_user,
      labels,
      mounts: [`type=volume,src=${volume},dst=${layout.codexHome}`],
      command: layout.keepAliveCommand,
    });
    try {
      if (this.config.platform === 'windows') await this.runtime.assertWindowsHyperVIsolation(container);
      await this.runtime.startContainer(container);
      if (this.config.platform === 'windows') await this.configureWindowsNetwork(container, network);
      await this.runtime.copyToContainer(
        source,
        container,
        joinContainerPath(this.config.platform, layout.codexHome, 'config.toml'),
      );
      if (this.config.platform === 'windows') {
        await this.runtime.execContainer(
          container,
          ['icacls.exe', layout.codexHome, '/grant:r', `*S-1-5-93-2-2:(OI)(CI)${writable ? 'M' : 'RX'}`, '/T', '/C'],
          { user: layout.administratorUser },
        );
        if (writable) {
          const tmpDir = joinContainerPath(this.config.platform, layout.codexHome, 'tmp');
          const arg0File = joinContainerPath(this.config.platform, layout.codexHome, 'tmp', 'arg0');
          await this.runtime.execContainer(
            container,
            [
              'powershell.exe',
              '-NoLogo',
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `Remove-Item -Recurse -Force "${tmpDir}" -ErrorAction SilentlyContinue; ` +
                `New-Item -ItemType Directory -Force "${tmpDir}" | Out-Null; ` +
                `New-Item -ItemType File -Force "${arg0File}" | Out-Null; ` +
                `Set-ItemProperty -Path "${arg0File}" -Name IsReadOnly -Value $true; ` +
                `icacls.exe "${tmpDir}" /deny "*S-1-5-93-2-2:(DC)" | Out-Null; ` +
                `icacls.exe "${arg0File}" /deny "*S-1-5-93-2-2:(D,WDAC,WO)" | Out-Null`,
            ],
            { user: layout.administratorUser },
          );
        }
      }
    } finally {
      await this.runtime.removeContainer(container, true).catch(() => undefined);
    }
  }

  /**
   * Initializes the shared dependency volume with cache directories (pip, npm, yarn)
   * and grants ContainerUser modify access.
   */
  private async seedDependencyVolume(
    container: string,
    image: string,
    volume: string,
    network: string,
    labels: Record<string, string>,
  ): Promise<void> {
    const layout = containerLayout(this.config);
    await this.runtime.createContainer({
      name: container,
      image,
      network,
      user: layout.administratorUser,
      capabilities: ['CHOWN'],
      labels,
      mounts: [`type=volume,src=${volume},dst=${layout.dependencyRoot}`],
      command: layout.keepAliveCommand,
    });
    try {
      if (this.config.platform === 'windows') await this.runtime.assertWindowsHyperVIsolation(container);
      await this.runtime.startContainer(container);
      if (this.config.platform === 'windows') await this.configureWindowsNetwork(container, network);
      await this.runtime.execContainer(
        container,
        nodeMkdirCommand(
          `${layout.dependencyRoot}/pip-cache`,
          `${layout.dependencyRoot}/npm-cache`,
          `${layout.dependencyRoot}/yarn-cache`,
        ),
        {
          user: layout.administratorUser,
        },
      );
      if (this.config.platform === 'windows')
        await this.runtime.execContainer(
          container,
          ['icacls.exe', layout.dependencyRoot, '/grant:r', '*S-1-5-93-2-2:(OI)(CI)M', '/T', '/C'],
          { user: layout.administratorUser },
        );
      else
        await this.runtime.execContainer(container, ['chown', '-R', this.config.worker_user, layout.dependencyRoot], {
          user: layout.administratorUser,
        });
    } finally {
      await this.runtime.removeContainer(container, true).catch(() => undefined);
    }
  }

  /**
   * Initializes a general writable volume with ContainerUser modify permissions on Windows.
   */
  private async seedWritableVolume(
    container: string,
    image: string,
    volume: string,
    destination: string,
    network: string,
    labels: Record<string, string>,
  ): Promise<void> {
    const layout = containerLayout(this.config);
    if (this.config.platform !== 'windows') return;
    await this.runtime.createContainer({
      name: container,
      image,
      network,
      user: layout.administratorUser,
      labels,
      mounts: [`type=volume,src=${volume},dst=${destination}`],
      command: layout.keepAliveCommand,
    });
    try {
      await this.runtime.assertWindowsHyperVIsolation(container);
      await this.runtime.startContainer(container);
      await this.configureWindowsNetwork(container, network);
      await this.runtime.execContainer(
        container,
        ['icacls.exe', destination, '/grant:r', '*S-1-5-93-2-2:(OI)(CI)M', '/T', '/C'],
        { user: layout.administratorUser },
      );
    } finally {
      await this.runtime.removeContainer(container, true).catch(() => undefined);
    }
  }

  /**
   * Seeds agent repository volumes using an ephemeral setup container:
   * 1. Copies pristine repository snapshots and overlays host uncommitted state.
   * 2. Reconstructs a clean private `.git` directory and resets the index against HEAD.
   * 3. Masks managed dependency directories from Git status via `.git/info/exclude`.
   * 4. Applies Unix ownership/mode lockdown on Linux. Windows read-only enforcement is applied
   *    later by mounting each repository volume read-only in the worker container.
   */
  private async seedWorkspaceVolume(
    container: string,
    resources: ContainerAgentResources,
    labels: Record<string, string>,
  ): Promise<void> {
    const layout = containerLayout(this.config);
    await this.runtime.createContainer({
      name: container,
      image: resources.image,
      network: resources.internalNetwork,
      user: layout.administratorUser,
      capabilities: ['CHOWN'],
      labels,
      mounts:
        this.config.platform === 'windows'
          ? [...resources.repositories.values()].map((repository) => {
              const volume = resources.repositoryVolumes.get(repository.runRepository.name);
              if (!volume) throw new Error('CONTAINER_REPOSITORY_VOLUME_MISSING');
              return `type=volume,src=${volume},dst=${repository.runRepository.containerPath}`;
            })
          : [`type=volume,src=${resources.workspaceVolume},dst=${this.config.workspace_path}`],
      command: layout.keepAliveCommand,
    });
    try {
      if (this.config.platform === 'windows') await this.runtime.assertWindowsHyperVIsolation(container);
      await this.runtime.startContainer(container);
      if (this.config.platform === 'windows') await this.configureWindowsNetwork(container, resources.internalNetwork);
      for (const repository of resources.repositories.values())
        await this.runtime.execContainer(
          container,
          this.config.platform === 'windows'
            ? nodeMkdirCommand(repository.runRepository.containerPath)
            : ['mkdir', '-p', repository.runRepository.containerPath],
          { user: layout.administratorUser },
        );
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
          await this.runtime.execContainer(
            container,
            this.config.platform === 'windows'
              ? nodeMkdirCommand(containerDirectory)
              : ['mkdir', '-p', containerDirectory],
            { user: layout.administratorUser },
          );
          await this.runtime.copyToContainer(hostPath, container, containerDirectory);
        }
      }
      for (const repository of resources.repositories.values()) {
        const privateGitDirectory = posix.join(repository.runRepository.containerPath, '.git');
        await this.runtime.execContainer(
          container,
          this.config.platform === 'windows'
            ? nodeRemoveCommand(privateGitDirectory, true)
            : ['rm', '-rf', privateGitDirectory],
          { user: layout.administratorUser },
        );
        await this.runtime.execContainer(
          container,
          this.config.platform === 'windows'
            ? nodeMkdirCommand(privateGitDirectory)
            : ['mkdir', '-p', privateGitDirectory],
          { user: layout.administratorUser },
        );
        await this.runtime.copyToContainer(
          `${repository.snapshot.snapshotPath}/.git/.`,
          container,
          privateGitDirectory,
        );
        await this.runtime.execContainer(
          container,
          this.config.platform === 'windows'
            ? nodeRemoveCommand(posix.join(privateGitDirectory, 'index'))
            : ['rm', '-f', posix.join(privateGitDirectory, 'index')],
          { user: layout.administratorUser },
        );
        await this.runtime.execContainer(
          container,
          this.config.platform === 'windows'
            ? [
                'node',
                '--eval',
                "const fs=require('node:fs');fs.appendFileSync(process.argv[1],process.argv.slice(2).join('\\n')+'\\n')",
                posix.join(privateGitDirectory, 'info', 'exclude'),
                ...MANAGED_DEPENDENCY_PATHS.map((path) => `/${path}/`),
              ]
            : [
                'sh',
                '-c',
                'target=$1; shift; printf "%s\\n" "$@" >> "$target"',
                'local-engineer-private-exclude',
                posix.join(privateGitDirectory, 'info', 'exclude'),
                ...MANAGED_DEPENDENCY_PATHS.map((path) => `/${path}/`),
              ],
          { user: layout.administratorUser },
        );
      }
      const profileRepository = resources.profileRepository
        ? resources.repositories.get(resources.profileRepository)
        : undefined;
      if (profileRepository && this.config.platform === 'linux')
        await this.runtime.execContainer(
          container,
          [
            'sh',
            '-c',
            'if [ -d /opt/local-engineer-profile/node/node_modules ]; then rm -rf "$1/node_modules"; cp -a /opt/local-engineer-profile/node/node_modules "$1/node_modules"; fi',
            'local-engineer-profile-seed',
            profileRepository.runRepository.containerPath,
          ],
          { user: layout.administratorUser },
        );
      if (this.config.platform !== 'windows') {
        await this.runtime.execContainer(
          container,
          ['chown', '-R', this.config.worker_user, this.config.workspace_path],
          { user: layout.administratorUser },
        );
      } else {
        await this.runtime.execContainer(
          container,
          ['icacls.exe', this.config.workspace_path, '/grant:r', '*S-1-5-93-2-2:(OI)(CI)M', '/T', '/C'],
          { user: layout.administratorUser },
        );
        for (const repository of resources.repositories.values()) {
          if (repository.runRepository.access === 'read-only') continue;
          await this.runtime.execContainer(
            container,
            ['icacls.exe', repository.runRepository.containerPath, '/grant:r', '*S-1-5-93-2-2:(OI)(CI)M', '/T', '/C'],
            { user: layout.administratorUser },
          );
        }
      }
      const safeDirEnv =
        this.config.platform === 'windows'
          ? gitSafeDirectoryEnvironment(
              [...resources.repositories.values()].map((r) => r.runRepository),
              'windows',
            )
          : undefined;
      for (const repository of resources.repositories.values())
        await this.runtime.execContainer(
          container,
          ['git', '-C', repository.runRepository.containerPath, 'reset', '--mixed', '--quiet', 'HEAD'],
          { user: this.config.worker_user, environment: safeDirEnv },
        );
      for (const repository of resources.repositories.values())
        await this.runtime.execContainer(
          container,
          ['git', '-C', repository.runRepository.containerPath, 'diff', '--quiet', '--no-ext-diff'],
          { user: this.config.worker_user, environment: safeDirEnv },
        );
      for (const repository of resources.repositories.values()) {
        if (repository.runRepository.access !== 'read-only') continue;
        if (this.config.platform !== 'windows') {
          await this.runtime.execContainer(container, ['chown', '-R', '0:0', repository.runRepository.containerPath], {
            user: layout.administratorUser,
          });
          await this.runtime.execContainer(container, ['chmod', '-R', 'a-w', repository.runRepository.containerPath], {
            user: layout.administratorUser,
          });
        }
      }
    } finally {
      await this.runtime.removeContainer(container, true).catch(() => undefined);
    }
  }

  private workerRepositoryMounts(resources: ContainerAgentResources): string[] {
    if (this.config.platform !== 'windows')
      return [`type=volume,src=${resources.workspaceVolume},dst=${this.config.workspace_path}`];
    return [...resources.repositories.values()].map((repository) => {
      const volume = resources.repositoryVolumes.get(repository.runRepository.name);
      if (!volume) throw new Error('CONTAINER_REPOSITORY_VOLUME_MISSING');
      return `type=volume,src=${volume},dst=${repository.runRepository.containerPath}${
        repository.runRepository.access === 'read-only' ? ',readonly' : ''
      }`;
    });
  }

  private async assertWindowsRepositoryMounts(resources: ContainerAgentResources): Promise<void> {
    for (const repository of resources.repositories.values()) {
      if (repository.runRepository.access !== 'read-only') continue;
      const probePath = joinContainerPath(
        'windows',
        repository.runRepository.containerPath,
        `.local-engineer-read-only-probe-${createHash('sha256')
          .update(`${resources.agentId}\0${repository.runRepository.name}`)
          .digest('hex')
          .slice(0, 16)}`,
      );
      const result = await this.runtime.execContainer(
        resources.workerContainer,
        [
          'node',
          '--eval',
          "const fs=require('node:fs');const p=process.argv[1];if(fs.existsSync(p)){process.stdout.write('COLLISION')}else{try{fs.writeFileSync(p,'x');fs.unlinkSync(p);process.stdout.write('WRITABLE')}catch(e){if(e&&['EACCES','EPERM','EROFS'].includes(e.code))process.stdout.write('LOCKED');else throw e}}",
          probePath,
        ],
        { user: this.config.worker_user },
      );
      if (result.stdout.trim() !== 'LOCKED') throw new Error('CONTAINER_WINDOWS_READ_ONLY_MOUNT_UNAVAILABLE');
    }
  }

  private async configureWindowsWorkerNetwork(resources: ContainerAgentResources): Promise<void> {
    if (!resources.proxyAddress) throw new Error('CONTAINER_WINDOWS_NETWORK_INPUT_INVALID');
    await this.configureWindowsNetwork(
      resources.workerContainer,
      resources.internalNetwork,
      resources.proxyAddress,
      true,
    );
  }

  private async configureWindowsNetwork(
    container: string,
    network: string,
    proxyAddress?: string,
    verifyWorkerIdentity = false,
  ): Promise<void> {
    const layout = containerLayout(this.config);
    if (!layout.networkScript) throw new Error('CONTAINER_WINDOWS_NETWORK_INPUT_INVALID');
    const endpoint = await this.runtime.containerNetworkEndpoint(container, network);
    const result = await this.runtime.execContainer(
      container,
      [
        layout.powershellExecutable,
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        layout.networkScript,
        '-ContainerAddress',
        endpoint.address,
        '-InterfaceMacAddress',
        endpoint.macAddress,
        ...(proxyAddress ? ['-ProxyAddress', proxyAddress] : []),
      ],
      { user: layout.administratorUser, workdir: layout.safeAdminWorkdir },
    );
    if (result.stdout.trim() !== 'LOCAL_ENGINEER_NETWORK_OK')
      throw new Error('CONTAINER_WINDOWS_NETWORK_VERIFICATION_FAILED');
    if (!verifyWorkerIdentity) return;
    const groups = await this.runtime.execContainer(container, [layout.whoamiExecutable, '/groups'], {
      user: this.config.worker_user,
    });
    if (/S-1-5-32-544|BUILTIN\\Administrators/i.test(groups.stdout))
      throw new Error('CONTAINER_WINDOWS_WORKER_IS_ADMINISTRATOR');
  }

  /**
   * Captures changes across all assigned repositories into a new immutable review revision:
   * - Unstages private index, verifies read-only repository integrity, and creates a review commit.
   * - Extracts unified diffs, changed file lists, and SHA-256 patch digests.
   * - Writes patch artifacts to disk for parent agent inspection.
   */
  async capture(agentId: string): Promise<ContainerChangeSet> {
    const resources = this.require(agentId);
    const layout = containerLayout(this.config);
    const previousRevision = resources.revision;
    const nextRevision = previousRevision + 1;
    const summaries: RepositoryChangeSummary[] = [];
    for (const revision of resources.repositories.values()) {
      if (revision.runRepository.access === 'read-only') {
        const status = await this.runtime.execContainer(
          resources.workerContainer,
          [
            layout.gitExecutable,
            '-C',
            revision.runRepository.containerPath,
            'status',
            '--porcelain=v1',
            '--untracked-files=all',
          ],
          { user: layout.administratorUser, workdir: layout.safeAdminWorkdir },
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
      'node',
      '--eval',
      "process.stdout.write(require('node:fs').readFileSync(process.argv[1],'utf8'))",
      posix.join(revision.runRepository.containerPath, path.replaceAll('\\', '/')),
    ]);
    if (Buffer.byteLength(result.stdout) > maximumBytes) throw new Error('CONTAINER_FILE_TOO_LARGE');
    if (result.stdout.includes('\0')) throw new Error('CONTAINER_FILE_BINARY');
    return result.stdout;
  }

  /**
   * Validates and promotes reviewed changes to the host repository:
   * - Acquires file locks on affected host repositories.
   * - Confirms revision number and patch digest match the reviewed state.
   * - Verifies parent repository working tree has not diverged since the baseline snapshot.
   * - Applies patches to the host working tree and index, rolling back on failure.
   */
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
      const reversePatchFn = this.#promotionHooks?.reversePatch ?? reversePatch;
      try {
        for (const revision of changed) {
          if (this.#promotionHooks?.onBeforePromote) {
            await this.#promotionHooks.onBeforePromote(revision.runRepository.name, applied.length);
          }
          await promoteRepositoryChanges(revision.snapshot, revision.changes!);
          applied.push(revision);
        }
      } catch (cause) {
        const rollbackFailures: Array<{ repository: string; error: string }> = [];
        for (const revision of applied.reverse()) {
          try {
            await reversePatchFn(revision.snapshot.parentPath, revision.changes!.patch);
          } catch (rollbackError) {
            rollbackFailures.push({
              repository: revision.runRepository.name,
              error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            });
          }
        }
        if (rollbackFailures.length > 0) {
          const failureDetails = rollbackFailures.map((f) => `${f.repository}: ${f.error}`).join('; ');
          throw new Error(
            `PROMOTION_ROLLBACK_INCOMPLETE: Promotion failed and rollback could not be completed cleanly for repository: ${failureDetails}. Original error: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        }
        throw cause;
      }
    } finally {
      for (const lock of locks.reverse()) {
        closeSync(lock.file);
        if (existsSync(lock.path)) unlinkSync(lock.path);
      }
    }
  }

  /**
   * Deletes all Docker resources associated with an agent:
   * - Destroys worker and proxy containers.
   * - Tears down internal and egress bridge/NAT networks.
   * - Deletes workspace, config, dependency, and shared proxy volumes.
   * - Purges the agent's state directory.
   */
  async delete(agentId: string): Promise<void> {
    const suffix = createHash('sha256').update(agentId).digest('hex').slice(0, 20);
    const prefix = `le-${suffix}`;
    const resources =
      this.agents.get(agentId) ??
      ({
        agentId,
        image: '',
        workerContainer: `${prefix}-worker`,
        proxyContainer: `${prefix}-proxy`,
        internalNetwork: `${prefix}-internal`,
        egressNetwork: `${prefix}-egress`,
        workspaceVolume: `${prefix}-workspace`,
        repositoryVolumes: new Map(),
        workerConfigVolume: `${prefix}-worker-config`,
        proxyConfigVolume: `${prefix}-proxy-config`,
        proxySharedVolume: `${prefix}-proxy-shared`,
        dependencyVolume: `${prefix}-dependencies`,
        repositories: new Map(),
        revision: 0,
      } satisfies ContainerAgentResources);
    await this.cleanupResources(resources);
    this.agents.delete(agentId);
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
    for (const container of await this.runtime.listContainersByLabels(labels).catch(() => []))
      await this.runtime.removeContainer(container, true).catch(() => undefined);
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
    for (const volume of await this.runtime.listVolumesByLabels(labels).catch(() => []))
      await this.runtime.removeVolume(volume).catch(() => undefined);
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

export function sanitizeProxyDiagnostic(value: string): string {
  return value
    .replace(/\b(authorization|api[_-]?key|token|password)\s*[:=]\s*\S+/gi, '$1=<redacted>')
    .replace(/https?:\/\/[^\s"']+/gi, '<url-redacted>')
    .replace(/[\r\n]+/g, ' ')
    .replaceAll('\0', ' ')
    .trim()
    .slice(-2000);
}

function gitSafeDirectoryEnvironment(
  repositories: RunRepository[],
  platform?: ContainerPlatform,
): Record<string, string> {
  const matching =
    platform === 'windows' ? repositories : repositories.filter((repository) => repository.access === 'read-only');
  const environment: Record<string, string> = { GIT_CONFIG_COUNT: String(matching.length) };
  matching.forEach((repository, index) => {
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
    path.startsWith('\\') ||
    /^[a-zA-Z]:/.test(path) ||
    path.includes(':') ||
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
    child.stdin.on('error', () => undefined);
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

function repositoryVolumeName(prefix: string, repository: Pick<RunRepository, 'name'>): string {
  const hash = createHash('sha256').update(repository.name).digest('hex').slice(0, 12);
  const slug = repository.name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return `${prefix}-repo-${slug ? `${slug}-` : ''}${hash}`;
}
