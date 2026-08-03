import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Run, RunStatus } from './domain.js';
import type { RunStore } from './store.js';

export const DEFAULT_PORT = 8899;
export const MAX_RUNS = 200;
export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 100;
const RUN_HANDLE = /^run_[A-Za-z0-9_-]+$/;

export interface MonitorOptions {
  port: number;
  open: boolean;
  help: boolean;
}

export function parseMonitorArgs(args: string[]): MonitorOptions {
  let port = DEFAULT_PORT;
  let open = true;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--no-open') {
      open = false;
      continue;
    }
    if (argument === '--port') {
      const value = args[index + 1];
      if (value === undefined) throw new Error('CLI_MONITOR_PORT_REQUIRED');
      port = parsePort(value);
      index += 1;
      continue;
    }
    if (argument.startsWith('--port=')) {
      port = parsePort(argument.slice('--port='.length));
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }
    throw new Error(`CLI_MONITOR_UNKNOWN_OPTION:${argument}`);
  }
  return { port, open, help };
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error('CLI_MONITOR_PORT_INVALID');
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error('CLI_MONITOR_PORT_INVALID');
  return parsed;
}

export function monitorUsage(): string {
  return [
    'Usage: local-engineer monitor [options]',
    '',
    'Start a read-only localhost web interface for observing Local Engineer agent runs.',
    '',
    'Options:',
    '  --port <1-65535>   Port to bind on 127.0.0.1 (default 8899)',
    '  --no-open          Do not open the default browser',
    '  -h, --help         Show this help',
    '',
  ].join('\n');
}

export interface ProjectedChangeSet {
  revision: number;
  repositories: Array<{
    repository: string;
    changed_paths: number;
    additions: number;
    deletions: number;
    delta_changed_paths: number;
    delta_additions: number;
    delta_deletions: number;
  }>;
}

export interface ProjectedRun {
  run_id: string;
  agent_id: string;
  status: RunStatus;
  lifecycle: 'active' | 'terminal' | 'review';
  title: string;
  worker: string;
  continuation_index: number;
  continuation_of_run_id?: string;
  image_profile?: string;
  error_code?: string;
  requires_user_action: boolean;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  diagnostics?: {
    last_phase: string;
    last_activity_at: string;
    command_started_at?: string;
    command_completed_at?: string;
    commands_started_count?: number;
    commands_completed_count?: number;
    commands_active_count?: number;
    last_command_status?: string;
    exit_reason?: string;
  };
  result?: {
    report_status: string;
    summary: string;
    verification: Array<{ name: string; status: string }>;
    unresolved_risks: string[];
    requires_user_action: boolean;
    identity_verified: boolean;
  };
  change_set?: ProjectedChangeSet;
  delegation_impact?: {
    local_worker_tokens?: {
      total: number;
      input: number;
      cached_input: number;
      output: number;
      reasoning_output: number;
    };
    parent_to_worker?: {
      characters: number;
      estimated_tokens: number;
      task_assignments: number;
      follow_up_messages: number;
    };
    parent_visible_review_tokens_estimate: number;
  };
}

export interface MonitorSnapshot {
  schema_version: 1;
  generated_at: string;
  count: number;
  runs: ProjectedRun[];
}

export interface MonitorPageSnapshot {
  schema_version: 1;
  generated_at: string;
  count: number;
  runs: ProjectedRun[];
  has_more: boolean;
  next_cursor?: string;
}
export interface MonitorMessage {
  ts: string;
  text: string;
  truncated?: true;
}
export interface MonitorMessagesPage {
  run_id: string;
  has_more: boolean;
  next_cursor?: string;
  messages: MonitorMessage[];
}

const MAX_SUMMARY = 2000;
const MAX_RISKS = 40;
const MAX_VERIFICATION = 60;

export function lifecycleOf(status: RunStatus): 'active' | 'terminal' | 'review' {
  if (status === 'ready_for_review') return 'review';
  if (
    status === 'failed' ||
    status === 'timed_out' ||
    status === 'cancelled' ||
    status === 'promoted' ||
    status === 'rejected' ||
    status === 'superseded'
  ) {
    return 'terminal';
  }
  return 'active';
}

