import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { appServerInheritedEnvironmentNames, CodexAppServer } from '../src/codex.js';

const worker = {
  command: 'docker',
  args: ['exec', '--interactive', 'worker', 'codex', 'app-server', '--listen', 'stdio://'],
  model: 'local-model',
  modelProvider: 'local-provider',
};

function writableAdapter() {
  const adapter = new CodexAppServer(worker, () => undefined);
  const writes: string[] = [];
  (adapter as unknown as { process: { stdin: { writable: boolean; write: (value: string) => void } } }).process = {
    stdin: { writable: true, write: (value) => void writes.push(value) },
  };
  return { adapter, writes };
}

describe('container Codex app-server bridge', () => {
  it('inherits the selected Docker endpoint for container-exec app-server processes', () => {
    expect(appServerInheritedEnvironmentNames).toEqual(
      expect.arrayContaining(['DOCKER_CONFIG', 'DOCKER_HOST', 'DOCKER_CONTEXT']),
    );
  });

  it('accepts command requests because the container is the execution boundary', () => {
    const { adapter, writes } = writableAdapter();
    (adapter as unknown as { receive: (message: Record<string, unknown>) => void }).receive({
      jsonrpc: '2.0',
      id: 7,
      method: 'item/commandExecution/requestApproval',
      params: { command: 'pnpm test' },
    });
    expect(JSON.parse(writes[0]!)).toMatchObject({ id: 7, result: { decision: 'accept' } });
  });

  it('returns requested permissions with turn scope', () => {
    const { adapter, writes } = writableAdapter();
    (adapter as unknown as { receive: (message: Record<string, unknown>) => void }).receive({
      jsonrpc: '2.0',
      id: 8,
      method: 'item/permissions/requestApproval',
      params: { permissions: { network: { enabled: true } } },
    });
    expect(JSON.parse(writes[0]!)).toMatchObject({
      id: 8,
      result: {
        permissions: { network: { enabled: true } },
        scope: 'turn',
        strictAutoReview: true,
      },
    });
  });

  it('resolves a turn when Codex sends a completion notification', async () => {
    const adapter = new CodexAppServer(worker, () => undefined);
    let resolve!: (value: Record<string, unknown>) => void;
    const outcome = new Promise<Record<string, unknown>>((done) => {
      resolve = done;
    });
    const internals = adapter as unknown as {
      turnDone: Map<string, Promise<Record<string, unknown>>>;
      turnResolvers: Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>;
      receive: (message: Record<string, unknown>) => void;
    };
    internals.turnDone.set('turn-1', outcome);
    internals.turnResolvers.set('turn-1', { resolve, reject: vi.fn() });
    const waiting = adapter.wait('turn-1');
    internals.receive({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { turn: { id: 'turn-1' } },
    });
    await expect(waiting).resolves.toMatchObject({ turn: { id: 'turn-1' } });
  });

  it('rejects a completed notification whose turn status is failed', async () => {
    const adapter = new CodexAppServer(worker, () => undefined);
    const internals = adapter as unknown as {
      turnDone: Map<string, Promise<Record<string, unknown>>>;
      turnResolvers: Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>;
      receive: (message: Record<string, unknown>) => void;
    };
    let reject!: (error: Error) => void;
    internals.turnDone.set(
      'turn-failed',
      new Promise((_resolve, rejectTurn) => {
        reject = rejectTurn;
      }),
    );
    internals.turnResolvers.set('turn-failed', { resolve: vi.fn(), reject });
    const waiting = adapter.wait('turn-failed');
    internals.receive({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        turn: {
          id: 'turn-failed',
          status: 'failed',
          error: { message: 'model relay error: model upstream timeout' },
        },
      },
    });
    await expect(waiting).rejects.toThrow('CODEX_TURN_FAILED:model relay error: model upstream timeout');
  });

  it('rejects an interrupted turn when a preceding relay error identifies the cause', async () => {
    const adapter = new CodexAppServer(worker, () => undefined);
    const internals = adapter as unknown as {
      turnDone: Map<string, Promise<Record<string, unknown>>>;
      turnResolvers: Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>;
      receive: (message: Record<string, unknown>) => void;
    };
    let reject!: (error: Error) => void;
    internals.turnDone.set(
      'turn-interrupted',
      new Promise((_resolve, rejectTurn) => {
        reject = rejectTurn;
      }),
    );
    internals.turnResolvers.set('turn-interrupted', { resolve: vi.fn(), reject });
    const waiting = adapter.wait('turn-interrupted');
    internals.receive({
      jsonrpc: '2.0',
      method: 'error',
      params: {
        turnId: 'turn-interrupted',
        error: { additionalDetails: 'model relay error: connect EHOSTUNREACH model-host:8888' },
      },
    });
    internals.receive({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { turn: { id: 'turn-interrupted', status: 'interrupted' } },
    });
    await expect(waiting).rejects.toThrow('CODEX_TURN_FAILED:model relay error: connect EHOSTUNREACH model-host:8888');
  });

  it('times out pending JSON-RPC request when app-server does not respond within timeout', async () => {
    const { adapter } = writableAdapter();
    const request = (
      adapter as unknown as {
        request: (
          method: string,
          params: Record<string, unknown>,
          timeoutMs?: number,
        ) => Promise<Record<string, unknown>>;
      }
    ).request('thread/start', { cwd: '/workspace' }, 50);

    await expect(request).rejects.toThrow('CODEX_RPC_TIMEOUT:thread/start');
  });

  it('rejects pending requests and active turns when stop is called', async () => {
    const { adapter } = writableAdapter();
    const request = (
      adapter as unknown as {
        request: (
          method: string,
          params: Record<string, unknown>,
          timeoutMs?: number,
        ) => Promise<Record<string, unknown>>;
      }
    ).request('turn/start', { threadId: 'thread-1' }, 10_000);

    let rejectTurn!: (error: Error) => void;
    const turnOutcome = new Promise<Record<string, unknown>>((_resolve, reject) => {
      rejectTurn = reject;
    });
    const internals = adapter as unknown as {
      turnDone: Map<string, Promise<Record<string, unknown>>>;
      turnResolvers: Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>;
    };
    internals.turnDone.set('turn-stop-test', turnOutcome);
    internals.turnResolvers.set('turn-stop-test', { resolve: vi.fn(), reject: rejectTurn });
    const waitingTurn = adapter.wait('turn-stop-test');

    await adapter.stop();

    await expect(request).rejects.toThrow('CODEX_APP_SERVER_STOPPED');
    await expect(waitingTurn).rejects.toThrow('CODEX_APP_SERVER_STOPPED');
  });

  it('rejects pending requests and active turns on process error event', async () => {
    const adapter = new CodexAppServer(worker, () => undefined);
    const mockProcess = new EventEmitter() as EventEmitter & {
      stdin: EventEmitter & { writable: boolean; write: (value: string) => void };
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    mockProcess.stdin = Object.assign(new EventEmitter(), {
      writable: true,
      write: () => undefined,
    });
    mockProcess.stdout = new EventEmitter();
    mockProcess.stderr = new EventEmitter();

    adapter.setupProcess(mockProcess as unknown as ChildProcess);

    const request = (
      adapter as unknown as {
        request: (
          method: string,
          params: Record<string, unknown>,
          timeoutMs?: number,
        ) => Promise<Record<string, unknown>>;
      }
    ).request('initialize', {}, 10_000);

    let rejectTurn!: (error: Error) => void;
    const turnOutcome = new Promise<Record<string, unknown>>((_resolve, reject) => {
      rejectTurn = reject;
    });
    const internals = adapter as unknown as {
      turnDone: Map<string, Promise<Record<string, unknown>>>;
      turnResolvers: Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>;
    };
    internals.turnDone.set('turn-err-test', turnOutcome);
    internals.turnResolvers.set('turn-err-test', { resolve: vi.fn(), reject: rejectTurn });
    const waitingTurn = adapter.wait('turn-err-test');

    mockProcess.emit('error', new Error('spawn EACCES'));

    await expect(request).rejects.toThrow('CODEX_APP_SERVER_ERROR:spawn EACCES');
    await expect(waitingTurn).rejects.toThrow('CODEX_APP_SERVER_ERROR:spawn EACCES');
  });
});
