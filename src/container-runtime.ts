import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, statSync, type Stats } from 'node:fs';
import { isIP } from 'node:net';
import { basename, normalize, posix } from 'node:path';
import { isAbsoluteContainerPath } from './container-platform.js';
import type { ContainerPlatform } from './domain.js';
import { streamDirectoryToTar } from './tar-stream.js';

export interface RuntimeCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type RuntimeCommandExecutor = (
  executable: string,
  arguments_: readonly string[],
  options?: { input?: string | Buffer; timeoutMs?: number },
) => Promise<RuntimeCommandResult>;

export interface ContainerRuntimeProbe {
  supported: boolean;
  executable: string;
  version?: string;
  errorCode?: string;
  /** A bounded, non-sensitive explanation appropriate for MCP responses. */
  errorSummary?: string;
}

const RESOURCE_NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const AGENT_NETWORK_POOL = /^10\.(\d{1,3})\.0\.0\/16$/;

/**
 * Docker's automatic address allocator can select private ranges occupied by
 * the local model LAN. Keep every Local Engineer agent in a configurable,
 * deterministic /24 pair under an explicit 10.x /16 pool instead.
 */
export function agentNetworkSubnets(identity: string, pool = '10.240.0.0/16'): { internal: string; egress: string } {
  return agentNetworkSubnetCandidates(identity, pool)[0]!;
}

/**
 * Returns every non-overlapping /24 pair in a deterministic, identity-specific
 * order. The first pair preserves the original allocation behavior; callers
 * can fall back safely when a retained agent already owns that range.
 */
export function agentNetworkSubnetCandidates(
  identity: string,
  pool = '10.240.0.0/16',
): Array<{ internal: string; egress: string }> {
  const match = AGENT_NETWORK_POOL.exec(pool);
  if (!match) throw new Error('CONTAINER_AGENT_NETWORK_POOL_INVALID');
  const secondOctet = Number(match[1]);
  const startSlot = createHash('sha256').update(identity).digest().readUInt16BE(0) % 128;
  return Array.from({ length: 128 }, (_, offset) => {
    const thirdOctet = ((startSlot + offset) % 128) * 2;
    return {
      internal: `10.${secondOctet}.${thirdOctet}.0/24`,
      egress: `10.${secondOctet}.${thirdOctet + 1}.0/24`,
    };
  });
}

/**
 * Container Runtime Driver
 *
 * Provides a robust, cross-platform abstraction over the Docker CLI on Linux and Windows:
 * - Direct execution of Docker commands with bounded execution timeouts and structured errors.
 * - Runtime health probing (`probe()`): checks daemon availability, platform compatibility,
 *   Hyper-V container isolation, resource caps (CPU, memory), and network route isolation.
 * - Windows Hyper-V container support:
 *   - Kernel-level VM isolation via `--isolation hyperv`.
 *   - Resource limits (CPU cores, memory ceiling) assigned to utility VMs.
 *   - Deterministic 10.x subnet allocation avoiding local model server LAN conflicts.
 *   - Asynchronous network endpoint inspection timing.
 * - In-memory streaming USTAR tar archive transfers (`copyToContainer`).
 */

export class ContainerRuntime {
  constructor(
    readonly executable: string,
    private readonly execute: RuntimeCommandExecutor = executeRuntimeCommand,
    readonly context?: string,
    readonly platform: ContainerPlatform = 'linux',
    private readonly windowsResources: { memoryLimit: string; cpuCount: number } = {
      memoryLimit: '4g',
      cpuCount: 2,
    },
  ) {
    if (!executable.trim() || /[\r\n\0]/.test(executable)) throw new Error('CONTAINER_COMMAND_INVALID');
    if (context && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(context)) throw new Error('CONTAINER_CONTEXT_INVALID');
  }