export function projectRuns(runs: Run[], limit = MAX_RUNS): MonitorSnapshot {
  const bounded = runs.slice(0, Math.max(0, Math.min(limit, MAX_RUNS)));
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    count: bounded.length,
    runs: bounded.map(projectRun),
  };
}

export function projectRun(run: Run): ProjectedRun {
  const projected: ProjectedRun = {
    run_id: run.runId,
    agent_id: run.agentId,
    status: run.status,
    lifecycle: lifecycleOf(run.status),
    title: run.title,
    worker: run.worker,
    continuation_index: run.continuationIndex,
    ...(run.continuationOfRunId ? { continuation_of_run_id: run.continuationOfRunId } : {}),
    ...(run.imageProfile ? { image_profile: run.imageProfile } : {}),
    ...(run.errorCode ? { error_code: run.errorCode } : {}),
    requires_user_action: run.requiresUserAction,
    created_at: run.createdAt,
    ...(run.startedAt ? { started_at: run.startedAt } : {}),
    ...(run.completedAt ? { completed_at: run.completedAt } : {}),
  };
  const diagnostics = projectDiagnostics(run);
  if (diagnostics) projected.diagnostics = diagnostics;
  const result = projectResult(run);
  if (result) projected.result = result;
  const changeSet = projectChangeSet(run);
  if (changeSet) projected.change_set = changeSet;
  const delegation = projectDelegation(run);
  if (delegation) projected.delegation_impact = delegation;
  return projected;
}

function projectDiagnostics(run: Run): ProjectedRun['diagnostics'] | undefined {
  const diagnostics = run.diagnostics;
  if (!diagnostics) return undefined;
  return {
    last_phase: diagnostics.last_phase,
    last_activity_at: diagnostics.last_activity_at,
    ...(diagnostics.command_started_at ? { command_started_at: diagnostics.command_started_at } : {}),
    ...(diagnostics.command_completed_at ? { command_completed_at: diagnostics.command_completed_at } : {}),
    ...(diagnostics.commands_started_count !== undefined
      ? { commands_started_count: diagnostics.commands_started_count }
      : {}),
    ...(diagnostics.commands_completed_count !== undefined
      ? { commands_completed_count: diagnostics.commands_completed_count }
      : {}),
    ...(diagnostics.commands_active_count !== undefined
      ? { commands_active_count: diagnostics.commands_active_count }
      : {}),
    ...(diagnostics.last_command_status ? { last_command_status: diagnostics.last_command_status } : {}),
    ...(diagnostics.exit_reason ? { exit_reason: diagnostics.exit_reason } : {}),
  };
}

function projectResult(run: Run): ProjectedRun['result'] | undefined {
  const result = run.result;
  if (!result) return undefined;
  return {
    report_status: result.reportStatus,
    summary: result.summary.slice(0, MAX_SUMMARY),
    verification: (result.verification ?? []).slice(0, MAX_VERIFICATION).map(({ name, status }) => ({
      name: name.slice(0, 500),
      status,
    })),
    unresolved_risks: (result.unresolvedRisks ?? []).slice(0, MAX_RISKS).map((risk) => risk.slice(0, 1000)),
    requires_user_action: result.requiresUserAction,
    identity_verified: result.identityVerified,
  };
}

