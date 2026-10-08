import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs, {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, normalize, posix, relative, resolve } from 'node:path';
import type {
  ContainerChangeSet,
  ContainerConfig,
  ContainerPlatform,
  ContainerPreparationTimings,
  DependencyMode,
  PrivateInstallTarget,
  RepositoryChangeSummary,
  RunRepository,
  WindowsDependencyMount,
  WindowsRepositoryMount,
  Worker,
} from './domain.js';
import type { ContainerAppServerWorker } from './codex.js';
import { relayedModelBaseUrl, writeContainerCodexConfigs } from './container-codex-config.js';
import { containerLayout, joinContainerPath, nodeMkdirCommand, nodeRemoveCommand } from './container-platform.js';
import { agentNetworkSubnetCandidates, ContainerRuntime } from './container-runtime.js';
import {
  assertNoManagedDependencyPaths,
  discoverDependencyMounts,
  discoverPrivateInstallTargets,
  isDependencyManifestChanged,
  isManagedDependencyPath,
  MANAGED_DEPENDENCY_DIR_NAMES,
  MANAGED_DEPENDENCY_EXCLUDE_PATTERNS,
  privateInstallVolumeName,
  resolvePrimaryInstallTarget,
} from './dependency-mount.js';
import {
  checkRepositoryPromotion,
  createRepositorySnapshot,
  git,
  promoteRepositoryChanges,
  recoverRepositorySnapshot,
  type RepositoryChanges,
  type RepositorySnapshot,
  writePatchArtifact,
} from './repository-snapshot.js';

export {
  assertNoManagedDependencyPaths,
  isManagedDependencyPath,
  MANAGED_DEPENDENCY_DIR_NAMES,
  MANAGED_DEPENDENCY_EXCLUDE_PATTERNS,
};

/** Dependencies managed outside Git tracking within isolated volumes. */
export const MANAGED_DEPENDENCY_PATHS = MANAGED_DEPENDENCY_DIR_NAMES;

interface RepositoryRevision {
  runRepository: RunRepository;
  snapshot: RepositorySnapshot;
  changes?: RepositoryChanges;
  patchPath?: string;
  reviewCommits: Map<number, string>;
  workingClonePath?: string;
  dependencyMounts?: WindowsDependencyMount[];
  dependencyManifestStale?: boolean;
}

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
  windowsRepositoryMounts?: Map<string, WindowsRepositoryMount>;
  windowsWorkspaceMode?: 'volume-copy' | 'isolated-bind';
  workerConfigVolume: string;
  proxyConfigVolume: string;
  proxySharedVolume: string;
  dependencyVolume: string;
  proxyAddress?: string;
  repositories: Map<string, RepositoryRevision>;
  revision: number;
  dependencyMode: DependencyMode;
  privateInstallTargets?: PrivateInstallTarget[];
  timings?: ContainerPreparationTimings;
}

interface RecoveryInput {
  agentId: string;
  image: string;
  repositories: RunRepository[];
  changeSet?: ContainerChangeSet;
  dependencyMode?: DependencyMode;
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

  async pruneStaleNetworks(minAgeMs = 15 * 60 * 1000): Promise<string[]> {
    const active = new Set(this.agents.keys());
    const agentParent = resolve(this.stateDir, 'container-agents');
    try {
      if (existsSync(agentParent)) {
        for (const entry of readdirSync(agentParent, { withFileTypes: true })) {
          if (entry.isDirectory()) active.add(entry.name);
        }
      }
    } catch {
      // Ignore disk inspection errors during opportunistic prune
    }
    return this.runtime.pruneStaleManagedNetworks({ activeAgentIds: active, minAgeMs });
  }

