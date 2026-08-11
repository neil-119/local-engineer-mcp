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
      return { exitCode: 0, stdout: '{}', stderr: '' };
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
});