function projectChangeSet(run: Run): ProjectedChangeSet | undefined {
  const changeSet = run.changeSet;
  if (!changeSet) return undefined;
  return {
    revision: changeSet.revision,
    repositories: (Array.isArray(changeSet.repositories) ? changeSet.repositories : []).map((repository) => ({
      repository: repository.repository,
      changed_paths: Array.isArray(repository.changed_paths) ? repository.changed_paths.length : 0,
      additions: finiteNumber(repository.additions),
      deletions: finiteNumber(repository.deletions),
      delta_changed_paths: Array.isArray(repository.delta_changed_paths) ? repository.delta_changed_paths.length : 0,
      delta_additions: finiteNumber(repository.delta_additions),
      delta_deletions: finiteNumber(repository.delta_deletions),
    })),
  };
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function projectDelegation(run: Run): ProjectedRun['delegation_impact'] | undefined {
  const stats = run.stats;
  if (!stats?.worker_tokens && !stats?.parent_to_worker && !stats?.parent_visible) return undefined;
  return {
    ...(stats.worker_tokens
      ? {
          local_worker_tokens: {
            total: stats.worker_tokens.total,
            input: stats.worker_tokens.input,
            cached_input: stats.worker_tokens.cached_input,
            output: stats.worker_tokens.output,
            reasoning_output: stats.worker_tokens.reasoning_output,
          },
        }
      : {}),
    ...(stats.parent_to_worker
      ? {
          parent_to_worker: {
            characters: stats.parent_to_worker.characters,
            estimated_tokens: stats.parent_to_worker.estimated_tokens,
            task_assignments: stats.parent_to_worker.task_assignments,
            follow_up_messages: stats.parent_to_worker.follow_up_messages,
          },
        }
      : {}),
    parent_visible_review_tokens_estimate: stats.parent_visible?.estimated_tokens ?? 0,
  };
}

let cachedHtml: string | undefined;
function monitorHtmlPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'monitor.html');
}
export function monitorHtml(): string {
  if (cachedHtml === undefined) cachedHtml = readFileSync(monitorHtmlPath(), 'utf8');
  return cachedHtml;
}

const BASE_SECURITY_HEADERS: OutgoingHttpHeaders = {
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function responseHeaders(contentType: string, length: number, extras: OutgoingHttpHeaders = {}): OutgoingHttpHeaders {
  return {
    ...BASE_SECURITY_HEADERS,
    'Content-Type': contentType,
    'Content-Length': length,
    ...extras,
  };
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown, head = false): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, responseHeaders('application/json; charset=utf-8', Buffer.byteLength(payload)));
  response.end(head ? undefined : payload);
}

function sendHtml(response: ServerResponse, html: string, head = false): void {
  response.writeHead(
    200,
    responseHeaders('text/html; charset=utf-8', Buffer.byteLength(html), {
      'Content-Security-Policy':
        "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
    }),
  );
  response.end(head ? undefined : html);
}

function sendText(response: ServerResponse, statusCode: number, body: string, head = false): void {
  response.writeHead(statusCode, responseHeaders('text/plain; charset=utf-8', Buffer.byteLength(body)));
  response.end(head ? undefined : body);
}

export interface MonitorServer {
  server: Server;
  url: string;
}

export function createMonitorServer(
  store: RunStore,
  options: MonitorOptions = { port: DEFAULT_PORT, open: false, help: false },
): MonitorServer {
  const server = createServer((request, response) => {
    try {
      handleRequest(store, request, response);
    } catch {
      if (!response.headersSent) {
        sendText(response, 500, 'Internal Server Error\n', (request.method ?? 'GET').toUpperCase() === 'HEAD');
      } else {
        response.end();
      }
    }
  });
  const url = `http://127.0.0.1:${options.port}/`;
  return { server, url };
}