  /**
   * Executes a comprehensive live capability probe of the container runtime:
   * 1. Validates Docker daemon responsiveness and OS platform match.
   * 2. Inspects base image availability and architectural compatibility.
   * 3. Tests private-network provisioning and, on Windows, the default NAT network's presence.
   * 4. Tests container creation with platform security controls (Hyper-V isolation, CPU/RAM caps).
   * 5. Boots test container and validates network routing lockdown and unprivileged user identity.
   * 6. Completely tears down all probe resources.
   */
  async probe(baseImage: string): Promise<ContainerRuntimeProbe> {
    const suffix = randomBytes(6).toString('hex');
    const prefix = `le-probe-${suffix}`;
    const internal = `${prefix}-internal`;
    const egress = `${prefix}-egress`;
    const volume = `${prefix}-volume`;
    const container = `${prefix}-container`;
    const labels = {
      'local-engineer.agent-id': `probe-${suffix}`,
      'local-engineer.managed': 'true',
    };
    try {
      const version = await this.run(['version', '--format', '{{json .}}']);
      const daemonPlatform = runtimePlatform(version.stdout);
      if (daemonPlatform !== this.platform)
        throw new Error(`CONTAINER_RUNTIME_PLATFORM_MISMATCH:${this.platform}:${daemonPlatform}`);
      await this.run(['info']);
      await this.run(['image', 'inspect', baseImage]);
      if (this.platform === 'windows') {
        await this.run(['network', 'inspect', 'nat']);
        await this.createWindowsInternalNetwork(internal, labels, agentNetworkSubnetCandidates(`probe-${suffix}`));
      } else {
        await this.createNetwork(internal, true, labels);
        await this.createNetwork(egress, false, labels);
      }
      await this.createVolume(volume, labels);
      await this.createContainer({
        name: container,
        image: baseImage,
        network: internal,
        mounts: [`type=volume,src=${volume},dst=${this.platform === 'windows' ? 'C:/workspace' : '/workspace'}`],
        user: this.platform === 'windows' ? 'ContainerUser' : undefined,
        labels,
        command:
          this.platform === 'windows'
            ? [
                'powershell.exe',
                '-NoLogo',
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                'while ($true) { Start-Sleep -Seconds 3600 }',
              ]
            : ['true'],
      });
      if (this.platform === 'windows') {
        await this.assertWindowsHyperVIsolation(container);
        await this.assertWindowsResourceLimits(container);
      }
      if (this.platform === 'linux') await this.connectNetwork(egress, container);
      if (this.platform === 'windows') {
        await this.startContainer(container);
        const endpoint = await this.containerNetworkEndpoint(container, internal);
        const network = await this.execContainer(
          container,
          [
            this.platform === 'windows'
              ? 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
              : 'powershell.exe',
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            'C:/local-engineer/configure-worker-network.ps1',
            '-ContainerAddress',
            endpoint.address,
            '-InterfaceMacAddress',
            endpoint.macAddress,
          ],
          { user: 'ContainerAdministrator', workdir: 'C:/Windows/System32' },
        );
        if (network.stdout.trim() !== 'LOCAL_ENGINEER_NETWORK_OK')
          throw new Error('CONTAINER_WINDOWS_NETWORK_ISOLATION_UNAVAILABLE');
        const groups = await this.execContainer(
          container,
          [this.platform === 'windows' ? 'C:/Windows/System32/whoami.exe' : 'whoami.exe', '/groups'],
          { user: 'ContainerUser' },
        );
        if (/S-1-5-32-544|BUILTIN\\Administrators/i.test(groups.stdout))
          throw new Error('CONTAINER_WINDOWS_WORKER_IS_ADMINISTRATOR');
        const imageLock = await this.execContainer(
          container,
          [
            this.platform === 'windows' ? 'C:/Node/node.exe' : 'node',
            '--eval',
            "const fs=require('node:fs');const roots=['C:/local-engineer','C:/npm','C:/Rust','C:/Node','C:/Python','C:/MinGit','C:/BuildTools','C:/src'];const writable=[];for(const root of roots){const p=root+'/.local-engineer-write-probe';try{fs.writeFileSync(p,'x');fs.unlinkSync(p);writable.push(root)}catch(e){if(!e||!['EACCES','EPERM'].includes(e.code))throw e}}process.stdout.write(writable.length?'LOCAL_ENGINEER_IMAGE_WRITABLE:'+writable.join(','):'LOCAL_ENGINEER_IMAGE_LOCKED')",
          ],
          { user: 'ContainerUser' },
        );
        if (imageLock.stdout.trim() !== 'LOCAL_ENGINEER_IMAGE_LOCKED')
          throw new Error('CONTAINER_WINDOWS_IMAGE_WRITABLE');
      }
      return {
        supported: true,
        executable: this.executable,
        version: runtimeVersion(version.stdout),
      };
    } catch (cause) {
      return {
        supported: false,
        executable: this.executable,
        errorCode: runtimeErrorCode(cause),
        errorSummary: runtimeErrorSummary(cause, this.executable),
      };
    } finally {
      await this.removeContainer(container, true).catch(() => undefined);
      await this.removeNetwork(internal).catch(() => undefined);
      await this.removeNetwork(egress).catch(() => undefined);
      await this.removeVolume(volume).catch(() => undefined);
    }
  }

  buildImage(input: {
    dockerfile: string;
    context: string;
    image: string;
    baseImage: string;
    codexVersion: string;
    network?: string;
    buildArguments?: Record<string, string>;
  }): Promise<RuntimeCommandResult> {
    return this.run(
      [
        'build',
        '--file',
        input.dockerfile,
        '--tag',
        input.image,
        ...(input.network ? ['--network', input.network] : []),
        '--build-arg',
        `BASE_IMAGE=${input.baseImage}`,
        '--build-arg',
        `CODEX_VERSION=${input.codexVersion}`,
        ...Object.entries(input.buildArguments ?? {}).flatMap(([name, value]) => ['--build-arg', `${name}=${value}`]),
        input.context,
      ],
      { timeoutMs: 60 * 60 * 1000 },
    );
  }

  run(
    arguments_: readonly string[],
    options?: { input?: string | Buffer; timeoutMs?: number },
  ): Promise<RuntimeCommandResult> {
    validateArguments(arguments_);
    const contextArguments = this.context ? ['--context', this.context] : [];
    return this.execute(this.executable, [...contextArguments, ...arguments_], options).then((result) => {
      if (result.exitCode !== 0)
        throw new Error(
          `CONTAINER_RUNTIME_COMMAND_FAILED:${result.exitCode}:${boundedEnd(result.stderr.trim(), 4000) || 'unknown'}`,
        );
      return result;
    });
  }

