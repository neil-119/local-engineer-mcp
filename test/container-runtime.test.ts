import { describe, expect, it } from 'vitest';
import {
  agentNetworkSubnetCandidates,
  agentNetworkSubnets,
  ContainerRuntime,
  type RuntimeCommandExecutor,
} from '../src/container-runtime.js';

describe('container runtime adapter', () => {
  it('uses the configured executable but constructs every argument internally', async () => {
    const calls: Array<{ executable: string; arguments_: readonly string[] }> = [];
    const execute: RuntimeCommandExecutor = async (executable, arguments_) => {
      calls.push({ executable, arguments_ });
      return { exitCode: 0, stdout: '{"Server":{"Os":"linux"}}', stderr: '' };
    };
    const runtime = new ContainerRuntime('podman', execute);

    await runtime.probe('example/worker@sha256:abc');
    await runtime.createNetwork('le-agent-internal', true, {
      'local-engineer.agent-id': 'agt_test',
      'local-engineer.managed': 'true',
    });

    expect(calls[0]).toEqual({
      executable: 'podman',
      arguments_: ['version', '--format', '{{json .}}'],
    });
    expect(calls.find((call) => call.arguments_.includes('le-agent-internal'))?.arguments_).toEqual([
      'network',
      'create',
      '--internal',
      '--label',
      'local-engineer.agent-id=agt_test',
      '--label',
      'local-engineer.managed=true',
      'le-agent-internal',
    ]);
  });

  it('rejects unsafe resource names before invoking the runtime', async () => {
    const runtime = new ContainerRuntime('docker', async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));

    expect(() => runtime.removeContainer('--all')).toThrow('CONTAINER_RESOURCE_NAME_INVALID');
  });

  it('prefixes every command with an explicitly configured CLI context', async () => {
    const calls: string[][] = [];
    const runtime = new ContainerRuntime(
      'docker',
      async (_executable, arguments_) => {
        calls.push([...arguments_]);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      'default',
    );

    await runtime.createVolume('le-context-volume', { 'local-engineer.managed': 'true' });
    expect(calls[0]).toEqual([
      '--context',
      'default',
      'volume',
      'create',
      '--label',
      'local-engineer.managed=true',
      'le-context-volume',
    ]);
  });

  it('allocates stable non-overlapping internal and egress subnets from the reserved pool', () => {
    const first = agentNetworkSubnets('agt_example', '10.240.0.0/16');
    expect(first).toEqual(agentNetworkSubnets('agt_example', '10.240.0.0/16'));
    expect(first.internal).toMatch(/^10\.240\.\d+\.0\/24$/);
    expect(first.egress).toMatch(/^10\.240\.\d+\.0\/24$/);
    expect(first.internal).not.toBe(first.egress);
    expect(() => agentNetworkSubnets('agt_example', '192.168.0.0/16')).toThrow('CONTAINER_AGENT_NETWORK_POOL_INVALID');
  });

  it('falls back to the next deterministic network pair when the preferred range overlaps', async () => {
    const calls: string[][] = [];
    const preferred = agentNetworkSubnetCandidates('agt_collision', '10.240.0.0/16')[0]!;
    const fallback = agentNetworkSubnetCandidates('agt_collision', '10.240.0.0/16')[1]!;
    const runtime = new ContainerRuntime('docker', async (_executable, arguments_) => {
      calls.push([...arguments_]);
      const subnet = arguments_[arguments_.indexOf('--subnet') + 1];
      if (arguments_.includes('network') && arguments_.includes('create') && subnet === preferred.egress)
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'invalid pool request: Pool overlaps with other one on this address space',
        };
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await expect(
      runtime.createNetworkPair({
        internalName: 'le-collision-internal',
        egressName: 'le-collision-egress',
        labels: { 'local-engineer.agent-id': 'agt_collision', 'local-engineer.managed': 'true' },
        candidates: [preferred, fallback],
      }),
    ).resolves.toEqual(fallback);
    expect(calls).toContainEqual(['network', 'rm', 'le-collision-internal']);
    expect(calls.filter((call) => call.includes('--subnet') && call.includes(fallback.internal))).toHaveLength(1);
    expect(calls.filter((call) => call.includes('--subnet') && call.includes(fallback.egress))).toHaveLength(1);
  });

  it('treats the Windows HNS object-exists response as a retryable subnet collision', async () => {
    const calls: string[][] = [];
    const preferred = agentNetworkSubnetCandidates('agt_hns_collision', '10.240.0.0/16')[0]!;
    const fallback = agentNetworkSubnetCandidates('agt_hns_collision', '10.240.0.0/16')[1]!;
    const runtime = new ContainerRuntime('docker', async (_executable, arguments_) => {
      calls.push([...arguments_]);
      const subnet = arguments_[arguments_.indexOf('--subnet') + 1];
      if (arguments_.includes('network') && arguments_.includes('create') && subnet === preferred.internal)
        return {
          exitCode: 1,
          stdout: '',
          stderr:
            'Error response from daemon: failed during hnsCallRawResponse: hnsCall failed in Win32: The object already exists. (0x1392)',
        };
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await expect(
      runtime.createNetworkPair({
        internalName: 'le-hns-collision-internal',
        egressName: 'le-hns-collision-egress',
        labels: { 'local-engineer.agent-id': 'agt_hns_collision', 'local-engineer.managed': 'true' },
        candidates: [preferred, fallback],
      }),
    ).resolves.toEqual(fallback);
    expect(calls.filter((call) => call.includes('--subnet') && call.includes(fallback.internal))).toHaveLength(1);
    expect(calls.filter((call) => call.includes('--subnet') && call.includes(fallback.egress))).toHaveLength(1);
  });

  it('creates only a private per-agent Windows network and retries HNS subnet collisions', async () => {
    const calls: string[][] = [];
    const preferred = agentNetworkSubnetCandidates('agt_private', '10.240.0.0/16')[0]!;
    const fallback = agentNetworkSubnetCandidates('agt_private', '10.240.0.0/16')[1]!;
    const runtime = new ContainerRuntime(
      'docker',
      async (_executable, arguments_) => {
        calls.push([...arguments_]);
        if (arguments_.includes(preferred.internal))
          return { exitCode: 1, stdout: '', stderr: 'hnsCallRawResponse: The object already exists. (0x1392)' };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      undefined,
      'windows',
    );
    await expect(
      runtime.createWindowsInternalNetwork('le-private', { 'local-engineer.managed': 'true' }, [preferred, fallback]),
    ).resolves.toBe(fallback.internal);
    expect(calls.filter((call) => call.includes('create'))).toHaveLength(2);
    expect(calls.some((call) => call.includes(preferred.egress) || call.includes(fallback.egress))).toBe(false);
  });

  it('permits only the narrowly scoped setup capability', async () => {
    const calls: string[][] = [];
    const runtime = new ContainerRuntime('docker', async (_executable, arguments_) => {
      calls.push([...arguments_]);
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const input = {
      name: 'le-seed',
      image: 'worker:test',
      network: 'le-internal',
      labels: { 'local-engineer.managed': 'true' },
    };

    await runtime.createContainer({ ...input, capabilities: ['CHOWN'] });
    expect(calls[0]).toContain('--cap-add');
    expect(calls[0]).toContain('CHOWN');
    expect(() => runtime.createContainer({ ...input, capabilities: ['SYS_ADMIN'] })).toThrow(
      'CONTAINER_CAPABILITY_INVALID',
    );
  });

  it('reports an unavailable daemon with a safe actionable summary, without leaking command output', async () => {
    const runtime = new ContainerRuntime('nerdctl', async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'failed to connect to the docker API at npipe:////./pipe/docker_engine; secret-host-detail',
    }));

    await expect(runtime.probe('worker:latest')).resolves.toEqual({
      supported: false,
      executable: 'nerdctl',
      errorCode: 'CONTAINER_RUNTIME_COMMAND_FAILED',
      errorSummary: 'The nerdctl daemon is unavailable. Start the container runtime and retry the agent.',
    });
  });

  it('uses mandatory Hyper-V isolation and no Linux-only flags for Windows containers', async () => {
    const calls: string[][] = [];
    const runtime = new ContainerRuntime(
      'docker',
      async (_executable, arguments_) => {
        calls.push([...arguments_]);
        if (arguments_.includes('version'))
          return { exitCode: 0, stdout: '{"Server":{"Os":"windows","Version":"29.7.2"}}', stderr: '' };
        if (arguments_.includes('{{.HostConfig.Isolation}}')) return { exitCode: 0, stdout: 'hyperv\n', stderr: '' };
        if (arguments_.includes('{{json .HostConfig}}'))
          return { exitCode: 0, stdout: '{"Memory":6442450944,"CpuCount":3}', stderr: '' };
        if (arguments_.includes('{{json .NetworkSettings.Networks}}')) {
          const container = arguments_.at(-1)!;
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              [container.replace(/-container$/, '-internal')]: {
                IPAddress: '10.240.7.3',
                MacAddress: '00:15:5d:00:00:03',
              },
            }),
            stderr: '',
          };
        }
        if (arguments_.some((argument) => argument.endsWith('/configure-worker-network.ps1')))
          return { exitCode: 0, stdout: 'LOCAL_ENGINEER_NETWORK_OK\n', stderr: '' };
        if (arguments_.some((argument) => argument.endsWith('whoami.exe')))
          return { exitCode: 0, stdout: 'BUILTIN\\Users S-1-5-32-545 Enabled group\n', stderr: '' };
        if (arguments_.some((argument) => argument.includes('.local-engineer-write-probe')))
          return { exitCode: 0, stdout: 'LOCAL_ENGINEER_IMAGE_LOCKED', stderr: '' };
        return { exitCode: 0, stdout: '{}', stderr: '' };
      },
      'desktop-windows',
      'windows',
      { memoryLimit: '6g', cpuCount: 3 },
    );

    await expect(runtime.probe('local-engineer/windows:test')).resolves.toMatchObject({ supported: true });
    const create = calls.find(
      (call) => call[0] === '--context' && call.includes('create') && call.includes('--isolation'),
    )!;
    expect(create).toContain('hyperv');
    expect(create).toContain('6g');
    expect(create).toContain('3');
    expect(create).not.toContain('--cap-drop');
    expect(create).not.toContain('--security-opt');
    expect(create).not.toContain('--tmpfs');
    const internalNetwork = calls.find(
      (call) => call.includes('network') && call.some((argument) => argument.endsWith('-internal')),
    )!;
    expect(internalNetwork).toContain('nat');
    expect(internalNetwork).not.toContain('--internal');
    expect(calls.some((call) => call.some((argument) => argument.endsWith('/configure-worker-network.ps1')))).toBe(
      true,
    );
    expect(calls.some((call) => call.includes('network') && call.includes('inspect') && call.includes('nat'))).toBe(
      true,
    );
    expect(calls.some((call) => call.includes('disconnect'))).toBe(false);
    const imageLockProbe = calls.find((call) =>
      call.some((argument) => argument.includes('.local-engineer-write-probe')),
    )!;
    expect(imageLockProbe.join(' ')).toContain('C:/Node');
    expect(imageLockProbe.join(' ')).toContain('C:/Python');
    expect(imageLockProbe.join(' ')).toContain('C:/MinGit');
    expect(imageLockProbe.join(' ')).toContain('C:/BuildTools');
    const start = calls.findIndex((call) => call.includes('start'));
    const configure = calls.findIndex((call) =>
      call.some((argument) => argument.endsWith('/configure-worker-network.ps1')),
    );
    expect(start).toBeGreaterThanOrEqual(0);
    expect(configure).toBeGreaterThan(start);
  });

  it('fails closed when Docker daemon platform does not match configuration', async () => {
    const runtime = new ContainerRuntime(
      'docker',
      async () => ({ exitCode: 0, stdout: '{"Server":{"Os":"linux"}}', stderr: '' }),
      undefined,
      'windows',
    );
    await expect(runtime.probe('worker:windows')).resolves.toMatchObject({
      supported: false,
      errorCode: 'CONTAINER_RUNTIME_PLATFORM_MISMATCH',
      errorSummary:
        'The configured Docker daemon is running the wrong container platform. Switch Docker Desktop to the configured platform and retry.',
    });
  });

  it('rejects process isolation and unverifiable Windows route isolation', async () => {
    const processIsolated = new ContainerRuntime(
      'docker',
      async (_executable, arguments_) => {
        if (arguments_.includes('version')) return { exitCode: 0, stdout: '{"Server":{"Os":"windows"}}', stderr: '' };
        if (arguments_.includes('{{.HostConfig.Isolation}}')) return { exitCode: 0, stdout: 'process\n', stderr: '' };
        return { exitCode: 0, stdout: '{}', stderr: '' };
      },
      undefined,
      'windows',
    );
    await expect(processIsolated.probe('worker:windows')).resolves.toMatchObject({
      supported: false,
      errorCode: 'CONTAINER_WINDOWS_HYPERV_REQUIRED',
    });

    const networkIsolationUnavailable = new ContainerRuntime(
      'docker',
      async (_executable, arguments_) => {
        if (arguments_.includes('version')) return { exitCode: 0, stdout: '{"Server":{"Os":"windows"}}', stderr: '' };
        if (arguments_.includes('{{.HostConfig.Isolation}}')) return { exitCode: 0, stdout: 'hyperv\n', stderr: '' };
        if (arguments_.includes('{{json .HostConfig}}'))
          return { exitCode: 0, stdout: '{"Memory":4294967296,"CpuCount":2}', stderr: '' };
        if (arguments_.includes('{{json .NetworkSettings.Networks}}')) {
          const container = arguments_.at(-1)!;
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              [container.replace(/-container$/, '-internal')]: {
                IPAddress: '10.240.7.3',
                MacAddress: '00:15:5d:00:00:03',
              },
            }),
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: '{}', stderr: '' };
      },
      undefined,
      'windows',
    );
    await expect(networkIsolationUnavailable.probe('worker:windows')).resolves.toMatchObject({
      supported: false,
      errorCode: 'CONTAINER_WINDOWS_NETWORK_ISOLATION_UNAVAILABLE',
    });
  });

  it('validates Windows container copy paths without treating drive colons as resource separators', async () => {
    const calls: string[][] = [];
    const runtime = new ContainerRuntime(
      'docker',
      async (_executable, arguments_) => {
        calls.push([...arguments_]);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      undefined,
      'windows',
    );
    await runtime.copyToContainer('C:/host/config.toml', 'worker', 'C:/local-engineer/config.toml');
    expect(calls[0]).toEqual(['cp', 'C:/host/config.toml', 'worker:C:/local-engineer/config.toml']);
    expect(() => runtime.copyToContainer('C:/host/config.toml', 'worker', '/linux/path')).toThrow(
      'CONTAINER_COPY_PATH_INVALID',
    );
  });

  it('builds the shared worker/proxy image with explicit trusted arguments', async () => {
    const calls: string[][] = [];
    const runtime = new ContainerRuntime('nerdctl', async (_executable, arguments_) => {
      calls.push([...arguments_]);
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await runtime.buildImage({
      dockerfile: 'C:/package/container/worker.Dockerfile',
      context: 'C:/package/container',
      image: 'local-engineer/worker:test',
      baseImage: 'node:24-bookworm-slim',
      codexVersion: '0.144.6',
    });

    expect(calls[0]).toEqual([
      'build',
      '--file',
      'C:/package/container/worker.Dockerfile',
      '--tag',
      'local-engineer/worker:test',
      '--build-arg',
      'BASE_IMAGE=node:24-bookworm-slim',
      '--build-arg',
      'CODEX_VERSION=0.144.6',
      'C:/package/container',
    ]);
  });

  it('lists volumes and containers filtered by ownership labels', async () => {
    const calls: string[][] = [];
    const runtime = new ContainerRuntime('docker', async (_executable, arguments_) => {
      calls.push([...arguments_]);
      if (arguments_[0] === 'volume' && arguments_[1] === 'ls') {
        return { exitCode: 0, stdout: 'le-vol-1\r\nle-vol-2\n', stderr: '' };
      }
      if (arguments_[0] === 'ps' && arguments_[1] === '-a') {
        return { exitCode: 0, stdout: 'le-worker\r\nle-proxy\n', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const volumes = await runtime.listVolumesByLabels({
      'local-engineer.agent-id': 'agt_123',
      'local-engineer.managed': 'true',
    });
    expect(volumes).toEqual(['le-vol-1', 'le-vol-2']);
    expect(calls[0]).toEqual([
      'volume',
      'ls',
      '--filter',
      'label=local-engineer.agent-id=agt_123',
      '--filter',
      'label=local-engineer.managed=true',
      '--format',
      '{{.Name}}',
    ]);

    const containers = await runtime.listContainersByLabels({
      'local-engineer.agent-id': 'agt_123',
      'local-engineer.managed': 'true',
    });
    expect(containers).toEqual(['le-worker', 'le-proxy']);
    expect(calls[1]).toEqual([
      'ps',
      '-a',
      '--filter',
      'label=local-engineer.agent-id=agt_123',
      '--filter',
      'label=local-engineer.managed=true',
      '--format',
      '{{.Names}}',
    ]);
  });

  it('enforces safe workdir and normalizes binary paths for privileged Windows executions', async () => {
    const calls: string[][] = [];
    const runtime = new ContainerRuntime(
      'docker',
      async (_executable, arguments_) => {
        calls.push([...arguments_]);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      undefined,
      'windows',
    );

    // 1. Privileged execution without an explicit workdir enforces C:/Windows/System32
    await runtime.execContainer('test-container', ['git', 'status'], { user: 'ContainerAdministrator' });
    expect(calls[0]).toContain('--workdir');
    expect(calls[0]).toContain('C:/Windows/System32');
    expect(calls[0]).toContain('C:/MinGit/cmd/git.exe');
    expect(calls[0]).not.toContain('git');

    // 2. Privileged execution with the correct workdir succeeds
    await runtime.execContainer('test-container', ['powershell.exe', '-Command', 'echo 1'], {
      user: 'ContainerAdministrator',
      workdir: 'C:\\Windows\\System32',
    });
    expect(calls[1]).toContain('--workdir');
    expect(calls[1]).toContain('C:/Windows/System32');
    expect(calls[1]).toContain('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe');

    // 3. Privileged execution with C:/workspace fails closed
    await expect(
      runtime.execContainer('test-container', ['git', 'status'], {
        user: 'ContainerAdministrator',
        workdir: 'C:/workspace',
      }),
    ).rejects.toThrow('CONTAINER_PRIVILEGED_WORKDIR_UNSAFE: Privileged executions must use C:/Windows/System32');

    // 4. Unprivileged executions: caller-supplied workdir is preserved
    await runtime.execContainer('test-container', ['git', 'status'], {
      user: 'ContainerUser',
      workdir: 'C:/workspace',
    });
    expect(calls[2]).toContain('--workdir');
    expect(calls[2]).toContain('C:/workspace');
    expect(calls[2]).toContain('git');

    // 5. Unprivileged executions: omitted workdir does not inject --workdir
    await runtime.execContainer('test-container', ['git', 'status'], { user: 'ContainerUser' });
    expect(calls[3]).not.toContain('--workdir');
    expect(calls[3]).toContain('git');
  });

  it('enforces safe workdir across all Linux UID 0 user specifications and preserves non-root workdirs', async () => {
    const calls: string[][] = [];
    const runtime = new ContainerRuntime(
      'docker',
      async (_executable, arguments_) => {
        calls.push([...arguments_]);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      undefined,
      'linux',
    );

    const privilegedUsers = ['0', '00', '+0', '-0', '0:0', '0:123', '00:123', '+0:123', '-0:123', 'root', 'root:wheel'];
    for (const user of privilegedUsers) {
      // Privileged execution with unsafe workdir fails closed
      await expect(
        runtime.execContainer('test-container', ['git', 'status'], {
          user,
          workdir: '/workspace',
        }),
      ).rejects.toThrow('CONTAINER_PRIVILEGED_WORKDIR_UNSAFE: Privileged executions must use /');

      // Privileged execution without workdir enforces safe workdir /
      calls.length = 0;
      await runtime.execContainer('test-container', ['git', 'status'], { user });
      expect(calls[0]).toContain('--workdir');
      expect(calls[0]).toContain('/');

      // Privileged execution with explicit safe workdir / succeeds
      calls.length = 0;
      await runtime.execContainer('test-container', ['git', 'status'], { user, workdir: '/' });
      expect(calls[0]).toContain('--workdir');
      expect(calls[0]).toContain('/');
    }

    // Unprivileged non-root users preserve caller-supplied workdir
    const nonRootUsers = ['1000', '1000:1000', 'codex'];
    for (const user of nonRootUsers) {
      calls.length = 0;
      await runtime.execContainer('test-container', ['git', 'status'], {
        user,
        workdir: '/workspace',
      });
      expect(calls[0]).toContain('--workdir');
      expect(calls[0]).toContain('/workspace');

      calls.length = 0;
      await runtime.execContainer('test-container', ['git', 'status'], { user });
      expect(calls[0]).not.toContain('--workdir');
    }
  });

  it('fails closed on pause/unpause command failures and passes arguments correctly', async () => {
    const executed: string[][] = [];
    const runtime = new ContainerRuntime(
      'docker',
      async (_exe, args) => {
        executed.push([...args]);
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
      undefined,
      'windows',
    );

    const pauseResult = await runtime.pauseContainer('test-container');
    expect(pauseResult.exitCode).toBe(0);
    expect(executed).toEqual([['pause', 'test-container']]);

    const unpauseResult = await runtime.unpauseContainer('test-container');
    expect(unpauseResult.exitCode).toBe(0);
    expect(executed).toEqual([
      ['pause', 'test-container'],
      ['unpause', 'test-container'],
    ]);

    // Windows & Linux: failure fails closed (throws)
    for (const platform of ['windows', 'linux'] as const) {
      const failRuntime = new ContainerRuntime(
        'docker',
        async () => ({ exitCode: 1, stdout: '', stderr: 'daemon down or pause unsupported' }),
        undefined,
        platform,
      );
      await expect(failRuntime.pauseContainer('test-container')).rejects.toThrow('CONTAINER_RUNTIME_COMMAND_FAILED');
      await expect(failRuntime.unpauseContainer('test-container')).rejects.toThrow('CONTAINER_RUNTIME_COMMAND_FAILED');
    }

    // Invalid resource name fails closed
    expect(() => runtime.pauseContainer('bad/name')).toThrow('CONTAINER_RESOURCE_NAME_INVALID');
    expect(() => runtime.unpauseContainer('bad/name')).toThrow('CONTAINER_RESOURCE_NAME_INVALID');
  });

  it('checks container running state and validates resource name', async () => {
    const executed: string[][] = [];
    const runtime = new ContainerRuntime(
      'docker',
      async (_exe, args) => {
        executed.push([...args]);
        if (args.at(-1) === 'running-c') return { exitCode: 0, stdout: 'true\n', stderr: '' };
        if (args.at(-1) === 'stopped-c') return { exitCode: 0, stdout: 'false\n', stderr: '' };
        if (args.at(-1) === 'malformed-c') return { exitCode: 0, stdout: 'unknown\n', stderr: '' };
        if (args.at(-1) === 'empty-c') return { exitCode: 0, stdout: '   \n', stderr: '' };
        return { exitCode: 0, stdout: 'false\n', stderr: '' };
      },
      undefined,
      'windows',
    );

    expect(await runtime.isContainerRunning('running-c')).toBe(true);
    expect(await runtime.isContainerRunning('stopped-c')).toBe(false);
    await expect(runtime.isContainerRunning('malformed-c')).rejects.toThrow(
      'CONTAINER_STATE_INVALID:malformed-c:unknown',
    );
    await expect(runtime.isContainerRunning('empty-c')).rejects.toThrow('CONTAINER_STATE_INVALID:empty-c:');
    expect(executed).toEqual([
      ['container', 'inspect', '--format', '{{.State.Running}}', 'running-c'],
      ['container', 'inspect', '--format', '{{.State.Running}}', 'stopped-c'],
      ['container', 'inspect', '--format', '{{.State.Running}}', 'malformed-c'],
      ['container', 'inspect', '--format', '{{.State.Running}}', 'empty-c'],
    ]);
    await expect(runtime.isContainerRunning('bad/name')).rejects.toThrow('CONTAINER_RESOURCE_NAME_INVALID');
  });
});