export function handleRequest(store: RunStore, request: IncomingMessage, response: ServerResponse): void {
  const method = (request.method ?? 'GET').toUpperCase();
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (method !== 'GET' && method !== 'HEAD') {
    response.writeHead(
      405,
      responseHeaders('text/plain; charset=utf-8', Buffer.byteLength('Method Not Allowed\n'), {
        Allow: 'GET, HEAD',
      }),
    );
    response.end('Method Not Allowed\n');
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = monitorHtml();
    sendHtml(response, html, method === 'HEAD');
    return;
  }
  if (url.pathname === '/api/runs') {
    const limit = parsePageLimit(url.searchParams.get('limit'));
    if (limit === undefined) {
      sendText(response, 400, 'Bad Request\n', method === 'HEAD');
      return;
    }
    const cursorResult = parseRunCursor(url.searchParams.get('cursor'));
    if (cursorResult.status === 'invalid') {
      sendText(response, 400, 'Bad Request\n', method === 'HEAD');
      return;
    }
    const page = store.listRunsPage(limit, cursorResult.status === 'ok' ? cursorResult.cursor : undefined);
    const snapshot: MonitorPageSnapshot = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      count: page.runs.length,
      runs: page.runs.map(projectRun),
      has_more: page.hasMore,
      ...(page.nextCursor
        ? { next_cursor: encodeCursor({ created_at: page.nextCursor.createdAt, run_id: page.nextCursor.runId }) }
        : {}),
    };
    sendJson(response, 200, snapshot, method === 'HEAD');
    return;
  }
  const messagesMatch = /^\/api\/runs\/([^/]+)\/messages$/.exec(url.pathname);
  if (messagesMatch) {
    const runHandle = messagesMatch[1]!;
    if (!RUN_HANDLE.test(runHandle) || !store.hasRun(runHandle)) {
      sendText(response, 404, 'Not Found\n', method === 'HEAD');
      return;
    }
    const limit = parsePageLimit(url.searchParams.get('limit'));
    if (limit === undefined) {
      sendText(response, 400, 'Bad Request\n', method === 'HEAD');
      return;
    }
    const cursorResult = parseMessageCursor(url.searchParams.get('cursor'));
    if (cursorResult.status === 'invalid') {
      sendText(response, 400, 'Bad Request\n', method === 'HEAD');
      return;
    }
    const page = store.listMessagesPage(
      runHandle,
      limit,
      cursorResult.status === 'ok' ? cursorResult.cursor : undefined,
    );
    const body: MonitorMessagesPage = {
      run_id: runHandle,
      has_more: page.hasMore,
      ...(page.nextCursor ? { next_cursor: encodeCursor({ seq: page.nextCursor.seq }) } : {}),
      messages: page.messages.map((message) => ({
        ts: message.ts,
        text: message.text,
        ...(message.truncated ? { truncated: true as const } : {}),
      })),
    };
    sendJson(response, 200, body, method === 'HEAD');
    return;
  }
  sendText(response, 404, 'Not Found\n', method === 'HEAD');
}

function parsePageLimit(value: string | null): number | undefined {
  if (value === null) return DEFAULT_PAGE_LIMIT;
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return undefined;
  return Math.min(parsed, MAX_PAGE_LIMIT);
}

function encodeCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeCursor(value: string): Record<string, unknown> | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

type RunCursorParse =
  { status: 'none' } | { status: 'ok'; cursor: { createdAt: string; runId: string } } | { status: 'invalid' };

function parseRunCursor(value: string | null): RunCursorParse {
  if (value === null) return { status: 'none' };
  const decoded = decodeCursor(value);
  if (!decoded) return { status: 'invalid' };
  const createdAt = decoded.created_at;
  const runId = decoded.run_id;
  if (typeof createdAt !== 'string' || typeof runId !== 'string' || !RUN_HANDLE.test(runId)) {
    return { status: 'invalid' };
  }
  return { status: 'ok', cursor: { createdAt, runId } };
}

type MessageCursorParse = { status: 'none' } | { status: 'ok'; cursor: { seq: number } } | { status: 'invalid' };

function parseMessageCursor(value: string | null): MessageCursorParse {
  if (value === null) return { status: 'none' };
  const decoded = decodeCursor(value);
  if (!decoded) return { status: 'invalid' };
  const seq = decoded.seq;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) return { status: 'invalid' };
  return { status: 'ok', cursor: { seq } };
}

export function launchCommand(url: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'darwin') return ['open', url];
  if (platform === 'win32') return ['cmd', '/c', 'start', '', url];
  return ['xdg-open', url];
}

export function monitorStartupMessage(url: string): string {
  return `Local Engineer monitor: ${url}`;
}

type BrowserSpawner = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export function openBrowser(
  url: string,
  spawnImpl: BrowserSpawner = spawn,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;
  const [command, ...args] = launchCommand(url, platform);
  if (command === undefined) return;
  try {
    const child = spawnImpl(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', () => undefined);
    child.unref();
  } catch {
    // Browser launch is best-effort; a headless server must still run.
  }
}