  createNetwork(
    name: string,
    internal: boolean,
    labels: Record<string, string>,
    subnet?: string,
  ): Promise<RuntimeCommandResult> {
    validateResourceName(name);
    if (subnet && !/^10\.\d{1,3}\.\d{1,3}\.0\/24$/.test(subnet)) throw new Error('CONTAINER_NETWORK_SUBNET_INVALID');
    return this.run([
      'network',
      'create',
      ...(this.platform === 'linux' && internal ? ['--internal'] : []),
      ...(this.platform === 'windows' ? ['--driver', 'nat'] : []),
      ...(subnet ? ['--subnet', subnet] : []),
      ...labelArguments(labels),
      name,
    ]);
  }

  /**
   * Atomically enough for Docker-compatible runtimes: if either half of a
   * pair overlaps a pre-existing network, remove only the just-created managed
   * half and try the next candidate. This avoids a hash collision between
   * retained agents while never deleting another agent's resources.
   */
  async createNetworkPair(input: {
    internalName: string;
    egressName: string;
    labels: Record<string, string>;
    candidates: ReadonlyArray<{ internal: string; egress: string }>;
  }): Promise<{ internal: string; egress: string }> {
    for (const candidate of input.candidates) {
      let internalCreated = false;
      try {
        await this.createNetwork(input.internalName, true, input.labels, candidate.internal);
        internalCreated = true;
        await this.createNetwork(input.egressName, false, input.labels, candidate.egress);
        return candidate;
      } catch (cause) {
        if (internalCreated) await this.removeNetwork(input.internalName).catch(() => undefined);
        if (!isNetworkPoolOverlap(cause)) throw cause;
      }
    }
    throw new Error('CONTAINER_AGENT_NETWORK_POOL_EXHAUSTED');
  }

  /** Windows supports one working outbound NAT; only the worker's private network is per-agent. */
  async createWindowsInternalNetwork(
    name: string,
    labels: Record<string, string>,
    candidates: ReadonlyArray<{ internal: string }>,
  ): Promise<string> {
    if (this.platform !== 'windows') throw new Error('CONTAINER_WINDOWS_NETWORK_PLATFORM_REQUIRED');
    for (const candidate of candidates) {
      try {
        await this.createNetwork(name, true, labels, candidate.internal);
        return candidate.internal;
      } catch (cause) {
        if (!isNetworkPoolOverlap(cause)) throw cause;
      }
    }
    throw new Error('CONTAINER_AGENT_NETWORK_POOL_EXHAUSTED');
  }

  removeNetwork(name: string): Promise<RuntimeCommandResult> {
    validateResourceName(name);
    return this.run(['network', 'rm', name]);
  }

  createVolume(name: string, labels: Record<string, string>): Promise<RuntimeCommandResult> {
    validateResourceName(name);
    return this.run(['volume', 'create', ...labelArguments(labels), name]);
  }

  removeVolume(name: string): Promise<RuntimeCommandResult> {
    validateResourceName(name);
    return this.run(['volume', 'rm', name]);
  }

  removeContainer(name: string, force = false): Promise<RuntimeCommandResult> {
    validateResourceName(name);
    return this.run(['rm', ...(force ? ['--force'] : []), name]);
  }

  /**
   * Creates a container configured with strict platform-specific security boundaries:
   * - Windows: enforces Hyper-V utility VM isolation (`--isolation hyperv`) with explicit
   *   CPU core and memory resource bounds.
   * - Linux: drops all capabilities, adds `no-new-privileges`, enforces PID limits,
   *   read-only root filesystem, and size-capped `/tmp` tmpfs.
   */
  createContainer(input: {
    name: string;
    image: string;
    network: string;
    networkAliases?: string[];
    user?: string;
    mounts?: string[];
    environment?: Record<string, string>;
    inheritEnvironment?: string[];
    capabilities?: string[];
    labels: Record<string, string>;
    readOnlyRoot?: boolean;
    command?: string[];
  }): Promise<RuntimeCommandResult> {
    validateResourceName(input.name);
    validateResourceName(input.network);
    const capabilities = input.capabilities ?? [];
    if (capabilities.some((capability) => capability !== 'CHOWN')) throw new Error('CONTAINER_CAPABILITY_INVALID');
    const securityArguments =
      this.platform === 'windows'
        ? [
            '--isolation',
            'hyperv',
            '--memory',
            this.windowsResources.memoryLimit,
            '--cpu-count',
            String(this.windowsResources.cpuCount),
          ]
        : [
            '--cap-drop',
            'ALL',
            ...capabilities.flatMap((capability) => ['--cap-add', capability]),
            '--security-opt',
            'no-new-privileges',
            '--pids-limit',
            '512',
            ...(input.readOnlyRoot === false ? [] : ['--read-only']),
            '--tmpfs',
            '/tmp:rw,nosuid,nodev,size=1g',
          ];
    return this.run([
      'create',
      '--name',
      input.name,
      '--network',
      input.network,
      ...(input.networkAliases ?? []).flatMap((alias) => {
        validateResourceName(alias);
        return ['--network-alias', alias];
      }),
      ...securityArguments,
      ...(input.user ? ['--user', input.user] : []),
      ...(input.mounts ?? []).flatMap((mount) => ['--mount', mount]),
      ...environmentArguments(input.environment ?? {}),
      ...inheritEnvironmentArguments(input.inheritEnvironment ?? []),
      ...labelArguments(input.labels),
      input.image,
      ...(input.command ?? []),
    ]);
  }

