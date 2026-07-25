import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export interface RuntimeCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type RuntimeCommandExecutor = (
  executable: string,
  arguments_: readonly string[],
  options?: { input?: string; timeoutMs?: number },
) => Promise<RuntimeCommandResult>;

export interface ContainerRuntimeProbe {
  supported: boolean;
  executable: string;
  version?: string;
  errorCode?: string;
}

const RESOURCE_NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/;

export class ContainerRuntime {
  constructor(
    readonly executable: string,
    private readonly execute: RuntimeCommandExecutor = executeRuntimeCommand,
  ) {
    if (!executable.trim() || /[\r\n\0]/.test(executable)) throw new Error('CONTAINER_COMMAND_INVALID');
  }

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
      await this.run(['info']);
      await this.run(['image', 'inspect', baseImage]);
      await this.createNetwork(internal, true, labels);
      await this.createNetwork(egress, false, labels);
      await this.createVolume(volume, labels);
      await this.createContainer({
        name: container,
        image: baseImage,
        network: internal,
        mounts: [`type=volume,src=${volume},dst=/workspace`],
        labels,
        command: ['true'],
      });
      await this.connectNetwork(egress, container);
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

  run(arguments_: readonly string[], options?: { input?: string; timeoutMs?: number }): Promise<RuntimeCommandResult> {
    validateArguments(arguments_);
    return this.execute(this.executable, arguments_, options).then((result) => {
      if (result.exitCode !== 0)
        throw new Error(
          `CONTAINER_RUNTIME_COMMAND_FAILED:${result.exitCode}:${boundedEnd(result.stderr.trim(), 4000) || 'unknown'}`,
        );
      return result;
    });
  }

  createNetwork(name: string, internal: boolean, labels: Record<string, string>): Promise<RuntimeCommandResult> {
    validateResourceName(name);
    return this.run(['network', 'create', ...(internal ? ['--internal'] : []), ...labelArguments(labels), name]);
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
      '--cap-drop',
      'ALL',
      ...(input.capabilities ?? []).flatMap((capability) => {
        if (capability !== 'CHOWN') throw new Error('CONTAINER_CAPABILITY_INVALID');
        return ['--cap-add', capability];
      }),
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '512',
      ...(input.readOnlyRoot === false ? [] : ['--read-only']),
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,size=1g',
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

  containerLogs(name: string, tail = 100): Promise<RuntimeCommandResult> {
    validateResourceName(name);
    if (!Number.isInteger(tail) || tail < 1 || tail > 1000) throw new Error('CONTAINER_LOG_TAIL_INVALID');
    return this.run(['logs', '--tail', String(tail), name]);
  }

  connectNetwork(network: string, container: string): Promise<RuntimeCommandResult> {
    validateResourceName(network);
    validateResourceName(container);
    return this.run(['network', 'connect', network, container]);
  }

  copyToContainer(source: string, container: string, destination: string): Promise<RuntimeCommandResult> {
    validateResourceName(container);
    if (!source || /[\r\n\0]/.test(source) || !destination.startsWith('/') || /[\r\n\0]/.test(destination))
      throw new Error('CONTAINER_COPY_PATH_INVALID');
    return this.run(['cp', source, `${container}:${destination}`]);
  }

  copyFromContainer(container: string, source: string, destination: string): Promise<RuntimeCommandResult> {
    validateResourceName(container);
    if (!source.startsWith('/') || /[\r\n\0]/.test(source) || !destination || /[\r\n\0]/.test(destination))
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

  execContainer(
    container: string,
    arguments_: string[],
    options?: { user?: string; environment?: Record<string, string>; input?: string },
  ): Promise<RuntimeCommandResult> {
    validateResourceName(container);
    return this.run(
      [
        'exec',
        ...(options?.user ? ['--user', options.user] : []),
        ...environmentArguments(options?.environment ?? {}),
        container,
        ...arguments_,
      ],
      { input: options?.input },
    );
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
}

export function executeRuntimeCommand(
  executable: string,
  arguments_: readonly string[],
  options: { input?: string; timeoutMs?: number } = {},
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

function runtimeErrorCode(cause: unknown): string {
  return cause instanceof Error ? cause.message.split(':')[0]! : 'CONTAINER_RUNTIME_UNSUPPORTED';
}
