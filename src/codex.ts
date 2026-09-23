/**
 * Codex App Server JSON-RPC 2.0 Client
 *
 * Manages the lifecycle of and communication with the Codex CLI running in `app-server` mode:
 * - Spawns and supervises the child process (or `docker exec` wrapper) with stdio JSON-RPC piping.
 * - Manages session threads (`thread/start`) and turn executions (`turn/start`, `turn/interrupt`).
 * - Automatically grants container execution permissions (`item/permissions/requestApproval`).
 * - Buffers assistant messages and diagnostic events for live progress tracking.
 * - Safely terminates processes (`stop()`) to release handles and prevent event loop hanging.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export type Rpc = {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
};

export interface ContainerAppServerWorker {
  command: string;
  args: string[];
  model: string;
  modelProvider?: string;
  environment?: Record<string, string>;
}

export interface StartedSession {
  threadId: string;
  turnId: string;
}

export const appServerInheritedEnvironmentNames = [
  'PATH',
  'SystemRoot',
  'ComSpec',
  'APPDATA',
  'LOCALAPPDATA',
  'HOME',
  'USERPROFILE',
  'TEMP',
  'TMP',
  'DOCKER_CONFIG',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
] as const;

/**
 * Manages a stateful connection to the Codex app server running inside the container.
 */
export class CodexAppServer {
  private process?: ChildProcess;
  private nextId = 1;
  private pending = new Map<
    number | string,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  private readonly turnDone = new Map<string, Promise<Record<string, unknown>>>();
  private readonly turnResolvers = new Map<
    string,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  private readonly turnMessages = new Map<string, string>();
  /** Last upstream error reported for a turn before Codex marks it interrupted. */
  private readonly turnErrors = new Map<string, string>();

  constructor(
    private readonly worker: ContainerAppServerWorker,
    private readonly onEvent: (event: Rpc) => void,
  ) {}

  async start(): Promise<void> {
    if (this.process && !this.process.killed && this.process.exitCode === null && this.process.signalCode === null)
      return;
    const environment: NodeJS.ProcessEnv = {};
    for (const name of appServerInheritedEnvironmentNames) if (process.env[name]) environment[name] = process.env[name];
    Object.assign(environment, this.worker.environment);
    const child = spawn(this.worker.command, this.worker.args, {
      env: environment,
      stdio: 'pipe',
      windowsHide: true,
    });
    this.setupProcess(child);
    await this.request('initialize', {
      clientInfo: { name: 'local-engineer-mcp', version: '0.1.0' },
      capabilities: {},
    });
    this.notify('initialized', {});
  }