  startContainer(name: string): Promise<RuntimeCommandResult> {
    validateResourceName(name);
    return this.run(['start', name]);
  }

  stopContainer(name: string, timeoutSeconds = 10): Promise<RuntimeCommandResult> {
    validateResourceName(name);
    return this.run(['stop', '--time', String(timeoutSeconds), name]);
  }

  async isContainerRunning(name: string): Promise<boolean> {
    validateResourceName(name);
    const result = await this.run(['container', 'inspect', '--format', '{{.State.Running}}', name]);
    const trimmed = result.stdout.trim().toLowerCase();
    if (trimmed !== 'true' && trimmed !== 'false') {
      throw new Error(`CONTAINER_STATE_INVALID:${name}:${boundedEnd(trimmed, 100)}`);
    }
    return trimmed === 'true';
  }

  pauseContainer(name: string): Promise<RuntimeCommandResult> {
    validateResourceName(name);
    return this.run(['pause', name]);
  }

  unpauseContainer(name: string): Promise<RuntimeCommandResult> {
    validateResourceName(name);
    return this.run(['unpause', name]);
  }

  containerLogs(name: string, tail = 100): Promise<RuntimeCommandResult> {
    validateResourceName(name);
    if (!Number.isInteger(tail) || tail < 1 || tail > 1000) throw new Error('CONTAINER_LOG_TAIL_INVALID');
    return this.run(['logs', '--tail', String(tail), name]);
  }

  connectNetwork(network: string, container: string, address?: string): Promise<RuntimeCommandResult> {
    validateResourceName(network);
    validateResourceName(container);
    if (address && !/^10\.\d{1,3}\.\d{1,3}\.2$/.test(address))
      throw new Error('CONTAINER_NETWORK_STATIC_ADDRESS_INVALID');
    return this.run(['network', 'connect', ...(address ? ['--ip', address] : []), network, container]);
  }

  disconnectNetwork(network: string, container: string): Promise<RuntimeCommandResult> {
    validateResourceName(network);
    validateResourceName(container);
    return this.run(['network', 'disconnect', network, container]);
  }

  /**
   * Copies files or directory trees into a container.
   * On Windows with Hyper-V isolation, standard `docker cp` fails against running containers
   * (`filesystem operations against a running Hyper-V container are not supported`).
   * In that case, falls back to `copyToWindowsHyperVContainer` which streams tar archives
   * or file buffers via `docker exec` stdin directly into the container.
   */
  copyToContainer(source: string, container: string, destination: string): Promise<RuntimeCommandResult> {
    validateResourceName(container);
    if (!source || /[\r\n\0]/.test(source) || !isAbsoluteContainerPath(this.platform, destination))
      throw new Error('CONTAINER_COPY_PATH_INVALID');
    return this.run(['cp', source, `${container}:${destination}`]).catch((cause) => {
      if (
        this.platform === 'windows' &&
        cause instanceof Error &&
        cause.message.includes('filesystem operations against a running Hyper-V container are not supported')
      ) {
        return this.copyToWindowsHyperVContainer(source, container, destination);
      }
      throw cause;
    });
  }

