import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
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

export class CodexAppServer {
  private process?: ChildProcessWithoutNullStreams;
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

  constructor(
    private readonly worker: ContainerAppServerWorker,
    private readonly onEvent: (event: Rpc) => void,
  ) {}

  async start(): Promise<void> {
    if (this.process && !this.process.killed && this.process.exitCode === null && this.process.signalCode === null)
      return;
    const environment: NodeJS.ProcessEnv = {};
    for (const name of [
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
    ])
      if (process.env[name]) environment[name] = process.env[name];
    Object.assign(environment, this.worker.environment);
    this.process = spawn(this.worker.command, this.worker.args, {
      env: environment,
      stdio: 'pipe',
      windowsHide: true,
    });
    this.process.stderr.on('data', (data) =>
      this.onEvent({ jsonrpc: '2.0', method: 'stderr', params: { text: String(data) } }),
    );
    this.process.on('exit', (code) => {
      const error = new Error(`CODEX_APP_SERVER_EXIT:${code ?? 'unknown'}`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.failActiveTurns(error);
      this.process = undefined;
    });
    this.process.on('error', (cause) => this.failActiveTurns(new Error(`CODEX_APP_SERVER_ERROR:${cause.message}`)));
    let buffer = '';
    this.process.stdout.on('data', (chunk: Buffer) => {
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
    await this.request('initialize', {
      clientInfo: { name: 'local-engineer-mcp', version: '0.1.0' },
      capabilities: {},
    });
    this.notify('initialized', {});
  }

  private receive(message: Rpc): void {
    if (message.method) {
      this.onEvent(message);
      this.captureAgentMessage(message);
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
    if (turnId && /turn\/(completed|failed)|turn\/complete/i.test(message.method ?? ''))
      this.turnResolvers.get(turnId)?.resolve({
        ...(message.params ?? {}),
        final_message: this.turnMessages.get(turnId) ?? '',
      });
  }

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
    if (!this.process?.stdin.writable) throw new Error('CODEX_APP_SERVER_UNAVAILABLE');
    this.process.stdin.write(JSON.stringify(value) + '\n');
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    this.write({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

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

  wait(turnId: string): Promise<Record<string, unknown>> {
    const outcome = this.turnDone.get(turnId);
    if (!outcome) return Promise.reject(new Error('CODEX_TURN_UNKNOWN'));
    return outcome.finally(() => {
      this.turnDone.delete(turnId);
      this.turnResolvers.delete(turnId);
      this.turnMessages.delete(turnId);
    });
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.request('turn/interrupt', { threadId, turnId });
  }

  private captureAgentMessage(message: Rpc): void {
    if (message.method !== 'item/agentMessage/delta') return;
    const turnId = stringAt(message.params, ['turnId']);
    const delta = stringAt(message.params, ['delta']);
    if (!turnId || !delta) return;
    const current = this.turnMessages.get(turnId) ?? '';
    this.turnMessages.set(turnId, (current + delta).slice(-64_000));
  }

  private failActiveTurns(error: Error): void {
    for (const pending of this.turnResolvers.values()) pending.reject(error);
    this.turnResolvers.clear();
    this.turnDone.clear();
    this.turnMessages.clear();
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