  setupProcess(child: ChildProcess): void {
    this.process = child;
    child.stdin?.on('error', () => undefined);
    child.stderr?.on('data', (data: Buffer | string) =>
      this.onEvent({ jsonrpc: '2.0', method: 'stderr', params: { text: String(data) } }),
    );
    child.on('exit', (code: number | null) => {
      const error = new Error(`CODEX_APP_SERVER_EXIT:${code ?? 'unknown'}`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.failActiveTurns(error);
      this.process = undefined;
    });
    child.on('error', (cause: Error) => {
      const error = new Error(`CODEX_APP_SERVER_ERROR:${cause.message}`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.failActiveTurns(error);
      this.process = undefined;
    });
    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          this.receive(JSON.parse(line) as Rpc);
        } catch {
          this.onEvent({ jsonrpc: '2.0', method: 'malformed', params: { line } });
        }
      }
    });
  }

  private receive(message: Rpc): void {
    if (message.method) {
      this.onEvent(message);
      this.captureAgentMessage(message);
      this.captureTurnError(message);
      if (message.id !== undefined) {
        if (message.method.includes('requestApproval')) this.approveContainerRequest(message);
        return;
      }
    }
    if (message.id !== undefined) {
      const request = this.pending.get(message.id);
      if (request) {
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(`CODEX_RPC_ERROR:${message.error.message ?? 'unknown'}`));
        else request.resolve(message.result ?? {});
      }
      return;
    }
    const turnId =
      stringAt(message.params, ['turn', 'id']) ??
      stringAt(message.params, ['turn_id']) ??
      stringAt(message.params, ['turnId']);
    if (turnId && /turn\/(completed|failed)|turn\/complete/i.test(message.method ?? '')) {
      const turn = recordAt(message.params, ['turn']);
      const status = stringAt(turn, ['status']);
      const resolver = this.turnResolvers.get(turnId);
      const priorError = this.turnErrors.get(turnId);
      if (status === 'failed' || (status === 'interrupted' && priorError)) {
        resolver?.reject(new Error(`CODEX_TURN_FAILED:${priorError ?? turnFailureDetail(turn)}`));
        return;
      }
      resolver?.resolve({
        ...(message.params ?? {}),
        final_message: this.turnMessages.get(turnId) ?? '',
      });
    }
  }

  /**
   * Automatically approves permission and execution requests inside the worker container.
   * Container boundary isolation (Hyper-V VM / dropped capabilities) replaces interactive user prompts.
   */
  private approveContainerRequest(message: Rpc): void {
    if (message.method === 'item/permissions/requestApproval') {
      this.write({
        jsonrpc: '2.0',
        id: message.id!,
        result: {
          permissions: recordAt(message.params, ['permissions']) ?? {},
          scope: 'turn',
          strictAutoReview: true,
        },
      });
      return;
    }
    this.write({ jsonrpc: '2.0', id: message.id!, result: { decision: 'accept' } });
  }

  private write(value: Rpc): void {
    const stdin = this.process?.stdin;
    if (!stdin?.writable) throw new Error('CODEX_APP_SERVER_UNAVAILABLE');
    stdin.write(JSON.stringify(value) + '\n');
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 45_000,
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    this.write({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined = setTimeout(() => {
        timer = undefined;
        this.pending.delete(id);
        reject(new Error(`CODEX_RPC_TIMEOUT:${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /**
   * Initializes a new thread session and begins the first turn.
   */
  async createAndStart(cwd: string, prompt: string): Promise<StartedSession> {
    await this.start();
    const thread = await this.request('thread/start', {
      cwd,
      model: this.worker.model,
      modelProvider: this.worker.modelProvider,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'danger-full-access',
      ephemeral: false,
    });
    const threadId = stringAt(thread, ['thread', 'id']) ?? stringAt(thread, ['id']);
    if (!threadId) throw new Error('CODEX_THREAD_ID_MISSING');
    return { threadId, turnId: await this.startTurn(threadId, cwd, prompt) };
  }

  /**
   * Appends a continuation turn to an existing thread session.
   */
  async continue(threadId: string, cwd: string, prompt: string): Promise<string> {
    await this.start();
    return this.startTurn(threadId, cwd, prompt);
  }

  private async startTurn(threadId: string, cwd: string, prompt: string): Promise<string> {
    const turn = await this.request('turn/start', {
      threadId,
      cwd,
      input: [{ type: 'text', text: prompt }],
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
    const turnId = stringAt(turn, ['turn', 'id']) ?? stringAt(turn, ['id']) ?? randomUUID();
    let resolve!: (value: Record<string, unknown>) => void;
    let reject!: (error: Error) => void;
    this.turnDone.set(
      turnId,
      new Promise((resolveTurn, rejectTurn) => {
        resolve = resolveTurn;
        reject = rejectTurn;
      }),
    );
    this.turnResolvers.set(turnId, { resolve, reject });
    return turnId;
  }

  /**
   * Returns a promise that resolves when the specified turn completes or fails.
   */
  wait(turnId: string): Promise<Record<string, unknown>> {
    const outcome = this.turnDone.get(turnId);
    if (!outcome) return Promise.reject(new Error('CODEX_TURN_UNKNOWN'));
    return outcome.finally(() => {
      this.turnDone.delete(turnId);
      this.turnResolvers.delete(turnId);
      this.turnMessages.delete(turnId);
      this.turnErrors.delete(turnId);
    });
  }

  /**
   * Signals the Codex server to cancel the active turn.
   */
  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.request('turn/interrupt', { threadId, turnId });
  }

  /**
   * Shuts down the process, closes stdio streams, and terminates child processes.
   */
  async stop(): Promise<void> {
    const proc = this.process;
    this.process = undefined;
    const error = new Error('CODEX_APP_SERVER_STOPPED');
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.failActiveTurns(error);
    if (!proc) return;
    try {
      proc.stdin?.end();
    } catch {
      // ignore
    }
    if (!proc.killed && proc.exitCode === null && proc.signalCode === null) {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }
  }

  private captureAgentMessage(message: Rpc): void {
    if (message.method !== 'item/agentMessage/delta') return;
    const turnId = stringAt(message.params, ['turnId']);
    const delta = stringAt(message.params, ['delta']);
    if (!turnId || !delta) return;
    const current = this.turnMessages.get(turnId) ?? '';
    this.turnMessages.set(turnId, (current + delta).slice(-64_000));
  }

  private captureTurnError(message: Rpc): void {
    if (message.method !== 'error') return;
    const turnId = stringAt(message.params, ['turnId']) ?? stringAt(message.params, ['turn_id']);
    const error = recordAt(message.params, ['error']);
    const detail =
      stringAt(error, ['additionalDetails']) ??
      stringAt(error, ['message']) ??
      stringAt(message.params, ['additionalDetails']);
    if (turnId && detail) this.turnErrors.set(turnId, boundedErrorDetail(detail));
  }

  private failActiveTurns(error: Error): void {
    for (const pending of this.turnResolvers.values()) pending.reject(error);
    this.turnResolvers.clear();
    this.turnDone.clear();
    this.turnMessages.clear();
    this.turnErrors.clear();
  }
}

function stringAt(value: unknown, path: string[]): string | undefined {
  let cursor: unknown = value;
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === 'string' ? cursor : undefined;
}

function recordAt(value: unknown, path: string[]): Record<string, unknown> | undefined {
  let cursor: unknown = value;
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor && typeof cursor === 'object' && !Array.isArray(cursor)
    ? (cursor as Record<string, unknown>)
    : undefined;
}

function turnFailureDetail(turn: Record<string, unknown> | undefined): string {
  const detail = stringAt(turn, ['error', 'message']) ?? 'Codex turn failed without an error message.';
  return detail
    .replace(/[\r\n]/g, ' ')
    .replaceAll('\0', ' ')
    .slice(0, 1000);
}

function boundedErrorDetail(value: string): string {
  return value
    .replace(/[\r\n]/g, ' ')
    .replaceAll('\0', ' ')
    .slice(0, 1000);
}