  /**
   * Streams directories as in-memory USTAR tar archives into container `tar.exe -xf -`,
   * or pipes single file contents via stdin to a Node script inside the container.
   */
  private async copyToWindowsHyperVContainer(
    source: string,
    container: string,
    destination: string,
  ): Promise<RuntimeCommandResult> {
    const isDirContents = source.endsWith('/.') || source.endsWith('\\.');
    const normalizedSource = isDirContents ? source.slice(0, -2) : source;
    let sourceStat: Stats;
    try {
      sourceStat = statSync(normalizedSource);
    } catch (cause) {
      throw new Error(`CONTAINER_COPY_SOURCE_NOT_FOUND:${cause instanceof Error ? cause.message : String(cause)}`);
    }

    if (sourceStat.isDirectory()) {
      const sourceDir = normalizedSource;
      const targetDir = isDirContents ? destination : posix.join(destination, basename(sourceDir));
      await this.execContainer(
        container,
        ['node', '--eval', "require('node:fs').mkdirSync(process.argv[1],{recursive:true})", targetDir],
        { user: 'ContainerAdministrator' },
      );
      const result = await new Promise<RuntimeCommandResult>((resolve, reject) => {
        const contextArguments = this.context ? ['--context', this.context] : [];
        const containerTar = spawn(
          this.executable,
          [
            ...contextArguments,
            'exec',
            '-i',
            '--user',
            'ContainerAdministrator',
            '--workdir',
            'C:/Windows/System32',
            container,
            'C:/Windows/System32/tar.exe',
            '-xf',
            '-',
            '--no-same-permissions',
            '--no-same-owner',
            '-C',
            targetDir,
          ],
          { stdio: 'pipe', windowsHide: true, shell: false },
        );
        containerTar.stdin.on('error', () => undefined);
        let stdout = '';
        let stderr = '';
        containerTar.stdout.on('data', (chunk: Buffer) => {
          stdout = (stdout + chunk.toString('utf8')).slice(-20 * 1024 * 1024);
        });
        containerTar.stderr.on('data', (chunk: Buffer) => {
          stderr = (stderr + chunk.toString('utf8')).slice(-20 * 1024 * 1024);
        });
        const timer = setTimeout(() => {
          containerTar.kill();
          reject(new Error('CONTAINER_RUNTIME_COMMAND_TIMEOUT'));
        }, 300_000);
        containerTar.on('error', (err) => {
          clearTimeout(timer);
          reject(new Error(`CONTAINER_RUNTIME_TAR_FAILED:${err.message}`));
        });
        containerTar.on('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) {
            resolve({ exitCode: 0, stdout, stderr });
          } else {
            reject(new Error(`CONTAINER_RUNTIME_COMMAND_FAILED:${code}:${stderr.trim()}`));
          }
        });
        streamDirectoryToTar(sourceDir, containerTar.stdin).catch((err) => {
          clearTimeout(timer);
          containerTar.kill();
          reject(new Error(`CONTAINER_RUNTIME_TAR_FAILED:${err.message}`));
        });
      });
      return result;
    }

    const script =
      "const fs = require('fs'); const path = require('path'); let dest = process.argv[1]; const srcBase = process.argv[2]; try { if (fs.existsSync(dest) && fs.statSync(dest).isDirectory()) { dest = path.join(dest, srcBase); } } catch {} fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, fs.readFileSync(0));";
    return new Promise<RuntimeCommandResult>((resolvePromise, reject) => {
      const contextArguments = this.context ? ['--context', this.context] : [];
      const child = spawn(
        this.executable,
        [
          ...contextArguments,
          'exec',
          '-i',
          '--user',
          'ContainerAdministrator',
          '--workdir',
          'C:/Windows/System32',
          container,
          'C:/Node/node.exe',
          '-e',
          script,
          destination,
          basename(source),
        ],
        { stdio: 'pipe', windowsHide: true, shell: false },
      );
      child.stdin.on('error', () => undefined);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = (stdout + chunk.toString('utf8')).slice(-20 * 1024 * 1024);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-20 * 1024 * 1024);
      });
      const timer = setTimeout(() => {
        sourceStream.destroy();
        child.kill();
        reject(new Error('CONTAINER_RUNTIME_COMMAND_TIMEOUT'));
      }, 300_000);
      const sourceStream = createReadStream(source);
      child.once('error', (cause) => {
        clearTimeout(timer);
        sourceStream.destroy();
        reject(new Error(`CONTAINER_RUNTIME_LAUNCH_FAILED:${cause.message}`));
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        sourceStream.destroy();
        if (code === 0) resolvePromise({ exitCode: 0, stdout, stderr });
        else reject(new Error(`CONTAINER_RUNTIME_COMMAND_FAILED:${code ?? -1}:${stderr.trim()}`));
      });
      sourceStream.once('error', (cause) => {
        clearTimeout(timer);
        child.kill();
        reject(new Error(`CONTAINER_RUNTIME_COPY_FAILED:${cause.message}`));
      });
      sourceStream.pipe(child.stdin);
    });
  }

  copyFromContainer(container: string, source: string, destination: string): Promise<RuntimeCommandResult> {
    validateResourceName(container);
    if (!isAbsoluteContainerPath(this.platform, source) || !destination || /[\r\n\0]/.test(destination))
      throw new Error('CONTAINER_COPY_PATH_INVALID');
    return this.run(['cp', `${container}:${source}`, destination]);
  }

  commitContainer(container: string, image: string, changes: string[] = []): Promise<RuntimeCommandResult> {
    validateResourceName(container);
    if (!image || /[\r\n\0]/.test(image)) throw new Error('CONTAINER_IMAGE_INVALID');
    if (changes.some((change) => !change || /[\r\n\0]/.test(change)))
      throw new Error('CONTAINER_COMMIT_CHANGE_INVALID');
    return this.run(['commit', ...changes.flatMap((change) => ['--change', change]), container, image]);
  }

  async execContainer(
    container: string,
    arguments_: string[],
    options?: {
      user?: string;
      workdir?: string;
      environment?: Record<string, string>;
      input?: string | Buffer;
    },
  ): Promise<RuntimeCommandResult> {
    validateResourceName(container);
    const user = options?.user?.trim();
    const userComponent = user ? (user.split(':')[0]?.trim() ?? '') : '';
    const isPrivileged =
      userComponent.length > 0 &&
      (/^containeradministrator$/i.test(userComponent) ||
        /^root$/i.test(userComponent) ||
        (/^[+-]?\d+$/.test(userComponent) && BigInt(userComponent) === 0n));
    const safeAdminWorkdir = this.platform === 'windows' ? 'C:/Windows/System32' : '/';
    let workdir: string | undefined;
    if (isPrivileged) {
      if (options?.workdir !== undefined) {
        const normalized = options.workdir.replaceAll('\\', '/');
        const matches =
          this.platform === 'windows'
            ? normalized.toLowerCase() === 'c:/windows/system32'
            : (normalized.replace(/\/+$/, '') || '/') === '/';
        if (!matches) {
          throw new Error(`CONTAINER_PRIVILEGED_WORKDIR_UNSAFE: Privileged executions must use ${safeAdminWorkdir}`);
        }
        workdir = safeAdminWorkdir;
      } else {
        workdir = safeAdminWorkdir;
      }
    } else {
      workdir = options?.workdir;
    }
    const normalizedArguments = [...arguments_];
    const firstArgument = normalizedArguments[0];
    if (this.platform === 'windows' && isPrivileged && firstArgument !== undefined) {
      const command = firstArgument.toLowerCase();
      if (command === 'powershell.exe' || command === 'powershell') {
        normalizedArguments[0] = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
      } else if (command === 'git' || command === 'git.exe') {
        normalizedArguments[0] = 'C:/MinGit/cmd/git.exe';
      } else if (command === 'node' || command === 'node.exe') {
        normalizedArguments[0] = 'C:/Node/node.exe';
      } else if (command === 'tar' || command === 'tar.exe') {
        normalizedArguments[0] = 'C:/Windows/System32/tar.exe';
      } else if (command === 'whoami' || command === 'whoami.exe') {
        normalizedArguments[0] = 'C:/Windows/System32/whoami.exe';
      } else if (command === 'icacls' || command === 'icacls.exe') {
        normalizedArguments[0] = 'C:/Windows/System32/icacls.exe';
      } else if (command === 'cmd' || command === 'cmd.exe') {
        normalizedArguments[0] = 'C:/Windows/System32/cmd.exe';
      }
    }
    return this.run(
      [
        'exec',
        ...(options?.input !== undefined ? ['-i'] : []),
        ...(options?.user ? ['--user', options.user] : []),
        ...(workdir ? ['--workdir', workdir] : []),
        ...environmentArguments(options?.environment ?? {}),
        container,
        ...normalizedArguments,
      ],
      { input: options?.input },
    );
  }

  /**
   * Verifies that a container is running under Hyper-V utility VM isolation on Windows.
   * Throws if the container is using process-isolated mode or any other isolation type.
   */
  async assertWindowsHyperVIsolation(container: string): Promise<void> {
    if (this.platform !== 'windows') throw new Error('CONTAINER_WINDOWS_OPERATION_INVALID');
    validateResourceName(container);
    const result = await this.run(['container', 'inspect', '--format', '{{.HostConfig.Isolation}}', container]);
    if (result.stdout.trim().toLowerCase() !== 'hyperv') throw new Error('CONTAINER_WINDOWS_HYPERV_REQUIRED');
  }

  async assertWindowsResourceLimits(container: string): Promise<void> {
    if (this.platform !== 'windows') throw new Error('CONTAINER_WINDOWS_OPERATION_INVALID');
    validateResourceName(container);
    const result = await this.run(['container', 'inspect', '--format', '{{json .HostConfig}}', container]);
    const host = JSON.parse(result.stdout.trim()) as { Memory?: unknown; CpuCount?: unknown };
    if (
      host.Memory !== parseMemoryBytes(this.windowsResources.memoryLimit) ||
      host.CpuCount !== this.windowsResources.cpuCount
    )
      throw new Error('CONTAINER_WINDOWS_RESOURCE_LIMITS_REQUIRED');
  }

  async containerNetworkAddress(container: string, network: string): Promise<string> {
    return (await this.containerNetworkEndpoint(container, network)).address;
  }

  /**
   * Inspects a container's assigned IPv4 address and MAC address on a specified network.
   * On Windows with Hyper-V isolation, the container must be started before this is called
   * because the NAT driver populates IP and MAC properties only after the utility VM boots.
   */
  async containerNetworkEndpoint(container: string, network: string): Promise<{ address: string; macAddress: string }> {
    validateResourceName(container);
    validateResourceName(network);
    const result = await this.run([
      'container',
      'inspect',
      '--format',
      '{{json .NetworkSettings.Networks}}',
      container,
    ]);
    const networks = JSON.parse(result.stdout.trim()) as Record<string, { IPAddress?: unknown; MacAddress?: unknown }>;
    const address = networks[network]?.IPAddress;
    const macAddress = networks[network]?.MacAddress;
    if (
      typeof address !== 'string' ||
      isIP(address) !== 4 ||
      (network === 'nat'
        ? !/^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/.test(address)
        : !address.startsWith('10.'))
    )
      throw new Error('CONTAINER_NETWORK_ADDRESS_INVALID');
    if (typeof macAddress !== 'string' || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(macAddress))
      throw new Error('CONTAINER_NETWORK_MAC_INVALID');
    return { address, macAddress };
  }

  async hasOwnershipLabels(
    kind: 'container' | 'network' | 'volume',
    name: string,
    expected: Record<string, string>,
  ): Promise<boolean> {
    validateResourceName(name);
    const field = kind === 'container' ? '.Config.Labels' : '.Labels';
    try {
      const result = await this.run([kind, 'inspect', '--format', `{{json ${field}}}`, name]);
      const labels = JSON.parse(result.stdout.trim()) as unknown;
      if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return false;
      return Object.entries(expected).every(([key, value]) => (labels as Record<string, unknown>)[key] === value);
    } catch {
      return false;
    }
  }

  async listVolumesByLabels(expected: Record<string, string>): Promise<string[]> {
    const filters = Object.entries(expected)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([name, value]) => {
        if (!/^local-engineer\.[a-z0-9-]+$/.test(name) || /[\r\n\0]/.test(value))
          throw new Error('CONTAINER_LABEL_INVALID');
        return ['--filter', `label=${name}=${value}`];
      });
    const result = await this.run(['volume', 'ls', ...filters, '--format', '{{.Name}}']);
    const names = result.stdout
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter(Boolean);
    for (const name of names) validateResourceName(name);
    return names;
  }

  async listContainersByLabels(expected: Record<string, string>): Promise<string[]> {
    const filters = Object.entries(expected)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([name, value]) => {
        if (!/^local-engineer\.[a-z0-9-]+$/.test(name) || /[\r\n\0]/.test(value))
          throw new Error('CONTAINER_LABEL_INVALID');
        return ['--filter', `label=${name}=${value}`];
      });
    const result = await this.run(['ps', '-a', ...filters, '--format', '{{.Names}}']);
    const names = result.stdout
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter(Boolean);
    for (const name of names) validateResourceName(name);
    return names;
  }

  /**
   * Constructs and validates a structured Docker `--mount type=bind,...` argument.
   */
  buildBindMount(options: BindMountOptions): string {
    return buildStructuredBindMount(options);
  }
}