  async probe(image = this.config.image) {
    const cached = this.successfulProbes.get(image);
    if (cached) return cached;
    await this.pruneStaleNetworks().catch(() => undefined);
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
   * 2. Creates a private network and selects sidecar-only egress.
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
    dependencyMode: DependencyMode = 'read-only',
    workingDirectory?: string,
  ): Promise<ContainerAgentResources> {
    const layout = containerLayout(this.config);
    if (this.config.platform === 'windows' && profileRepository) throw new Error('IMAGE_PROFILE_WINDOWS_UNSUPPORTED');
    const existing = this.agents.get(agentId);
    if (existing) {
      const isExistingIsolatedBind =
        existing.windowsWorkspaceMode === 'isolated-bind' || existing.windowsRepositoryMounts !== undefined;
      if (isExistingIsolatedBind && this.config.platform === 'windows') {
        const running = await this.runtime.isContainerRunning(existing.workerContainer);
        if (!running) {
          await this.runtime.startContainer(existing.workerContainer);
          await this.configureWindowsWorkerNetwork(existing);
          await this.assertWindowsRepositoryMounts(existing);
          await this.installWindowsWorkerCertificates(existing);
        }
      }
      return existing;
    }

    const isIsolatedBind = this.config.platform === 'windows' && this.config.windows_workspace_mode === 'isolated-bind';
    if (isIsolatedBind) {
      for (const repository of repositories) {
        if (!/^[cC]:[\\/]/.test(repository.parentPath) || !/^[cC]:[\\/]/.test(repository.containerPath)) {
          throw new Error('CONTAINER_WORKSPACE_DRIVE_UNSUPPORTED');
        }
      }
    }

    const timings: ContainerPreparationTimings = {};
    const startPreparation = Date.now();
    const suffix = createHash('sha256').update(agentId).digest('hex').slice(0, 20);
    const prefix = `le-${suffix}`;
    const resources: ContainerAgentResources = {
      agentId,
      image,
      profileRepository,
      workerContainer: `${prefix}-worker`,
      proxyContainer: `${prefix}-proxy`,
      internalNetwork: `${prefix}-internal`,
      egressNetwork: this.config.platform === 'windows' ? 'nat' : `${prefix}-egress`,
      workspaceVolume: `${prefix}-workspace`,
      repositoryVolumes: new Map(
        this.config.platform === 'windows' && !isIsolatedBind
          ? repositories.map((repository) => [repository.name, repositoryVolumeName(prefix, repository)])
          : [],
      ),
      workerConfigVolume: `${prefix}-worker-config`,
      proxyConfigVolume: `${prefix}-proxy-config`,
      proxySharedVolume: `${prefix}-proxy-shared`,
      dependencyVolume: `${prefix}-dependencies`,
      windowsWorkspaceMode: isIsolatedBind ? 'isolated-bind' : 'volume-copy',
      repositories: new Map(),
      revision: 0,
      dependencyMode,
      timings,
    };

    if (dependencyMode === 'private-install') {
      const writableRepos = repositories.filter((r) => r.access !== 'read-only');
      if (writableRepos.length === 0) {
        throw new Error('PRIVATE_INSTALL_NO_WRITABLE_REPOSITORIES');
      }
      const privateTargets: PrivateInstallTarget[] = [];
      for (const repo of writableRepos) {
        const targets = discoverPrivateInstallTargets(repo.name, repo.parentPath, repo.containerPath, prefix);
        privateTargets.push(...targets);
      }
      resources.privateInstallTargets = privateTargets;
    }
    const labels = {
      'local-engineer.agent-id': agentId,
      'local-engineer.managed': 'true',
    };
    const agentState = join(this.stateDir, 'container-agents', agentId);
    mkdirSync(agentState, { recursive: true });
    try {
      const startBaseline = Date.now();
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
      timings.baselineCreationMs = Date.now() - startBaseline;

      if (isIsolatedBind) {
        const startWorkingClone = Date.now();
        const workspacesDir = join(agentState, 'workspaces');
        mkdirSync(workspacesDir, { recursive: true });
        const windowsMounts = new Map<string, WindowsRepositoryMount>();

        for (const repository of repositories) {
          const rev = resources.repositories.get(repository.name)!;
          const workingClonePath = join(workspacesDir, repository.name);
          await git(agentState, [
            'clone',
            '--no-hardlinks',
            '--no-checkout',
            rev.snapshot.snapshotPath,
            workingClonePath,
          ]);
          const autoCrlf = await git(rev.snapshot.snapshotPath, ['config', '--get', 'core.autocrlf']).catch(() => '');
          const coreEol = await git(rev.snapshot.snapshotPath, ['config', '--get', 'core.eol']).catch(() => '');
          if (autoCrlf.trim()) await git(workingClonePath, ['config', 'core.autocrlf', autoCrlf.trim()]);
          if (coreEol.trim()) await git(workingClonePath, ['config', 'core.eol', coreEol.trim()]);
          await git(workingClonePath, ['checkout', '--quiet', '--detach', rev.snapshot.baselineCommit]);

          const excludePath = join(workingClonePath, '.git', 'info', 'exclude');
          mkdirSync(dirname(excludePath), { recursive: true });
          appendFileSync(excludePath, '\n' + MANAGED_DEPENDENCY_EXCLUDE_PATTERNS.join('\n') + '\n');

          const baselineExcludePath = join(rev.snapshot.snapshotPath, '.git', 'info', 'exclude');
          mkdirSync(dirname(baselineExcludePath), { recursive: true });
          appendFileSync(baselineExcludePath, '\n' + MANAGED_DEPENDENCY_EXCLUDE_PATTERNS.join('\n') + '\n');

          rev.workingClonePath = workingClonePath;
        }
        timings.workingCloneCreationMs = Date.now() - startWorkingClone;

        const startDepVal = Date.now();
        for (const repository of repositories) {
          const rev = resources.repositories.get(repository.name)!;
          const isPrivateInstallWritable =
            resources.dependencyMode === 'private-install' && repository.access !== 'read-only';
          const depMounts = isPrivateInstallWritable
            ? []
            : discoverDependencyMounts(repository.parentPath, repository.containerPath);
          rev.dependencyMounts = depMounts;

          windowsMounts.set(repository.name, {
            repository: repository.name,
            baselineSnapshotPath: rev.snapshot.snapshotPath,
            workingClonePath: rev.workingClonePath!,
            containerPath: repository.containerPath,
            access: repository.access ?? 'read-write',
            dependencyMounts: depMounts,
          });
        }
        timings.dependencyValidationMs = Date.now() - startDepVal;
        resources.windowsRepositoryMounts = windowsMounts;
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
      const startNetwork = Date.now();
      const candidates = agentNetworkSubnetCandidates(agentId, this.config.agent_network_pool);
      if (this.config.platform === 'windows') {
        await this.runtime.run(['network', 'inspect', 'nat']);
        const internalSubnet = await this.runtime.createWindowsInternalNetwork(
          resources.internalNetwork,
          labels,
          candidates,
        );
        resources.proxyAddress = internalSubnet.replace(/\.0\/24$/, '.2');
      } else {
        await this.runtime.createNetworkPair({
          internalName: resources.internalNetwork,
          egressName: resources.egressNetwork,
          labels,
          candidates,
        });
      }
      timings.networkAllocationMs = Date.now() - startNetwork;
      const codexConfigPaths = writeContainerCodexConfigs(
        worker,
        this.config,
        workerConfigPath,
        proxyConfigPath,
        resources.proxyAddress,
        repositories.map((r) => ({ containerPath: r.containerPath, access: r.access })),
      );

      if (this.config.platform === 'windows') {
        if (!isIsolatedBind) {
          for (const volume of resources.repositoryVolumes.values()) await this.runtime.createVolume(volume, labels);
        }
      } else {
        await this.runtime.createVolume(resources.workspaceVolume, labels);
      }
      await this.runtime.createVolume(resources.workerConfigVolume, labels);
      await this.runtime.createVolume(resources.proxyConfigVolume, labels);
      await this.runtime.createVolume(resources.proxySharedVolume, labels);
      await this.runtime.createVolume(resources.dependencyVolume, labels);
      if (resources.privateInstallTargets) {
        for (const target of resources.privateInstallTargets) {
          await this.runtime.createVolume(target.volume, labels);
        }
      }

      const startSetup = Date.now();
      if (isIsolatedBind) {
        await this.seedConsolidatedWindowsSetup(
          `${prefix}-consolidated-setup`,
          resources,
          workerConfigPath,
          proxyConfigPath,
          labels,
          codexConfigPaths.modelCatalogPath,
        );
      } else {
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
          codexConfigPaths.modelCatalogPath,
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
      }
      timings.setupContainerExecutionMs = Date.now() - startSetup;

      await this.runtime.createContainer({
        name: resources.proxyContainer,
        image: resources.image,
        network: this.config.platform === 'windows' ? 'nat' : resources.internalNetwork,
        networkAliases: this.config.platform === 'windows' ? [] : ['local-engineer-proxy'],
        user: this.config.worker_user,
        labels,
        mounts: [
          `type=volume,src=${resources.proxyConfigVolume},dst=${layout.codexHome}`,
          `type=volume,src=${resources.proxySharedVolume},dst=${layout.proxyShared}`,
        ],
        environment: {
          CODEX_HOME: layout.codexHome,
          LOCAL_ENGINEER_MODEL_UPSTREAM: worker.container_model_provider!.base_url,
          ...(worker.container_model_provider?.wire_api_compatibility === 'flatten_namespaces'
            ? { LOCAL_ENGINEER_RESPONSES_COMPATIBILITY: 'flatten_namespaces' }
            : {}),
          ...(this.config.platform === 'windows'
            ? { LOCAL_ENGINEER_MODEL_RELAY_BIND_ADDRESS: resources.proxyAddress! }
            : {}),
          LOCAL_ENGINEER_PROXY_SHARED: layout.proxyShared,
          ...(this.config.platform === 'windows'
            ? { LOCAL_ENGINEER_PROXY_EXECUTABLE: 'C:/local-engineer/codex-network-proxy.exe' }
            : {}),
        },
        command: [
          'node',
          existsSync(fileURLToPath(new URL('../container/proxy-sidecar.mjs', import.meta.url)))
            ? joinContainerPath(this.config.platform, layout.codexHome, 'proxy-sidecar.mjs')
            : layout.proxySidecar,
        ],
      });
      if (this.config.platform === 'windows') await this.runtime.assertWindowsHyperVIsolation(resources.proxyContainer);
      await this.runtime.connectNetwork(
        this.config.platform === 'windows' ? resources.internalNetwork : resources.egressNetwork,
        resources.proxyContainer,
        this.config.platform === 'windows' ? resources.proxyAddress : undefined,
      );
      await this.runtime.startContainer(resources.proxyContainer);
      if (this.config.platform === 'windows') {
        const liveProxyAddress = await this.runtime.containerNetworkAddress(
          resources.proxyContainer,
          resources.internalNetwork,
        );
        if (liveProxyAddress !== resources.proxyAddress) throw new Error('CONTAINER_PROXY_ADDRESS_CHANGED');
        await this.configureWindowsProxyNetwork(resources);
        try {
          await this.runtime.execContainer(
            resources.proxyContainer,
            [
              'C:/Node/node.exe',
              '--eval',
              'const net=require("node:net");const u=new URL(process.env.LOCAL_ENGINEER_MODEL_UPSTREAM);const s=net.connect({host:u.hostname,port:Number(u.port)||(u.protocol==="https:"?443:80)});s.setTimeout(8000,()=>s.destroy(new Error("timeout")));s.once("connect",()=>{s.destroy();process.exit(0)});s.once("error",()=>process.exit(1));',
            ],
            { user: this.config.worker_user },
          );
        } catch {
          throw new Error('CONTAINER_MODEL_UPSTREAM_UNREACHABLE');
        }
      }

      if (!isIsolatedBind) {
        await this.seedWorkspaceVolume(`${prefix}-workspace-seed`, resources, labels);
      }
      const proxyHost = this.config.platform === 'windows' ? resources.proxyAddress : resources.proxyContainer;
      if (!proxyHost) throw new Error('CONTAINER_PROXY_ADDRESS_MISSING');

      const primaryInstallTarget =
        resources.dependencyMode === 'private-install'
          ? resolvePrimaryInstallTarget(resources.privateInstallTargets, repositories, workingDirectory)
          : undefined;

      const startWorker = Date.now();
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
          npm_config_store_dir: `${layout.dependencyRoot}/pnpm-store`,
          ...(this.config.platform === 'windows'
            ? {
                CARGO_HOME: `${layout.dependencyRoot}/cargo-home`,
                RUSTUP_HOME: 'C:/Rust/rustup',
              }
            : {}),
          ...(resources.dependencyMode === 'private-install'
            ? {
                npm_config_node_linker: 'hoisted',
                npm_config_package_import_method: 'copy',
                npm_config_confirm_modules_purge: 'false',
                npm_config_audit: 'false',
                npm_config_fund: 'false',
                ...(this.config.platform === 'windows' && primaryInstallTarget
                  ? {
                      npm_config_store_dir: `${primaryInstallTarget.containerPath}/.pnpm-store`,
                    }
                  : {}),
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
      timings.workerStartupMs = Date.now() - startWorker;

      const startAppServer = Date.now();
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
      if (this.config.platform === 'windows') {
        await this.installWindowsWorkerCertificates(resources);
      }
      timings.appServerReadinessMs = Date.now() - startAppServer;
      timings.totalPreparationMs = Date.now() - startPreparation;
      resources.timings = timings;

      writeFileSync(
        join(agentState, 'resources.json'),
        JSON.stringify(
          {
            schema_version: 5,
            agent_id: agentId,
            dependency_mode: resources.dependencyMode,
            private_install_targets: resources.privateInstallTargets?.map((t) => ({
              repository: t.repository,
              relative_path: t.relativePath,
              container_path: t.containerPath,
              volume: t.volume,
            })),
            windows_workspace_mode: this.config.windows_workspace_mode ?? 'volume-copy',
            worker_container: resources.workerContainer,
            proxy_container: resources.proxyContainer,
            internal_network: resources.internalNetwork,
            egress_network: resources.egressNetwork,
            workspace_volume: resources.workspaceVolume,
            repository_volumes: Object.fromEntries(resources.repositoryVolumes),
            windows_repository_mounts: resources.windowsRepositoryMounts
              ? [...resources.windowsRepositoryMounts.values()].map((m) => ({
                  repository: m.repository,
                  baseline_snapshot_path: m.baselineSnapshotPath,
                  working_clone_path: m.workingClonePath,
                  container_path: m.containerPath,
                  access: m.access,
                  dependency_mounts: m.dependencyMounts.map((d) => ({
                    relative_path: d.relativePath,
                    host_path: d.hostPath,
                    container_path: d.containerPath,
                    fingerprint: d.fingerprint,
                  })),
                }))
              : undefined,
            worker_config_volume: resources.workerConfigVolume,
            proxy_config_volume: resources.proxyConfigVolume,
            proxy_shared_volume: resources.proxySharedVolume,
            dependency_volume: resources.dependencyVolume,
            proxy_address: resources.proxyAddress,
            timings: resources.timings,
          },
          null,
          2,
        ),
        { encoding: 'utf8', mode: 0o600 },
      );
      if (resources.dependencyMode === 'private-install' && resources.privateInstallTargets) {
        writeFileSync(
          join(agentState, 'authorized-targets.json'),
          JSON.stringify(resources.privateInstallTargets, null, 2),
          { encoding: 'utf8', mode: 0o600 },
        );
      }
      this.agents.set(agentId, resources);
      return resources;
    } catch (cause) {
      await this.cleanupResources(resources);
      const agentDir = resolve(agentState);
      const expectedParent = resolve(this.stateDir, 'container-agents');
      if (agentDir.startsWith(expectedParent) && agentDir !== expectedParent) {
        rmSync(agentDir, { recursive: true, force: true });
      }
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
    if (
      persisted.schema_version !== 2 &&
      persisted.schema_version !== 3 &&
      persisted.schema_version !== 4 &&
      persisted.schema_version !== 5
    )
      throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');

    const expected = {
      worker_container: `${prefix}-worker`,
      proxy_container: `${prefix}-proxy`,
      internal_network: `${prefix}-internal`,
      egress_network:
        this.config.platform === 'windows' && (persisted.schema_version === 4 || persisted.schema_version === 5)
          ? 'nat'
          : `${prefix}-egress`,
      workspace_volume: `${prefix}-workspace`,
      worker_config_volume: `${prefix}-worker-config`,
      proxy_config_volume: `${prefix}-proxy-config`,
      proxy_shared_volume: `${prefix}-proxy-shared`,
      dependency_volume: `${prefix}-dependencies`,
    };
    const isIsolatedBind =
      this.config.platform === 'windows' &&
      (persisted.schema_version === 3 || persisted.schema_version === 4 || persisted.schema_version === 5) &&
      persisted.windows_workspace_mode === 'isolated-bind';

    const expectedRepositoryVolumes = Object.fromEntries(
      this.config.platform === 'windows' && !isIsolatedBind
        ? input.repositories.map((repository) => [repository.name, repositoryVolumeName(prefix, repository)])
        : [],
    );
    if (
      persisted.agent_id !== input.agentId ||
      Object.entries(expected).some(([key, value]) => persisted[key] !== value) ||
      (this.config.platform === 'windows' &&
        !isIsolatedBind &&
        JSON.stringify(persisted.repository_volumes) !== JSON.stringify(expectedRepositoryVolumes))
    )
      throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');

    const windowsRepositoryMounts = new Map<string, WindowsRepositoryMount>();
    if (isIsolatedBind) {
      const persistedMounts = persisted.windows_repository_mounts as Array<{
        repository: string;
        baseline_snapshot_path: string;
        working_clone_path: string;
        container_path: string;
        access: string;
        dependency_mounts: Array<{
          relative_path: string;
          host_path: string;
          container_path: string;
          fingerprint: string;
        }>;
      }>;
      if (!Array.isArray(persistedMounts) || persistedMounts.length !== input.repositories.length)
        throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');

      for (const repo of input.repositories) {
        const derivedBaseline = join(state, 'snapshots', repo.name);
        const derivedWorkingClone = join(state, 'workspaces', repo.name);
        const derivedContainerPath = repo.containerPath;
        const matching = persistedMounts.find((m) => m.repository === repo.name);
        if (!matching) throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');

        if (
          matching.baseline_snapshot_path !== derivedBaseline ||
          matching.working_clone_path !== derivedWorkingClone ||
          matching.container_path !== derivedContainerPath ||
          matching.access !== (repo.access ?? 'read-write')
        )
          throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');

        for (const dep of matching.dependency_mounts ?? []) {
          const expectedHostPath = normalize(join(repo.parentPath, dep.relative_path)).replace(/\\/g, '/');
          const expectedContainerPath = join(derivedContainerPath, dep.relative_path).replace(/\\/g, '/');
          if (dep.host_path !== expectedHostPath || dep.container_path !== expectedContainerPath)
            throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
        }

        windowsRepositoryMounts.set(repo.name, {
          repository: repo.name,
          baselineSnapshotPath: matching.baseline_snapshot_path,
          workingClonePath: matching.working_clone_path,
          containerPath: matching.container_path,
          access: matching.access as 'read-write' | 'read-only',
          dependencyMounts: (matching.dependency_mounts ?? []).map((d) => ({
            relativePath: d.relative_path,
            hostPath: d.host_path,
            containerPath: d.container_path,
            fingerprint: d.fingerprint,
          })),
        });
      }
    }

    const snapshotsPath = join(state, 'snapshots.json');
    const savedSnapshots = existsSync(snapshotsPath)
      ? (JSON.parse(readFileSync(snapshotsPath, 'utf8')) as Array<{
          runRepository: RunRepository;
          snapshot: RepositorySnapshot;
        }>)
      : [];

    let dependencyMode: DependencyMode;
    const privateInstallTargets: PrivateInstallTarget[] = [];

    if (persisted.schema_version === 5) {
      if (persisted.dependency_mode !== 'read-only' && persisted.dependency_mode !== 'private-install') {
        throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
      }
      dependencyMode = persisted.dependency_mode;
      if (input.dependencyMode && input.dependencyMode !== dependencyMode) {
        throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
      }

      if (dependencyMode === 'read-only') {
        if (
          persisted.private_install_targets !== undefined &&
          (!Array.isArray(persisted.private_install_targets) || persisted.private_install_targets.length > 0)
        ) {
          throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
        }
      } else {
        // private-install mode
        if (!Array.isArray(persisted.private_install_targets)) {
          throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
        }

        const authorizedPath = join(state, 'authorized-targets.json');
        if (!existsSync(authorizedPath)) {
          throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
        }
        let authorizedTargets: PrivateInstallTarget[];
        try {
          authorizedTargets = JSON.parse(readFileSync(authorizedPath, 'utf8')) as PrivateInstallTarget[];
        } catch {
          throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
        }
        if (!Array.isArray(authorizedTargets)) {
          throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
        }

        if (persisted.private_install_targets.length !== authorizedTargets.length) {
          throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
        }
        for (let i = 0; i < authorizedTargets.length; i++) {
          const auth = authorizedTargets[i]!;
          const p = persisted.private_install_targets[i]! as Record<string, unknown>;
          if (
            auth.repository !== p.repository ||
            auth.relativePath !== p.relative_path ||
            auth.containerPath !== p.container_path ||
            auth.volume !== p.volume
          ) {
            throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
          }
        }

        const seenTargetKeys = new Set<string>();
        const seenVolumes = new Set<string>();
        const seenContainerPaths = new Set<string>();
        const repoMap = new Map(input.repositories.map((r) => [r.name, r]));

        for (const t of persisted.private_install_targets as Array<Record<string, unknown>>) {
          if (
            typeof t.repository !== 'string' ||
            typeof t.relative_path !== 'string' ||
            typeof t.container_path !== 'string' ||
            typeof t.volume !== 'string'
          ) {
            throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
          }

          const targetRepo = repoMap.get(t.repository);
          if (!targetRepo || targetRepo.access === 'read-only') {
            throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
          }

          const relPath = t.relative_path.replace(/\\/g, '/');
          const segments = relPath.split('/');
          if (
            !relPath ||
            relPath.startsWith('/') ||
            relPath.includes(':') ||
            segments.includes('..') ||
            segments.includes('.') ||
            segments.includes('.git') ||
            segments.at(-1) !== 'node_modules'
          ) {
            throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
          }

          const expectedContainerPath = join(targetRepo.containerPath, relPath).replace(/\\/g, '/');
          if (t.container_path !== expectedContainerPath) {
            throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
          }

          const expectedVolume = privateInstallVolumeName(prefix, t.repository, relPath);
          if (t.volume !== expectedVolume) {
            throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
          }

          const targetKey = `${t.repository}:${relPath.toLowerCase()}`;
          if (
            seenTargetKeys.has(targetKey) ||
            seenVolumes.has(t.volume) ||
            seenContainerPaths.has(expectedContainerPath)
          ) {
            throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
          }
          seenTargetKeys.add(targetKey);
          seenVolumes.add(t.volume);
          seenContainerPaths.add(expectedContainerPath);

          privateInstallTargets.push({
            repository: t.repository,
            relativePath: t.relative_path,
            containerPath: t.container_path,
            volume: t.volume,
          });
        }

        for (let i = 0; i < privateInstallTargets.length; i++) {
          for (let j = i + 1; j < privateInstallTargets.length; j++) {
            const shorter = privateInstallTargets[i]!.containerPath;
            const longer = privateInstallTargets[j]!.containerPath;
            if (longer.startsWith(shorter + '/') || shorter.startsWith(longer + '/')) {
              throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
            }
          }
        }

        // Verify target completeness against immutable retained baseline manifests
        const requiredBaselineTargets: PrivateInstallTarget[] = [];
        for (const repo of input.repositories) {
          if (repo.access !== 'read-only') {
            const saved = savedSnapshots.find((entry) => entry.runRepository.name === repo.name);
            const snapshotPath = saved?.snapshot.snapshotPath ?? join(state, 'snapshots', repo.name);
            if (existsSync(snapshotPath)) {
              requiredBaselineTargets.push(
                ...discoverPrivateInstallTargets(repo.name, snapshotPath, repo.containerPath, prefix),
              );
            }
          }
        }

        if (privateInstallTargets.length !== requiredBaselineTargets.length) {
          throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
        }

        // 1. Every baseline manifest target must be present in privateInstallTargets
        for (const required of requiredBaselineTargets) {
          const match = privateInstallTargets.find(
            (t) =>
              t.repository === required.repository &&
              t.relativePath === required.relativePath &&
              t.containerPath === required.containerPath &&
              t.volume === required.volume,
          );
          if (!match) {
            throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
          }
        }

        // 2. Every target in privateInstallTargets must correspond to a valid directory in the retained baseline
        for (const target of privateInstallTargets) {
          const saved = savedSnapshots.find((entry) => entry.runRepository.name === target.repository);
          const snapshotPath = saved?.snapshot.snapshotPath ?? join(state, 'snapshots', target.repository);
          const parentDirRel = target.relativePath.includes('/')
            ? target.relativePath.slice(0, target.relativePath.lastIndexOf('/'))
            : '';
          if (parentDirRel) {
            const parentDir = join(snapshotPath, parentDirRel);
            if (!existsSync(parentDir)) {
              throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
            }
          }
        }
      }
    } else {
      // Schemas 2, 3, 4: Strictly read-only
      if (persisted.dependency_mode !== undefined || persisted.private_install_targets !== undefined) {
        throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
      }
      if (input.dependencyMode && input.dependencyMode !== 'read-only') {
        throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
      }
      dependencyMode = 'read-only';
    }

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
      windowsRepositoryMounts: isIsolatedBind ? windowsRepositoryMounts : undefined,
      windowsWorkspaceMode: isIsolatedBind ? 'isolated-bind' : 'volume-copy',
      workerConfigVolume: expected.worker_config_volume,
      proxyConfigVolume: expected.proxy_config_volume,
      proxySharedVolume: expected.proxy_shared_volume,
      dependencyVolume: expected.dependency_volume,
      ...(typeof persisted.proxy_address === 'string' ? { proxyAddress: persisted.proxy_address } : {}),
      repositories: new Map(),
      revision: input.changeSet?.revision ?? 0,
      dependencyMode,
      ...(privateInstallTargets.length > 0 ? { privateInstallTargets } : {}),
      timings: persisted.timings as ContainerPreparationTimings | undefined,
    };

    // Verify ownership labels and mounts BEFORE any container execution or network configuration
    const labels = {
      'local-engineer.agent-id': resources.agentId,
      'local-engineer.managed': 'true',
    };
    if (!(await this.runtime.hasOwnershipLabels('container', resources.workerContainer, labels))) {
      throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
    }
    if (!(await this.runtime.hasOwnershipLabels('container', resources.proxyContainer, labels))) {
      throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
    }
    if (!(await this.runtime.hasOwnershipLabels('network', resources.internalNetwork, labels))) {
      throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
    }
    if (this.config.platform === 'windows' && resources.egressNetwork === 'nat') {
      if (resources.egressNetwork !== 'nat') throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
    } else {
      if (!(await this.runtime.hasOwnershipLabels('network', resources.egressNetwork, labels))) {
        throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
      }
    }
    if (this.config.platform !== 'windows') {
      if (!(await this.runtime.hasOwnershipLabels('volume', resources.workspaceVolume, labels))) {
        throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
      }
    } else if (!isIsolatedBind) {
      for (const volume of resources.repositoryVolumes.values()) {
        if (!(await this.runtime.hasOwnershipLabels('volume', volume, labels))) {
          throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
        }
      }
    }
    if (!(await this.runtime.hasOwnershipLabels('volume', resources.workerConfigVolume, labels))) {
      throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
    }
    if (!(await this.runtime.hasOwnershipLabels('volume', resources.proxyConfigVolume, labels))) {
      throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
    }
    if (!(await this.runtime.hasOwnershipLabels('volume', resources.proxySharedVolume, labels))) {
      throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
    }
    if (!(await this.runtime.hasOwnershipLabels('volume', resources.dependencyVolume, labels))) {
      throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
    }
    if (resources.privateInstallTargets) {
      for (const target of resources.privateInstallTargets) {
        if (!(await this.runtime.hasOwnershipLabels('volume', target.volume, labels))) {
          throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
        }
      }
    }

    if (resources.dependencyMode === 'private-install' && resources.privateInstallTargets) {
      const actualMounts = await this.runtime.inspectContainerMounts(resources.workerContainer);
      for (const target of resources.privateInstallTargets) {
        const targetPathNorm = target.containerPath.replace(/\\/g, '/').toLowerCase();
        const actual = actualMounts.find((m) => m.destination.replace(/\\/g, '/').toLowerCase() === targetPathNorm);
        if (!actual) throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
        if (actual.type !== 'volume') throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
        const actualSource = (actual.name || actual.source).replace(/\\/g, '/');
        if (actualSource !== target.volume && actual.name !== target.volume) {
          throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
        }
        if (!actual.rw) throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
      }
    }

    if (this.config.platform === 'windows') {
      if (!resources.proxyAddress) throw new Error('CONTAINER_PROXY_ADDRESS_MISSING');
      await this.runtime.assertWindowsHyperVIsolation(resources.proxyContainer);
      await this.runtime.assertWindowsHyperVIsolation(resources.workerContainer);
      const liveProxyAddress = await this.runtime.containerNetworkAddress(
        resources.proxyContainer,
        resources.internalNetwork,
      );
      if (liveProxyAddress !== resources.proxyAddress) throw new Error('CONTAINER_PROXY_ADDRESS_CHANGED');
      if (persisted.schema_version === 4 || persisted.schema_version === 5)
        await this.configureWindowsProxyNetwork(resources);
      const running = await this.runtime.isContainerRunning(resources.workerContainer);
      if (running) {
        await this.configureWindowsWorkerNetwork(resources);
        await this.installWindowsWorkerCertificates(resources);
      }
    }
    const reviewCommitsPath = join(state, 'review-commits.json');
    const savedReviewCommits = existsSync(reviewCommitsPath)
      ? (JSON.parse(readFileSync(reviewCommitsPath, 'utf8')) as Record<string, Record<string, string>>)
      : undefined;
    const staleManifestsPath = join(state, 'dependency-manifest-stale.json');
    const savedStaleManifests = existsSync(staleManifestsPath)
      ? (JSON.parse(readFileSync(staleManifestsPath, 'utf8')) as Record<string, boolean>)
      : undefined;

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
      if (savedReviewCommits && savedReviewCommits[repository.name]) {
        for (const [revStr, commit] of Object.entries(savedReviewCommits[repository.name]!)) {
          if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw new Error('CONTAINER_AGENT_RECOVERY_REVIEW_COMMIT_INVALID');
          if (isIsolatedBind) {
            try {
              await git(snapshot.snapshotPath, ['cat-file', '-e', commit]);
            } catch {
              throw new Error('CONTAINER_AGENT_RECOVERY_REVIEW_COMMIT_INVALID');
            }
          }
          reviewCommits.set(Number(revStr), commit);
        }
      } else if (resources.revision > 0) {
        if (isIsolatedBind) {
          throw new Error('CONTAINER_AGENT_RECOVERY_REVIEW_COMMIT_INVALID');
        }
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

      const persistedStale = Boolean(savedStaleManifests?.[repository.name]);
      const changesStale = Boolean(changes && isDependencyManifestChanged(changes.changedPaths));
      const summaryStale = summary?.dependency_manifest_stale;
      const mustBeStale = persistedStale || changesStale;

      if (mustBeStale) {
        if (summary && summaryStale === false) {
          throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
        }
        if (input.changeSet && input.changeSet.dependency_manifest_stale === false) {
          throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
        }
      }

      const dependencyManifestStale = mustBeStale || Boolean(summaryStale);

      const repoMount = resources.windowsRepositoryMounts?.get(repository.name);
      resources.repositories.set(repository.name, {
        runRepository: repository,
        snapshot,
        changes,
        patchPath,
        reviewCommits,
        workingClonePath: repoMount?.workingClonePath,
        dependencyMounts: repoMount?.dependencyMounts,
        dependencyManifestStale,
      });
    }

    const anyRepoStale = [...resources.repositories.values()].some((r) => r.dependencyManifestStale);
    if (input.changeSet && anyRepoStale && input.changeSet.dependency_manifest_stale === false) {
      throw new Error('CONTAINER_AGENT_RETAINED_STATE_INVALID');
    }

    this.agents.set(input.agentId, resources);
    return resources;
  }

  appServerWorker(worker: Worker, resources: ContainerAgentResources): ContainerAppServerWorker {
    const layout = containerLayout(this.config);
    const relayAuthority = this.config.platform === 'windows' ? resources.proxyAddress : undefined;
    if (this.config.platform === 'windows' && !relayAuthority) throw new Error('CONTAINER_PROXY_ADDRESS_MISSING');
    return {
      command: this.config.command,
      args: [
        ...(this.config.context ? ['--context', this.config.context] : []),
        'exec',
        '--interactive',
        resources.workerContainer,
        this.config.codex_command === 'codex' ? layout.codexExecutable : this.config.codex_command,
        '--strict-config',
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
    modelCatalogSource?: string,
  ): Promise<void> {
    const layout = containerLayout(this.config);
    await this.runtime.createContainer({
      name: container,
      image,
      network,
      user: layout.administratorUser,
      capabilities: ['CHOWN'],
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
      if (modelCatalogSource) {
        await this.runtime.copyToContainer(
          modelCatalogSource,
          container,
          joinContainerPath(this.config.platform, layout.codexHome, 'model-catalog.json'),
        );
      }
      if (writable) {
        const proxySidecarSource = fileURLToPath(new URL('../container/proxy-sidecar.mjs', import.meta.url));
        if (existsSync(proxySidecarSource)) {
          await this.runtime.copyToContainer(
            proxySidecarSource,
            container,
            joinContainerPath(this.config.platform, layout.codexHome, 'proxy-sidecar.mjs'),
          );
        }
      }
      if (this.config.platform === 'windows') {
        await this.runtime.execContainer(
          container,
          ['icacls.exe', layout.codexHome, '/grant:r', `*S-1-5-93-2-2:(OI)(CI)${writable ? 'M' : 'RX'}`, '/T', '/C'],
          { user: layout.administratorUser, workdir: layout.safeAdminWorkdir },
        );
        if (writable) {
          const tmpDir = joinContainerPath(this.config.platform, layout.codexHome, 'tmp');
          const arg0File = joinContainerPath(this.config.platform, layout.codexHome, 'tmp', 'arg0');
          const configToml = joinContainerPath(this.config.platform, layout.codexHome, 'config.toml');
          const modelCatalogJson = joinContainerPath(this.config.platform, layout.codexHome, 'model-catalog.json');
          const catalogLock = modelCatalogSource
            ? `Set-ItemProperty -Path "${modelCatalogJson}" -Name IsReadOnly -Value $true -ErrorAction SilentlyContinue; ` +
              `icacls.exe "${modelCatalogJson}" /deny "*S-1-5-93-2-2:(D,WDAC,WO,WD,AD)" | Out-Null; `
            : '';
          await this.runtime.execContainer(
            container,
            [
              layout.powershellExecutable,
              '-NoLogo',
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `Remove-Item -Recurse -Force "${tmpDir}" -ErrorAction SilentlyContinue; ` +
                `New-Item -ItemType Directory -Force "${tmpDir}" | Out-Null; ` +
                `New-Item -ItemType File -Force "${arg0File}" | Out-Null; ` +
                `Set-ItemProperty -Path "${arg0File}" -Name IsReadOnly -Value $true; ` +
                `icacls.exe "${tmpDir}" /deny "*S-1-5-93-2-2:(DC)" | Out-Null; ` +
                `icacls.exe "${arg0File}" /deny "*S-1-5-93-2-2:(D,WDAC,WO)" | Out-Null; ` +
                catalogLock +
                `Set-ItemProperty -Path "${configToml}" -Name IsReadOnly -Value $true -ErrorAction SilentlyContinue; ` +
                `icacls.exe "${configToml}" /deny "*S-1-5-93-2-2:(D,WDAC,WO,WD,AD)" | Out-Null`,
            ],
            { user: layout.administratorUser, workdir: layout.safeAdminWorkdir },
          );
        }
      } else {
        const configToml = joinContainerPath(this.config.platform, layout.codexHome, 'config.toml');
        const modelCatalog = joinContainerPath(this.config.platform, layout.codexHome, 'model-catalog.json');
        await this.runtime.execContainer(container, ['chown', '-R', this.config.worker_user, layout.codexHome], {
          user: layout.administratorUser,
          workdir: layout.safeAdminWorkdir,
        });
        await this.runtime.execContainer(container, ['chmod', writable ? '0644' : '0444', configToml], {
          user: this.config.worker_user,
          workdir: layout.safeAdminWorkdir,
        });
        if (modelCatalogSource) {
          await this.runtime.execContainer(container, ['chmod', writable ? '0644' : '0444', modelCatalog], {
            user: this.config.worker_user,
            workdir: layout.safeAdminWorkdir,
          });
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
          `${layout.dependencyRoot}/pnpm-store`,
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
   * Consolidates Windows setup steps into a single short-lived setup container:
   * seeds proxy-shared, worker-config, proxy-config, and dependencies in one execution.
   */
  private async seedConsolidatedWindowsSetup(
    container: string,
    resources: ContainerAgentResources,
    workerConfigPath: string,
    proxyConfigPath: string,
    labels: Record<string, string>,
    modelCatalogPath?: string,
  ): Promise<void> {
    const layout = containerLayout(this.config);
    const proxyCodexHome = 'C:/local-engineer-proxy-codex-home';
    const mounts: string[] = [
      `type=volume,src=${resources.proxySharedVolume},dst=${layout.proxyShared}`,
      `type=volume,src=${resources.workerConfigVolume},dst=${layout.codexHome}`,
      `type=volume,src=${resources.proxyConfigVolume},dst=${proxyCodexHome}`,
      `type=volume,src=${resources.dependencyVolume},dst=${layout.dependencyRoot}`,
    ];

    const agentState = join(this.stateDir, 'container-agents', resources.agentId);
    const permittedWorkspacesRoot = join(agentState, 'workspaces');
    const aclTargets: string[] = [];

    if (resources.privateInstallTargets) {
      let depIndex = 0;
      for (const target of resources.privateInstallTargets) {
        const setupDepPath = `C:/setup-dep-volumes/dep-${depIndex++}`;
        mounts.push(`type=volume,src=${target.volume},dst=${setupDepPath}`);
        aclTargets.push(setupDepPath);
      }
    }

    if (resources.windowsRepositoryMounts) {
      let index = 0;
      for (const repoMount of resources.windowsRepositoryMounts.values()) {
        const setupWorkspacePath = `C:/setup-workspaces/repo-${index++}`;
        mounts.push(
          this.runtime.buildBindMount({
            source: repoMount.workingClonePath,
            target: setupWorkspacePath,
            readOnly: false,
            permittedSourceRoots: [permittedWorkspacesRoot],
          }),
        );
        if (repoMount.access !== 'read-only') {
          aclTargets.push(setupWorkspacePath);
        }
      }
    }

    await this.runtime.createContainer({
      name: container,
      image: resources.image,
      network: resources.internalNetwork,
      user: layout.administratorUser,
      capabilities: ['CHOWN'],
      labels,
      mounts,
      command: layout.keepAliveCommand,
    });
    try {
      if (this.config.platform === 'windows') await this.runtime.assertWindowsHyperVIsolation(container);
      await this.runtime.startContainer(container);
      if (this.config.platform === 'windows') await this.configureWindowsNetwork(container, resources.internalNetwork);

      await this.runtime.copyToContainer(
        workerConfigPath,
        container,
        joinContainerPath(this.config.platform, layout.codexHome, 'config.toml'),
      );
      if (modelCatalogPath) {
        await this.runtime.copyToContainer(
          modelCatalogPath,
          container,
          joinContainerPath(this.config.platform, layout.codexHome, 'model-catalog.json'),
        );
      }
      await this.runtime.copyToContainer(
        proxyConfigPath,
        container,
        joinContainerPath(this.config.platform, proxyCodexHome, 'config.toml'),
      );
      const proxySidecarSource = fileURLToPath(new URL('../container/proxy-sidecar.mjs', import.meta.url));
      if (existsSync(proxySidecarSource)) {
        await this.runtime.copyToContainer(
          proxySidecarSource,
          container,
          joinContainerPath(this.config.platform, proxyCodexHome, 'proxy-sidecar.mjs'),
        );
      }

      await this.runtime.execContainer(
        container,
        nodeMkdirCommand(
          `${layout.dependencyRoot}/pip-cache`,
          `${layout.dependencyRoot}/npm-cache`,
          `${layout.dependencyRoot}/yarn-cache`,
          `${layout.dependencyRoot}/pnpm-store`,
        ),
        { user: layout.administratorUser, workdir: layout.safeAdminWorkdir },
      );

      await this.runtime.execContainer(
        container,
        ['icacls.exe', layout.proxyShared, '/grant:r', '*S-1-5-93-2-2:(OI)(CI)M', '/T', '/C'],
        { user: layout.administratorUser, workdir: layout.safeAdminWorkdir },
      );
      await this.runtime.execContainer(
        container,
        ['icacls.exe', layout.dependencyRoot, '/grant:r', '*S-1-5-93-2-2:(OI)(CI)M', '/T', '/C'],
        { user: layout.administratorUser, workdir: layout.safeAdminWorkdir },
      );
      await this.runtime.execContainer(
        container,
        ['icacls.exe', layout.codexHome, '/grant:r', '*S-1-5-93-2-2:(OI)(CI)M', '/T', '/C'],
        { user: layout.administratorUser, workdir: layout.safeAdminWorkdir },
      );
      await this.runtime.execContainer(
        container,
        ['icacls.exe', proxyCodexHome, '/grant:r', '*S-1-5-93-2-2:(OI)(CI)M', '/T', '/C'],
        { user: layout.administratorUser, workdir: layout.safeAdminWorkdir },
      );

      for (const aclTarget of aclTargets) {
        await this.runtime.execContainer(
          container,
          ['icacls.exe', aclTarget, '/grant:r', '*S-1-5-93-2-2:(OI)(CI)M', '/T', '/C'],
          { user: layout.administratorUser, workdir: layout.safeAdminWorkdir },
        );
      }

      const tmpDir = joinContainerPath(this.config.platform, layout.codexHome, 'tmp');
      const arg0File = joinContainerPath(this.config.platform, layout.codexHome, 'tmp', 'arg0');
      const configToml = joinContainerPath(this.config.platform, layout.codexHome, 'config.toml');
      const modelCatalog = joinContainerPath(this.config.platform, layout.codexHome, 'model-catalog.json');
      const catalogLock = modelCatalogPath
        ? `Set-ItemProperty -Path "${modelCatalog}" -Name IsReadOnly -Value $true -ErrorAction SilentlyContinue; ` +
          `icacls.exe "${modelCatalog}" /deny "*S-1-5-93-2-2:(D,WDAC,WO,WD,AD)" | Out-Null; `
        : '';
      await this.runtime.execContainer(
        container,
        [
          layout.powershellExecutable,
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Remove-Item -Recurse -Force "${tmpDir}" -ErrorAction SilentlyContinue; ` +
            `New-Item -ItemType Directory -Force "${tmpDir}" | Out-Null; ` +
            `New-Item -ItemType File -Force "${arg0File}" | Out-Null; ` +
            `Set-ItemProperty -Path "${arg0File}" -Name IsReadOnly -Value $true; ` +
            `icacls.exe "${tmpDir}" /deny "*S-1-5-93-2-2:(DC)" | Out-Null; ` +
            `icacls.exe "${arg0File}" /deny "*S-1-5-93-2-2:(D,WDAC,WO)" | Out-Null; ` +
            `Set-ItemProperty -Path "${layout.fileToolsServer}" -Name IsReadOnly -Value $true -ErrorAction SilentlyContinue; ` +
            `icacls.exe "${layout.fileToolsServer}" /deny "*S-1-5-93-2-2:(D,WDAC,WO,WD,AD)" | Out-Null; ` +
            catalogLock +
            `Set-ItemProperty -Path "${configToml}" -Name IsReadOnly -Value $true -ErrorAction SilentlyContinue; ` +
            `icacls.exe "${configToml}" /deny "*S-1-5-93-2-2:(D,WDAC,WO,WD,AD)" | Out-Null`,
        ],
        { user: layout.administratorUser, workdir: layout.safeAdminWorkdir },
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
      mounts: [
        ...(this.config.platform === 'windows'
          ? [...resources.repositories.values()].map((repository) => {
              const volume = resources.repositoryVolumes.get(repository.runRepository.name);
              if (!volume) throw new Error('CONTAINER_REPOSITORY_VOLUME_MISSING');
              return `type=volume,src=${volume},dst=${repository.runRepository.containerPath}`;
            })
          : [`type=volume,src=${resources.workspaceVolume},dst=${this.config.workspace_path}`]),
        ...(resources.dependencyMode === 'private-install' && resources.privateInstallTargets
          ? resources.privateInstallTargets.map(
              (target) => `type=volume,src=${target.volume},dst=${target.containerPath}`,
            )
          : []),
      ],
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
                ...MANAGED_DEPENDENCY_EXCLUDE_PATTERNS,
              ]
            : [
                'sh',
                '-c',
                'target=$1; shift; printf "%s\\n" "$@" >> "$target"',
                'local-engineer-private-exclude',
                posix.join(privateGitDirectory, 'info', 'exclude'),
                ...MANAGED_DEPENDENCY_EXCLUDE_PATTERNS,
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
      if (resources.dependencyMode === 'private-install' && resources.privateInstallTargets) {
        for (const target of resources.privateInstallTargets) {
          if (this.config.platform !== 'windows') {
            await this.runtime.execContainer(
              container,
              ['chown', '-R', this.config.worker_user, target.containerPath],
              { user: layout.administratorUser },
            );
            await this.runtime.execContainer(container, ['chmod', '-R', 'u+rwX', target.containerPath], {
              user: this.config.worker_user,
            });
          } else {
            await this.runtime.execContainer(
              container,
              [
                layout.powershellExecutable,
                '-NoLogo',
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `& icacls '${target.containerPath}' /grant "*S-1-5-87-*:M" /t /c /q`,
              ],
              { user: layout.administratorUser, workdir: layout.safeAdminWorkdir },
            );
          }
        }
      }
    } finally {
      await this.runtime.removeContainer(container, true).catch(() => undefined);
    }
  }

  private workerRepositoryMounts(resources: ContainerAgentResources): string[] {
    if (this.config.platform !== 'windows') {
      const mounts = [`type=volume,src=${resources.workspaceVolume},dst=${this.config.workspace_path}`];
      if (resources.dependencyMode === 'private-install' && resources.privateInstallTargets) {
        for (const target of resources.privateInstallTargets) {
          mounts.push(`type=volume,src=${target.volume},dst=${target.containerPath}`);
        }
      }
      return mounts;
    }

    if (resources.windowsWorkspaceMode === 'isolated-bind' || resources.windowsRepositoryMounts !== undefined) {
      const mounts: string[] = [];
      const agentState = join(this.stateDir, 'container-agents', resources.agentId);
      const permittedWorkspacesRoot = join(agentState, 'workspaces');

      for (const repository of resources.repositories.values()) {
        const repoMount = resources.windowsRepositoryMounts?.get(repository.runRepository.name);
        const workingClonePath =
          repoMount?.workingClonePath ?? join(permittedWorkspacesRoot, repository.runRepository.name);

        // 1. Working clone bind mount
        mounts.push(
          this.runtime.buildBindMount({
            source: workingClonePath,
            target: repository.runRepository.containerPath,
            readOnly: repository.runRepository.access === 'read-only',
            permittedSourceRoots: [permittedWorkspacesRoot],
          }),
        );

        if (resources.dependencyMode === 'private-install' && repository.runRepository.access !== 'read-only') {
          // Mount the agent-owned private install volumes for this writable repository
          const targets = (resources.privateInstallTargets ?? []).filter(
            (t) => t.repository === repository.runRepository.name,
          );
          for (const target of targets) {
            mounts.push(`type=volume,src=${target.volume},dst=${target.containerPath}`);
          }
        } else {
          // 2. Nested dependency mounts, sorted by target path depth (length) ascending
          const depMounts = (repoMount?.dependencyMounts ?? repository.dependencyMounts ?? [])
            .slice()
            .sort((a, b) => a.containerPath.length - b.containerPath.length);
          for (const dep of depMounts) {
            mounts.push(
              this.runtime.buildBindMount({
                source: dep.hostPath,
                target: dep.containerPath,
                readOnly: true,
                permittedSourceRoots: [repository.runRepository.parentPath],
              }),
            );
          }
        }
      }
      return mounts;
    }

    const mounts = [...resources.repositories.values()].map((repository) => {
      const volume = resources.repositoryVolumes.get(repository.runRepository.name);
      if (!volume) throw new Error('CONTAINER_REPOSITORY_VOLUME_MISSING');
      return `type=volume,src=${volume},dst=${repository.runRepository.containerPath}${
        repository.runRepository.access === 'read-only' ? ',readonly' : ''
      }`;
    });
    if (resources.dependencyMode === 'private-install' && resources.privateInstallTargets) {
      for (const repository of resources.repositories.values()) {
        if (repository.runRepository.access === 'read-only') continue;
        const targets = resources.privateInstallTargets.filter((t) => t.repository === repository.runRepository.name);
        for (const target of targets) {
          mounts.push(`type=volume,src=${target.volume},dst=${target.containerPath}`);
        }
      }
    }
    return mounts;
  }

  private async assertWindowsRepositoryMounts(resources: ContainerAgentResources): Promise<void> {
    const isIsolatedBind =
      resources.windowsWorkspaceMode === 'isolated-bind' || resources.windowsRepositoryMounts !== undefined;

    for (const repository of resources.repositories.values()) {
      if (repository.runRepository.access === 'read-only') {
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

      if (isIsolatedBind) {
        if (resources.dependencyMode === 'private-install' && repository.runRepository.access !== 'read-only') {
          const targets = (resources.privateInstallTargets ?? []).filter(
            (t) => t.repository === repository.runRepository.name,
          );
          for (const target of targets) {
            const probePath = joinContainerPath(
              'windows',
              target.containerPath,
              `.probe-${createHash('sha256')
                .update(`${resources.agentId}\0${target.relativePath}`)
                .digest('hex')
                .slice(0, 16)}`,
            );
            const result = await this.runtime.execContainer(
              resources.workerContainer,
              [
                'node',
                '--eval',
                "/* private-install-target */ const fs=require('node:fs');const p=process.argv[1];if(fs.existsSync(p)){process.stdout.write('COLLISION')}else{try{fs.writeFileSync(p,'x');fs.unlinkSync(p);process.stdout.write('WRITABLE')}catch(e){if(e&&['EACCES','EPERM','EROFS'].includes(e.code))process.stdout.write('LOCKED');else throw e}}",
                probePath,
              ],
              { user: this.config.worker_user },
            );
            if (result.stdout.trim() !== 'WRITABLE') {
              throw new Error(`CONTAINER_PRIVATE_INSTALL_TARGET_NOT_WRITABLE:${target.containerPath}:${result.stdout}`);
            }
          }
        } else {
          const depMounts = repository.dependencyMounts ?? [];
          for (const dep of depMounts) {
            const depProbe = joinContainerPath(
              'windows',
              dep.containerPath,
              `.probe-${createHash('sha256')
                .update(`${resources.agentId}\0${dep.relativePath}`)
                .digest('hex')
                .slice(0, 16)}`,
            );
            const result = await this.runtime.execContainer(
              resources.workerContainer,
              [
                'node',
                '--eval',
                "const fs=require('node:fs');const p=process.argv[1];if(fs.existsSync(p)){process.stdout.write('COLLISION')}else{try{fs.writeFileSync(p,'x');fs.unlinkSync(p);process.stdout.write('WRITABLE')}catch(e){if(e&&['EACCES','EPERM','EROFS'].includes(e.code))process.stdout.write('LOCKED');else throw e}}",
                depProbe,
              ],
              { user: this.config.worker_user },
            );
            if (result.stdout.trim() !== 'LOCKED') throw new Error('CONTAINER_DEPENDENCY_READ_ONLY_FAILED');
          }
        }
      }
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

  private async installWindowsWorkerCertificates(resources: ContainerAgentResources): Promise<void> {
    const layout = containerLayout(this.config);
    await this.runtime.execContainer(
      resources.workerContainer,
      [
        layout.powershellExecutable,
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `$ErrorActionPreference = 'Stop'; Import-Certificate -FilePath '${layout.caFile}' -CertStoreLocation Cert:\\LocalMachine\\Root | Out-Null`,
      ],
      { user: layout.administratorUser, workdir: layout.safeAdminWorkdir },
    );
  }

  private async configureWindowsProxyNetwork(resources: ContainerAgentResources): Promise<void> {
    if (resources.egressNetwork !== 'nat' || !resources.proxyAddress)
      throw new Error('CONTAINER_WINDOWS_PROXY_NETWORK_INPUT_INVALID');
    const layout = containerLayout(this.config);
    const proxyScript = fileURLToPath(new URL('../container/configure-proxy-network.ps1', import.meta.url));
    if (existsSync(proxyScript)) {
      await this.runtime.copyToContainer(
        proxyScript,
        resources.proxyContainer,
        'C:/local-engineer/configure-proxy-network.ps1',
      );
    }
    const internal = await this.runtime.containerNetworkEndpoint(resources.proxyContainer, resources.internalNetwork);
    const egress = await this.runtime.containerNetworkEndpoint(resources.proxyContainer, 'nat');
    if (internal.address !== resources.proxyAddress) throw new Error('CONTAINER_PROXY_ADDRESS_CHANGED');
    const result = await this.runtime.execContainer(
      resources.proxyContainer,
      [
        layout.powershellExecutable,
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        'C:/local-engineer/configure-proxy-network.ps1',
        '-InternalAddress',
        internal.address,
        '-InternalMacAddress',
        internal.macAddress,
        '-EgressAddress',
        egress.address,
        '-EgressMacAddress',
        egress.macAddress,
      ],
      { user: layout.administratorUser, workdir: layout.safeAdminWorkdir },
    );
    if (result.stdout.trim() !== 'LOCAL_ENGINEER_PROXY_NETWORK_OK')
      throw new Error('CONTAINER_WINDOWS_PROXY_NETWORK_VERIFICATION_FAILED');
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
    const isIsolatedBind =
      resources.windowsWorkspaceMode === 'isolated-bind' || resources.windowsRepositoryMounts !== undefined;
    const agentState = join(this.stateDir, 'container-agents', agentId);

    let pausedWorker = false;
    if (isIsolatedBind) {
      const running = await this.runtime.isContainerRunning(resources.workerContainer);
      if (running) {
        if (this.config.platform === 'windows') {
          await this.runtime.stopContainer(resources.workerContainer);
          const stillRunning = await this.runtime.isContainerRunning(resources.workerContainer);
          if (stillRunning) {
            throw new Error('CONTAINER_STOP_FAILED');
          }
        } else {
          await this.runtime.pauseContainer(resources.workerContainer);
          pausedWorker = true;
        }
      }
    }

    try {
      for (const revision of resources.repositories.values()) {
        if (isIsolatedBind) {
          const baselineGitDir = join(revision.snapshot.snapshotPath, '.git');
          const workingClonePath =
            revision.workingClonePath ?? join(agentState, 'workspaces', revision.runRepository.name);

          assertNoReparsePoints(workingClonePath);

          if (revision.runRepository.access === 'read-only') {
            const status = await git(agentState, [
              '--git-dir',
              baselineGitDir,
              '--work-tree',
              workingClonePath,
              'status',
              '--porcelain=v1',
              '--untracked-files=all',
            ]);
            if (status.trim()) throw new Error(`READ_ONLY_REPOSITORY_CHANGED:${revision.runRepository.name}`);
            const previousCommit = revision.reviewCommits.get(previousRevision);
            if (!previousCommit) throw new Error('CONTAINER_REVIEW_COMMIT_NOT_FOUND');
            revision.reviewCommits.set(nextRevision, previousCommit);
            continue;
          }

          const tempIndexFile = join(
            agentState,
            `tmp-index-${revision.runRepository.name}-${nextRevision}-${createHash('sha256')
              .update(String(Date.now()))
              .digest('hex')
              .slice(0, 8)}`,
          );
          const gitEnv: Record<string, string> = {
            GIT_DIR: resolve(baselineGitDir),
            GIT_WORK_TREE: resolve(workingClonePath),
            GIT_INDEX_FILE: resolve(tempIndexFile),
          };

          try {
            const statusOutput = await git(
              agentState,
              [
                '--git-dir',
                baselineGitDir,
                '--work-tree',
                workingClonePath,
                'status',
                '--porcelain=v1',
                '-z',
                '--untracked-files=all',
              ],
              undefined,
              gitEnv,
            );

            const statusEntries = statusOutput.split('\0').filter(Boolean);
            for (const entry of statusEntries) {
              const path = entry.slice(3);
              if (!path) continue;
              if (isManagedDependencyPath(path, this.config.platform)) {
                throw new Error(`CONTAINER_PATCH_INVALID:managed_dependency_path_not_permitted:${path}`);
              }
              validateRelativePath(path, this.config.platform);

              const fullPath = join(workingClonePath, path);
              if (existsSync(fullPath)) {
                const stat = lstatSync(fullPath);
                if (stat.isSymbolicLink()) {
                  throw new Error(`CONTAINER_PATCH_INVALID:symlink_not_permitted:${path}`);
                }
              }
            }

            await git(
              agentState,
              ['--git-dir', baselineGitDir, 'read-tree', revision.snapshot.baselineCommit],
              undefined,
              gitEnv,
            );

            await git(
              agentState,
              ['--git-dir', baselineGitDir, '--work-tree', workingClonePath, 'add', '--all'],
              undefined,
              gitEnv,
            );

            const patch = await git(
              agentState,
              [
                '--git-dir',
                baselineGitDir,
                '--work-tree',
                workingClonePath,
                'diff',
                '--cached',
                '--binary',
                '--full-index',
                '--no-renames',
                revision.snapshot.baselineCommit,
              ],
              undefined,
              gitEnv,
            );
            if (Buffer.byteLength(patch) > 16 * 1024 * 1024) throw new Error('CONTAINER_PATCH_TOO_LARGE');

            const names = await git(
              agentState,
              [
                '--git-dir',
                baselineGitDir,
                '--work-tree',
                workingClonePath,
                'diff',
                '--cached',
                '--name-only',
                '-z',
                '--no-renames',
                revision.snapshot.baselineCommit,
              ],
              undefined,
              gitEnv,
            );

            const numstat = await git(
              agentState,
              [
                '--git-dir',
                baselineGitDir,
                '--work-tree',
                workingClonePath,
                'diff',
                '--cached',
                '--numstat',
                '--no-renames',
                revision.snapshot.baselineCommit,
              ],
              undefined,
              gitEnv,
            );

            const changes = changesFromOutput(patch, names, numstat);
            if (changes.changedPaths.length > 1000) throw new Error('CONTAINER_TOO_MANY_CHANGED_PATHS');
            assertNoManagedDependencyPaths(changes.changedPaths, this.config.platform);
            for (const path of changes.changedPaths) validateRelativePath(path, this.config.platform);

            if (isDependencyManifestChanged(changes.changedPaths)) {
              revision.dependencyManifestStale = true;
            }

            const previousCommit = revision.reviewCommits.get(previousRevision);
            if (!previousCommit) throw new Error('CONTAINER_REVIEW_COMMIT_NOT_FOUND');

            const deltaPatch = await git(
              agentState,
              [
                '--git-dir',
                baselineGitDir,
                '--work-tree',
                workingClonePath,
                'diff',
                '--cached',
                '--binary',
                '--full-index',
                '--no-renames',
                previousCommit,
              ],
              undefined,
              gitEnv,
            );

            const deltaNames = await git(
              agentState,
              [
                '--git-dir',
                baselineGitDir,
                '--work-tree',
                workingClonePath,
                'diff',
                '--cached',
                '--name-only',
                '-z',
                '--no-renames',
                previousCommit,
              ],
              undefined,
              gitEnv,
            );

            const deltaNumstat = await git(
              agentState,
              [
                '--git-dir',
                baselineGitDir,
                '--work-tree',
                workingClonePath,
                'diff',
                '--cached',
                '--numstat',
                '--no-renames',
                previousCommit,
              ],
              undefined,
              gitEnv,
            );

            const deltaChanges = changesFromOutput(deltaPatch, deltaNames, deltaNumstat);
            assertNoManagedDependencyPaths(deltaChanges.changedPaths, this.config.platform);
            for (const path of deltaChanges.changedPaths) validateRelativePath(path, this.config.platform);

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

            const treeHash = (
              await git(agentState, ['--git-dir', baselineGitDir, 'write-tree'], undefined, gitEnv)
            ).trim();
            const reviewCommit = (
              await git(
                agentState,
                [
                  '--git-dir',
                  baselineGitDir,
                  'commit-tree',
                  treeHash,
                  '-p',
                  previousCommit,
                  '-m',
                  `Local Engineer review revision ${nextRevision}`,
                ],
                undefined,
                gitEnv,
              )
            ).trim();

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
                dependency_manifest_stale: Boolean(revision.dependencyManifestStale),
              });
          } finally {
            if (existsSync(tempIndexFile)) {
              rmSync(tempIndexFile, { force: true });
            }
          }
          continue;
        }

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
        assertNoManagedDependencyPaths(changes.changedPaths, this.config.platform);
        for (const path of changes.changedPaths) validateRelativePath(path, this.config.platform);
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
        assertNoManagedDependencyPaths(deltaChanges.changedPaths, this.config.platform);
        for (const path of deltaChanges.changedPaths) validateRelativePath(path, this.config.platform);
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
            dependency_manifest_stale: Boolean(revision.dependencyManifestStale),
          });
      }
    } finally {
      if (pausedWorker) {
        await this.runtime.unpauseContainer(resources.workerContainer).catch(() => undefined);
      }
    }

    resources.revision = nextRevision;
    const digest = `sha256:${createHash('sha256')
      .update(JSON.stringify(summaries.map((summary) => [summary.repository, summary.patch_digest])))
      .digest('hex')}`;

    writeFileSync(
      join(agentState, 'review-commits.json'),
      JSON.stringify(
        Object.fromEntries(
          [...resources.repositories.entries()].map(([name, rev]) => [
            name,
            Object.fromEntries(rev.reviewCommits.entries()),
          ]),
        ),
        null,
        2,
      ),
      { encoding: 'utf8', mode: 0o600 },
    );

    writeFileSync(
      join(agentState, 'dependency-manifest-stale.json'),
      JSON.stringify(
        Object.fromEntries(
          [...resources.repositories.entries()].map(([name, rev]) => [name, Boolean(rev.dependencyManifestStale)]),
        ),
        null,
        2,
      ),
      { encoding: 'utf8', mode: 0o600 },
    );

    const anyManifestStale = [...resources.repositories.values()].some((r) => r.dependencyManifestStale);
    return {
      revision: resources.revision,
      previous_revision: previousRevision,
      digest,
      repositories: summaries,
      dependency_manifest_stale: anyManifestStale,
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

    let patch: string;
    if (
      this.config.platform === 'windows' &&
      (resources.windowsWorkspaceMode === 'isolated-bind' || resources.windowsRepositoryMounts !== undefined)
    ) {
      const baselineGitDir = join(revision.snapshot.snapshotPath, '.git');
      patch = await git(this.stateDir, [
        '--git-dir',
        baselineGitDir,
        'diff',
        '--binary',
        '--full-index',
        '--no-renames',
        fromCommit,
        toCommit,
      ]);
    } else {
      patch = (
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
    }
    if (Buffer.byteLength(patch) > 16 * 1024 * 1024) throw new Error('CONTAINER_PATCH_TOO_LARGE');
    return patch;
  }

  async getFile(agentId: string, repository: string, path: string, maximumBytes: number): Promise<string> {
    validateRelativePath(path, this.config.platform);
    const resources = this.require(agentId);
    const revision = resources.repositories.get(repository);
    if (!revision) throw new Error('CONTAINER_REPOSITORY_NOT_FOUND');

    const reviewCommit = revision.reviewCommits.get(resources.revision) ?? revision.snapshot.baselineCommit;
    const isIsolatedBind =
      resources.windowsWorkspaceMode === 'isolated-bind' || resources.windowsRepositoryMounts !== undefined;
    const normalizedPath = path.replaceAll('\\', '/');

    if (isIsolatedBind) {
      const gitDir = join(revision.snapshot.snapshotPath, '.git');
      try {
        const type = (
          await git(revision.snapshot.snapshotPath, [
            '--git-dir',
            gitDir,
            'cat-file',
            '-t',
            `${reviewCommit}:${normalizedPath}`,
          ])
        ).trim();
        if (type !== 'blob') {
          throw new Error('CONTAINER_FILE_NOT_FOUND');
        }
        const content = await git(revision.snapshot.snapshotPath, [
          '--git-dir',
          gitDir,
          'cat-file',
          '-p',
          `${reviewCommit}:${normalizedPath}`,
        ]);
        if (Buffer.byteLength(content) > maximumBytes) throw new Error('CONTAINER_FILE_TOO_LARGE');
        if (content.includes('\0')) throw new Error('CONTAINER_FILE_BINARY');
        return content;
      } catch (cause) {
        if (cause instanceof Error) {
          if (
            ['CONTAINER_FILE_NOT_FOUND', 'CONTAINER_FILE_TOO_LARGE', 'CONTAINER_FILE_BINARY'].includes(cause.message)
          ) {
            throw cause;
          }
          if (cause.message.includes('does not exist') || cause.message.includes('Not a valid object name')) {
            throw new Error('CONTAINER_FILE_NOT_FOUND');
          }
        }
        throw cause;
      }
    }

    try {
      const typeResult = await this.runtime.execContainer(
        resources.workerContainer,
        ['git', '-C', revision.runRepository.containerPath, 'cat-file', '-t', `${reviewCommit}:${normalizedPath}`],
        { user: this.config.worker_user },
      );
      if (typeResult.stdout.trim() !== 'blob') {
        throw new Error('CONTAINER_FILE_NOT_FOUND');
      }
      const showResult = await this.runtime.execContainer(
        resources.workerContainer,
        ['git', '-C', revision.runRepository.containerPath, 'cat-file', '-p', `${reviewCommit}:${normalizedPath}`],
        { user: this.config.worker_user },
      );
      if (Buffer.byteLength(showResult.stdout) > maximumBytes) throw new Error('CONTAINER_FILE_TOO_LARGE');
      if (showResult.stdout.includes('\0')) throw new Error('CONTAINER_FILE_BINARY');
      return showResult.stdout;
    } catch (cause) {
      if (cause instanceof Error) {
        if (['CONTAINER_FILE_NOT_FOUND', 'CONTAINER_FILE_TOO_LARGE', 'CONTAINER_FILE_BINARY'].includes(cause.message)) {
          throw cause;
        }
        if (cause.message.includes('does not exist') || cause.message.includes('Not a valid object name')) {
          throw new Error('CONTAINER_FILE_NOT_FOUND');
        }
      }
      throw cause;
    }
  }

  /**
   * Validates and promotes reviewed changes to the host repository:
   * - Acquires file locks on affected host repositories.
   * - Confirms revision number and patch digest match the reviewed state.
   * - Verifies parent repository working tree has not diverged since the baseline snapshot.
   * - Applies patches to the host working tree and index, rolling back on failure.
   */
  async promote(
    agentId: string,
    expectedRevision: number,
    expectedDigest: string,
    options?: { allowStaleDependencies?: boolean },
  ): Promise<void> {
    const resources = this.require(agentId);
    if (resources.revision !== expectedRevision) throw new Error('CHANGE_SET_REVISION_MISMATCH');
    const summaries = [...resources.repositories.values()]
      .filter((revision) => revision.changes?.changedPaths.length)
      .map((revision) => [revision.runRepository.name, revision.changes!.patchDigest]);
    const digest = `sha256:${createHash('sha256').update(JSON.stringify(summaries)).digest('hex')}`;
    if (digest !== expectedDigest) throw new Error('CHANGE_SET_DIGEST_MISMATCH');
    const changed = [...resources.repositories.values()].filter((revision) => revision.changes?.changedPaths.length);

    for (const revision of changed) {
      if (revision.dependencyManifestStale && !options?.allowStaleDependencies) {
        throw new Error(
          `PROMOTION_DEPENDENCY_MANIFEST_STALE: Repository '${revision.runRepository.name}' modified dependency manifests while dependencies were mounted read-only. Host dependencies must be updated after promotion. Set allow_stale_dependencies to proceed.`,
        );
      }
    }
    const locks = this.acquirePromotionLocks(changed);
    try {
      for (const revision of changed) {
        assertNoManagedDependencyPaths(revision.changes!.changedPaths, this.config.platform);
        await checkRepositoryPromotion(revision.snapshot, revision.changes!);
      }
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
  async cleanup(agentId: string): Promise<void> {
    return this.delete(agentId);
  }

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
        dependencyMode: 'read-only',
      } satisfies ContainerAgentResources);
    await this.cleanupResources(resources);
    this.agents.delete(agentId);
    const agentDir = resolve(this.stateDir, 'container-agents', agentId);
    const expectedParent = resolve(this.stateDir, 'container-agents');
    if (!agentDir.startsWith(expectedParent) || agentDir === expectedParent) {
      throw new Error('CONTAINER_AGENT_CLEANUP_PATH_INVALID');
    }
    rmSync(agentDir, { recursive: true, force: true });
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
    for (const volume of resources.repositoryVolumes.values()) {
      if (await this.runtime.hasOwnershipLabels('volume', volume, labels))
        await this.runtime.removeVolume(volume).catch(() => undefined);
    }
    if (await this.runtime.hasOwnershipLabels('volume', resources.workerConfigVolume, labels))
      await this.runtime.removeVolume(resources.workerConfigVolume).catch(() => undefined);
    if (await this.runtime.hasOwnershipLabels('volume', resources.proxyConfigVolume, labels))
      await this.runtime.removeVolume(resources.proxyConfigVolume).catch(() => undefined);
    if (await this.runtime.hasOwnershipLabels('volume', resources.proxySharedVolume, labels))
      await this.runtime.removeVolume(resources.proxySharedVolume).catch(() => undefined);
    if (await this.runtime.hasOwnershipLabels('volume', resources.dependencyVolume, labels))
      await this.runtime.removeVolume(resources.dependencyVolume).catch(() => undefined);
    if (resources.privateInstallTargets) {
      for (const target of resources.privateInstallTargets) {
        if (await this.runtime.hasOwnershipLabels('volume', target.volume, labels))
          await this.runtime.removeVolume(target.volume).catch(() => undefined);
      }
    }
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

function validateRelativePath(path: string, platform?: 'windows' | 'linux'): void {
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
  if (isManagedDependencyPath(path, platform))
    throw new Error(`CONTAINER_PATCH_INVALID:managed_dependency_path_not_permitted:${path}`);
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

export function assertNoReparsePoints(rootDir: string, currentDir = rootDir): void {
  if (currentDir === rootDir) {
    let rootStat;
    try {
      rootStat = fs.lstatSync(rootDir);
    } catch (cause) {
      throw new Error(
        `CONTAINER_PATCH_INVALID:unreadable_path:${rootDir}:${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (rootStat.isSymbolicLink()) {
      throw new Error('CONTAINER_PATCH_INVALID:reparse_point_detected:.');
    }
  }

  let entries;
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch (cause) {
    const rel = relative(rootDir, currentDir).replace(/\\/g, '/') || '.';
    throw new Error(
      `CONTAINER_PATCH_INVALID:unreadable_directory:${rel}:${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    const relPath = relative(rootDir, fullPath).replace(/\\/g, '/');
    if (entry.isSymbolicLink()) {
      throw new Error(`CONTAINER_PATCH_INVALID:reparse_point_detected:${relPath}`);
    }
    let stat;
    try {
      stat = fs.lstatSync(fullPath);
    } catch (cause) {
      throw new Error(
        `CONTAINER_PATCH_INVALID:unreadable_path:${relPath}:${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`CONTAINER_PATCH_INVALID:reparse_point_detected:${relPath}`);
    }
    if (/^\..*?local-engineer-(?:backup|temp)-.*\.(?:bak|tmp)$/.test(entry.name)) {
      throw new Error(`CONTAINER_PATCH_INVALID:recovery_artifact_present:${relPath}`);
    }
    if (entry.isDirectory() && entry.name !== '.git') {
      assertNoReparsePoints(rootDir, fullPath);
    }
  }
}