export interface BindMountOptions {
  source: string;
  target: string;
  readOnly?: boolean;
  permittedSourceRoots?: string[];
}

function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if ((code >= 0 && code <= 31) || code === 127) return true;
  }
  return false;
}

export function buildStructuredBindMount(options: BindMountOptions): string {
  const { source, target, readOnly, permittedSourceRoots } = options;
  if (!source || !target) throw new Error('CONTAINER_BIND_MOUNT_INVALID:empty_path');
  if (hasControlCharacters(source) || hasControlCharacters(target)) {
    throw new Error('CONTAINER_BIND_MOUNT_INVALID:control_characters');
  }
  if (source.includes(',') || target.includes(',')) {
    throw new Error('CONTAINER_BIND_MOUNT_INVALID:comma_not_supported');
  }
  if (/^(?:\\\\|\/\/)/.test(source) || /^(?:\\\\|\/\/)/.test(target)) {
    throw new Error('CONTAINER_BIND_MOUNT_INVALID:unc_path');
  }
  if (/^[\\/]{2,}\.?[\\/]/.test(source) || /^[\\/]{2,}\.?[\\/]/.test(target)) {
    throw new Error('CONTAINER_BIND_MOUNT_INVALID:device_path');
  }
  if (source.slice(2).includes(':') || target.slice(2).includes(':')) {
    throw new Error('CONTAINER_BIND_MOUNT_INVALID:alternate_data_stream');
  }
  if (!/^[cC]:[\\/]/.test(source) || !/^[cC]:[\\/]/.test(target)) {
    throw new Error('CONTAINER_BIND_MOUNT_INVALID:unsupported_drive');
  }
  const normalizedSource = normalize(source).replace(/\\/g, '/');
  const normalizedTarget = normalize(target).replace(/\\/g, '/');
  if (
    normalizedSource.includes('/../') ||
    normalizedSource.endsWith('/..') ||
    normalizedTarget.includes('/../') ||
    normalizedTarget.endsWith('/..')
  ) {
    throw new Error('CONTAINER_BIND_MOUNT_INVALID:traversal');
  }
  if (permittedSourceRoots && permittedSourceRoots.length > 0) {
    const allowed = permittedSourceRoots.some((root) => {
      const normRoot = normalize(root).replace(/\\/g, '/').replace(/\/+$/, '');
      return (
        normalizedSource.toLowerCase() === normRoot.toLowerCase() ||
        normalizedSource.toLowerCase().startsWith(`${normRoot.toLowerCase()}/`)
      );
    });
    if (!allowed) throw new Error(`CONTAINER_BIND_MOUNT_SOURCE_UNPERMITTED:${source}`);
  }
  return `type=bind,src=${normalizedSource},dst=${normalizedTarget}${readOnly ? ',readonly' : ''}`;
}

export function executeRuntimeCommand(
  executable: string,
  arguments_: readonly string[],
  options: { input?: string | Buffer; timeoutMs?: number } = {},
): Promise<RuntimeCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...arguments_], {
      stdio: 'pipe',
      windowsHide: true,
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    const maximumOutput = 20 * 1024 * 1024;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-maximumOutput);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-maximumOutput);
    });
    child.once('error', (cause) => reject(new Error(`CONTAINER_RUNTIME_LAUNCH_FAILED:${cause.message}`)));
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill();
          reject(new Error('CONTAINER_RUNTIME_COMMAND_TIMEOUT'));
        }, options.timeoutMs)
      : undefined;
    child.once('exit', (exitCode) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: exitCode ?? -1, stdout, stderr });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input);
  });
}

function labelArguments(labels: Record<string, string>): string[] {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([name, value]) => {
      if (!/^local-engineer\.[a-z0-9-]+$/.test(name) || /[\r\n\0]/.test(value))
        throw new Error('CONTAINER_LABEL_INVALID');
      return ['--label', `${name}=${value}`];
    });
}

function environmentArguments(environment: Record<string, string>): string[] {
  return Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([name, value]) => {
      if (!/^[A-Z_][A-Z0-9_]*$/i.test(name) || /[\r\n\0]/.test(value)) throw new Error('CONTAINER_ENVIRONMENT_INVALID');
      return ['--env', `${name}=${value}`];
    });
}

function inheritEnvironmentArguments(names: string[]): string[] {
  return [...new Set(names)].sort().flatMap((name) => {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) throw new Error('CONTAINER_ENVIRONMENT_INVALID');
    if (process.env[name] === undefined) throw new Error(`CONTAINER_ENVIRONMENT_VARIABLE_MISSING:${name}`);
    return ['--env', name];
  });
}

function validateArguments(arguments_: readonly string[]): void {
  if (!arguments_.length || arguments_.some((argument) => /[\r\n\0]/.test(argument)))
    throw new Error('CONTAINER_ARGUMENT_INVALID');
}

function validateResourceName(name: string): void {
  if (!RESOURCE_NAME.test(name)) throw new Error('CONTAINER_RESOURCE_NAME_INVALID');
}

function bounded(value: string, maximum: number): string {
  return value.slice(0, maximum);
}

function boundedEnd(value: string, maximum: number): string {
  return value.slice(-maximum);
}

function runtimeVersion(value: string): string {
  const trimmed = value.trim();
  try {
    const parsed = JSON.parse(trimmed) as {
      Server?: { Version?: unknown };
      Client?: { Version?: unknown };
    };
    const server = parsed.Server?.Version;
    const client = parsed.Client?.Version;
    if (typeof server === 'string')
      return typeof client === 'string' && client !== server ? `server ${server}, client ${client}` : server;
  } catch {
    // Non-Docker compatible CLIs may return a plain version string.
  }
  return bounded(trimmed, 1000);
}

function runtimePlatform(value: string): ContainerPlatform {
  try {
    const parsed = JSON.parse(value.trim()) as { Server?: { Os?: unknown } };
    const platform = parsed.Server?.Os;
    if (platform === 'linux' || platform === 'windows') return platform;
  } catch {
    // Capability probe fails closed below.
  }
  throw new Error('CONTAINER_RUNTIME_PLATFORM_UNKNOWN');
}

function parseMemoryBytes(value: string): number {
  const match = /^(?<amount>[1-9][0-9]*)(?<unit>[kKmMgG])?[bB]?$/.exec(value);
  if (!match?.groups) throw new Error('CONTAINER_WINDOWS_MEMORY_LIMIT_INVALID');
  const amount = Number(match.groups.amount);
  const multiplier = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match.groups.unit?.toLowerCase() ?? ''] ?? 1;
  const bytes = amount * multiplier;
  if (!Number.isSafeInteger(bytes)) throw new Error('CONTAINER_WINDOWS_MEMORY_LIMIT_INVALID');
  return bytes;
}

function runtimeErrorCode(cause: unknown): string {
  return cause instanceof Error ? cause.message.split(':')[0]! : 'CONTAINER_RUNTIME_UNSUPPORTED';
}

function runtimeErrorSummary(cause: unknown, executable: string): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (
    /failed to connect to the (docker|container) API|cannot connect to the Docker daemon|docker_engine|podman\.sock|is the daemon running/i.test(
      message,
    )
  ) {
    return `The ${executable} daemon is unavailable. Start the container runtime and retry the agent.`;
  }
  if (/CONTAINER_RUNTIME_LAUNCH_FAILED/i.test(message)) {
    return `Local Engineer could not launch the configured container command (${executable}). Verify it is installed and on PATH.`;
  }
  if (/CONTAINER_RUNTIME_COMMAND_TIMEOUT/i.test(message)) {
    return 'The container runtime capability probe timed out. Verify the container runtime is healthy and retry the agent.';
  }
  if (/CONTAINER_RUNTIME_PLATFORM_MISMATCH/i.test(message)) {
    return 'The configured Docker daemon is running the wrong container platform. Switch Docker Desktop to the configured platform and retry.';
  }
  if (/CONTAINER_WINDOWS_HYPERV_REQUIRED/i.test(message)) {
    return 'Windows containers must support verified Hyper-V isolation. Enable Hyper-V isolation and retry.';
  }
  if (
    /CONTAINER_WINDOWS_NETWORK_ISOLATION_UNAVAILABLE|CONTAINER_WINDOWS_WORKER_IS_ADMINISTRATOR|CONTAINER_WINDOWS_IMAGE_WRITABLE|CONTAINER_WINDOWS_RESOURCE_LIMITS_REQUIRED|CONTAINER_WINDOWS_READ_ONLY_ACL_UNAVAILABLE/i.test(
      message,
    )
  ) {
    return 'The Windows worker image failed a mandatory route, identity, immutable-tooling, or resource-limit security check.';
  }
  return 'The configured container runtime failed its capability probe. Run `local-engineer doctor` for safe diagnostics.';
}

function isNetworkPoolOverlap(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    /pool overlaps with other one|overlaps with other one on this address space|hnsCallRawResponse:.*(?:object already exists|0x1392)/i.test(
      cause.message,
    )
  );
}
