import { DatabaseSync } from 'node:sqlite';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import type { AgentOperation, Result, Run, RunDiagnostics, RunStats, RunStatus, SteeringMessage } from './domain.js';
import { terminalStatuses } from './domain.js';

export const MAX_MESSAGE_TEXT = 8000;
export const MAX_MESSAGES_PER_RUN = 1000;

function acceptsSteering(status: RunStatus): boolean {
  return status === 'queued' || status === 'starting' || status === 'running';
}

/** Close guidance under the same write lock as settlement; never replay ambiguous RPCs. */
function closeSteering(run: Run, reason: string): Partial<Run> {
  const unresolved = (message: SteeringMessage) => message.status === 'pending' || message.status === 'dispatching';
  if (!run.pendingSteer && !run.steeringQueue?.some(unresolved) && !run.steeringMessages?.some(unresolved)) return {};
  const close = (message: SteeringMessage): SteeringMessage => {
    if (!unresolved(message)) return message;
    const inFlight = message.status === 'dispatching';
    return {
      ...message,
      status: inFlight ? 'uncertain' : 'failed',
      error: `${reason}_${inFlight ? 'orphan_dispatch' : 'before_dispatch'}`,
      dispatchingAt: undefined,
    };
  };
  return {
    steeringQueue: run.steeringQueue?.map(close),
    steeringMessages: run.steeringMessages?.map(close),
    pendingSteer: undefined,
    steeringVersion: (run.steeringVersion ?? 0) + 1,
  };
}

export interface RunTimelineAnalysis {
  commandsCount: number;
  failedCommandsCount: number;
  timelineItemsAnalyzed: number;
  historyTruncated: boolean;
  sampleCommands: Array<{ command: string; status: string }>;
  keyBlockers: string[];
}

export function truncateUtf8Bytes(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, 'utf8');
  if (buf.byteLength <= maxBytes) {
    return str;
  }
  let end = maxBytes;
  let continuationCount = 0;
  while (continuationCount < 4 && end - 1 - continuationCount >= 0) {
    const byte = buf[end - 1 - continuationCount];
    if (byte === undefined) break;
    if ((byte & 0xc0) === 0x80) {
      continuationCount++;
    } else {
      let needed = 1;
      if ((byte & 0xe0) === 0xc0) needed = 2;
      else if ((byte & 0xf0) === 0xe0) needed = 3;
      else if ((byte & 0xf8) === 0xf0) needed = 4;

      const bytesInSlice = continuationCount + 1;
      if (bytesInSlice < needed) {
        end -= bytesInSlice;
      }
      break;
    }
  }
  if (end - 1 - continuationCount < 0 && continuationCount > 0) {
    end = 0;
  }

  const sliced = buf.subarray(0, end);
  const decoder = new TextDecoder('utf8', { fatal: false });
  let decoded = decoder.decode(sliced);
  if (decoded.length > 0) {
    const lastCode = decoded.charCodeAt(decoded.length - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
      decoded = decoded.slice(0, -1);
    }
  }
  return decoded;
}

export interface TimelineItem {
  id: string;
  type: 'message' | 'command' | 'error' | 'system' | 'user';
  status: 'in_progress' | 'completed' | 'failed';
  text?: string;
  command?: string;
  cwd?: string;
  output?: string;
  exitCode?: number;
  durationMs?: number;
  startedAt?: string;
  completedAt?: string;
}

export interface TimelinePage {
  items: TimelineItem[];
  total: number;
  hasMore: boolean;
  historyTruncated?: boolean;
}

export interface FileDiffItem {
  path: string;
  repository: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  diff: string;
}

export interface RunDiffsRepositorySummary {
  repository: string;
  changed_paths: number;
  additions: number;
  deletions: number;
  patch_type: 'exact_full' | 'delta' | 'unavailable';
  patch_truncated?: boolean;
}

export interface RunDiffsResponse {
  run_id: string;
  agent_id?: string;
  revision: number;
  repositories: RunDiffsRepositorySummary[];
  files: FileDiffItem[];
  raw_patch?: string;
  patch_type?: 'exact_full' | 'delta' | 'mixed' | 'unavailable';
  truncated?: boolean;
  summary?: string;
  report?: {
    status: string;
    summary: string;
    verification: Array<{ name: string; status: string }>;
    unresolved_risks: string[];
    files_changed: string[];
    report_excerpt?: string;
  };
}

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = {
  now: () => new Date(),
};

export interface MutationFence {
  ownerId?: string;
  expectedFenceToken?: number;
  allowTerminalMutation?: boolean;
  expectedStatus?: RunStatus;
}

export interface SteerClaimCriteria {
  ownerId: string;
  expectedFenceToken?: number;
  workerThreadId?: string;
  workerTurnId?: string;
}

export interface ClaimedSteer {
  message: SteeringMessage;
  fenceToken: number;
  ownerId: string;
}

export interface FinalizeSteerOptions {
  steerId: string;
  status: 'delivered' | 'failed';
  error?: string;
  diagnostics?: RunDiagnostics;
  stats?: RunStats;
  rawEvent?: string;
  fence: Required<Pick<MutationFence, 'ownerId' | 'expectedFenceToken'>> & {
    workerThreadId?: string;
    workerTurnId?: string;
  };
}

export interface RunEventIngestion {
  raw: string;
  message?: { itemId: string; ts: string; text: string };
  update?: Partial<Run>;
  event?: string;
}

export interface ReconcileOptions {
  now?: Date;
  ownerId?: string;
  leaseDurationMs?: number;
}

export interface PageCursor {
  createdAt: string;
  runId: string;
}
export interface MessageCursor {
  seq: number;
}
export interface StoredMessage {
  runId: string;
  seq: number;
  ts: string;
  text: string;
  truncated: boolean;
}
export interface RunPage {
  runs: Run[];
  hasMore: boolean;
  nextCursor?: PageCursor;
}
export interface MessagePage {
  messages: StoredMessage[];
  hasMore: boolean;
  nextCursor?: MessageCursor;
}

interface TimelineCacheEntry {
  mtimeMs: number;
  size: number;
  items: Map<string, TimelineItem>;
  order: string[];
  historyTruncated: boolean;
  approxBytes: number;
}

export class RunStore extends EventEmitter {
  private readonly db: DatabaseSync;
  private readonly timelineCache = new Map<string, TimelineCacheEntry>();
  private timelineCacheBytes = 0;
  static readonly MAX_TIMELINE_CACHE_BYTES = 20 * 1024 * 1024; // 20 MiB
  static readonly MAX_TIMELINE_CACHE_ENTRIES = 10;
  constructor(
    readonly stateDir: string,
    private readonly maxServerLogBytes = 25 * 1024 * 1024,
    private readonly clock: Clock = systemClock,
  ) {
    super();
    mkdirSync(join(stateDir, 'runs'), { recursive: true });
    mkdirSync(join(stateDir, 'logs'), { recursive: true });
    this.db = new DatabaseSync(join(stateDir, 'state.db'));
    this.db.exec(
      'PRAGMA journal_mode=WAL; ' +
        'PRAGMA busy_timeout=5000; ' +
        'CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, json TEXT NOT NULL); ' +
        'CREATE TABLE IF NOT EXISTS messages (' +
        'seq INTEGER PRIMARY KEY AUTOINCREMENT, ' +
        'run_id TEXT NOT NULL, item_id TEXT NOT NULL, ts TEXT NOT NULL, ' +
        'text TEXT NOT NULL, truncated INTEGER NOT NULL DEFAULT 0, ' +
        'UNIQUE (run_id, item_id))',
    );
  }
  /** Guard against path traversal via runId. handle() only produces base64url+underscore IDs,
   * but appendRaw and persist are public/semi-public so we validate defensively. */
  private assertSafeId(id: string): void {
    if (!/^[A-Za-z0-9_-]+$/.test(id) || id.length > 128) {
      throw new Error(`INVALID_RUN_ID: Unsafe characters in id "${id.slice(0, 64)}"`);
    }
  }
  add(run: Run, leaseDurationMs = 30_000): void {
    this.assertSafeId(run.runId);
    const now = this.clock.now();
    const enriched: Run = {
      ...run,
      fenceToken: run.fenceToken ?? 1,
      leaseHeartbeatAt: run.leaseHeartbeatAt ?? now.toISOString(),
      leaseExpiresAt: run.leaseExpiresAt ?? new Date(now.getTime() + leaseDurationMs).toISOString(),
    };
    this.db.prepare('INSERT INTO runs VALUES (?, ?)').run(enriched.runId, JSON.stringify(enriched));
    this.persist(enriched, 'run.queued');
  }
  heartbeat(ownerId: string, leaseDurationMs = 30_000): { renewedCount: number; runIds: string[] } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare('SELECT json FROM runs').all() as Array<{ json: string }>;
      const now = this.clock.now();
      const nowIso = now.toISOString();
      const expiresAtIso = new Date(now.getTime() + leaseDurationMs).toISOString();
      const runs = rows.map((row) => JSON.parse(row.json) as Run);
      const activeOwned = runs.filter(
        (run) =>
          run.ownerId === ownerId &&
          (['queued', 'starting', 'running', 'cancel_requested', 'recovery_required'].includes(run.status) ||
            run.operationClaim !== undefined),
      );
      const runIds: string[] = [];
      for (const current of activeOwned) {
        const next: Run = {
          ...current,
          leaseHeartbeatAt: nowIso,
          leaseExpiresAt: expiresAtIso,
        };
        this.db.prepare('UPDATE runs SET json=? WHERE run_id=?').run(JSON.stringify(next), current.runId);
        runIds.push(current.runId);
      }
      this.db.exec('COMMIT');
      return { renewedCount: runIds.length, runIds };
    } catch (cause) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore rollback error */
      }
      throw cause;
    }
  }
  get(id: string): Run | undefined {
    const row = this.db.prepare('SELECT json FROM runs WHERE run_id=?').get(id) as { json?: string } | undefined;
    return row?.json ? (JSON.parse(row.json) as Run) : undefined;
  }
  getByAgent(agentId: string): Run[] {
    return (this.db.prepare('SELECT json FROM runs').all() as Array<{ json: string }>)
      .map((r) => JSON.parse(r.json) as Run)
      .filter((r) => r.agentId === agentId)
      .sort((a, b) => a.continuationIndex - b.continuationIndex);
  }
  list(): Run[] {
    return (this.db.prepare('SELECT json FROM runs').all() as Array<{ json: string }>)
      .map((r) => JSON.parse(r.json) as Run)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  hasRun(runId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 AS present FROM runs WHERE run_id=?').get(runId));
  }
  private readRun(runId: string): Run {
    const row = this.db.prepare('SELECT json FROM runs WHERE run_id=?').get(runId) as { json?: string } | undefined;
    if (!row?.json) throw new Error('RUN_NOT_FOUND');
    return JSON.parse(row.json) as Run;
  }
  private latestRunForAgent(agentId: string): Run | undefined {
    return (this.db.prepare('SELECT json FROM runs').all() as Array<{ json: string }>)
      .map((row) => JSON.parse(row.json) as Run)
      .filter((run) => run.agentId === agentId)
      .sort((a, b) => a.continuationIndex - b.continuationIndex)
      .at(-1);
  }
  private assertOperationClaim(
    run: Run,
    fence: Required<Pick<MutationFence, 'ownerId' | 'expectedFenceToken'>>,
    operation: AgentOperation,
  ): void {
    if (
      run.ownerId !== fence.ownerId ||
      (run.fenceToken ?? 1) !== fence.expectedFenceToken ||
      run.operationClaim?.operation !== operation
    ) {
      throw new Error('AGENT_OPERATION_CLAIM_REJECTED');
    }
  }
  private assertMutationFence(run: Run, fence: MutationFence): void {
    if (fence.ownerId !== undefined && run.ownerId !== fence.ownerId) {
      throw new Error(
        `MUTATION_FENCE_OWNER_MISMATCH: Expected owner ${fence.ownerId} but run is owned by ${run.ownerId}`,
      );
    }
    if (fence.expectedFenceToken !== undefined && (run.fenceToken ?? 1) !== fence.expectedFenceToken) {
      throw new Error(
        `MUTATION_FENCE_TOKEN_MISMATCH: Expected fence token ${fence.expectedFenceToken} but run is at token ${run.fenceToken ?? 1}`,
      );
    }
    if (fence.expectedStatus !== undefined && run.status !== fence.expectedStatus) {
      throw new Error(
        `MUTATION_FENCE_STATUS_MISMATCH: Expected status ${fence.expectedStatus} but run is at status ${run.status}`,
      );
    }
  }
  captureMessage(runId: string, itemId: string, ts: string, text: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO messages (run_id, item_id, ts, text, truncated) VALUES (?, ?, ?, ?, ?)')
      .run(runId, itemId, ts, text.slice(0, MAX_MESSAGE_TEXT), text.length > MAX_MESSAGE_TEXT ? 1 : 0);
    this.pruneMessages(runId);
  }
  ingestEvent(
    runId: string,
    ingestion: RunEventIngestion,
    fence: Required<Pick<MutationFence, 'ownerId' | 'expectedFenceToken'>>,
  ): Run | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT json FROM runs WHERE run_id=?').get(runId) as { json?: string } | undefined;
      if (!row?.json) {
        this.db.exec('COMMIT');
        return undefined;
      }
      const current = JSON.parse(row.json) as Run;
      if (
        current.ownerId !== fence.ownerId ||
        (current.fenceToken ?? 1) !== fence.expectedFenceToken ||
        !['starting', 'running', 'cancel_requested'].includes(current.status) ||
        current.operationClaim !== undefined
      ) {
        this.db.exec('COMMIT');
        return undefined;
      }
      const forbidden = ingestion.update as Record<string, unknown> | undefined;
      if (
        forbidden &&
        ['runId', 'agentId', 'ownerId', 'fenceToken', 'status', 'operationClaim', 'recovery'].some(
          (key) => forbidden[key] !== undefined,
        )
      ) {
        throw new Error('EVENT_INGESTION_UPDATE_INVALID');
      }
      const next: Run = ingestion.update ? { ...current, ...ingestion.update } : current;
      if (ingestion.update) {
        this.db.prepare('UPDATE runs SET json=? WHERE run_id=?').run(JSON.stringify(next), runId);
      }
      if (ingestion.message) {
        const { itemId, ts, text } = ingestion.message;
        this.db
          .prepare('INSERT OR IGNORE INTO messages (run_id, item_id, ts, text, truncated) VALUES (?, ?, ?, ?, ?)')
          .run(runId, itemId, ts, text.slice(0, MAX_MESSAGE_TEXT), text.length > MAX_MESSAGE_TEXT ? 1 : 0);
        this.pruneMessages(runId);
      }
      this.appendRaw(runId, 'raw-events', ingestion.raw);
      if (ingestion.update) this.persist(next, ingestion.event ?? 'run.activity');
      this.db.exec('COMMIT');
      if (ingestion.update) {
        this.emit(`run:${runId}`, next);
        this.emit('change', next);
      }
      return next;
    } catch (cause) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore rollback error */
      }
      throw cause;
    }
  }
  listRunsPage(limit: number, cursor?: PageCursor): RunPage {
    const rows = (
      cursor
        ? this.db
            .prepare(
              "SELECT run_id, json_extract(json, '$.createdAt') AS created_at, json FROM runs " +
                "WHERE (json_extract(json, '$.createdAt') < ? OR " +
                "(json_extract(json, '$.createdAt') = ? AND run_id < ?)) " +
                'ORDER BY created_at DESC, run_id DESC LIMIT ?',
            )
            .all(cursor.createdAt, cursor.createdAt, cursor.runId, limit + 1)
        : this.db
            .prepare(
              "SELECT run_id, json_extract(json, '$.createdAt') AS created_at, json FROM runs " +
                'ORDER BY created_at DESC, run_id DESC LIMIT ?',
            )
            .all(limit + 1)
    ) as Array<{ run_id: string; created_at: string; json: string }>;
    return this.toRunPage(rows, limit);
  }
  listMessagesPage(runId: string, limit: number, cursor?: MessageCursor): MessagePage {
    const rows = (
      cursor
        ? this.db
            .prepare(
              'SELECT seq, ts, text, truncated FROM messages ' +
                'WHERE run_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
            )
            .all(runId, cursor.seq, limit + 1)
        : this.db
            .prepare('SELECT seq, ts, text, truncated FROM messages ' + 'WHERE run_id = ? ORDER BY seq DESC LIMIT ?')
            .all(runId, limit + 1)
    ) as Array<{ seq: number; ts: string; text: string; truncated: number }>;
    return this.toMessagePage(runId, rows, limit);
  }
  private pruneMessages(runId: string): void {
    const overflow = this.db
      .prepare('SELECT seq FROM messages WHERE run_id = ? ORDER BY seq DESC LIMIT -1 OFFSET ?')
      .all(runId, MAX_MESSAGES_PER_RUN) as Array<{ seq: number }>;
    const remove = this.db.prepare('DELETE FROM messages WHERE run_id = ? AND seq = ?');
    for (const row of overflow) remove.run(runId, row.seq);
  }
  private toRunPage(rows: Array<{ run_id: string; created_at: string; json: string }>, limit: number): RunPage {
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const last = page[page.length - 1];
    return {
      runs: page.map((row) => JSON.parse(row.json) as Run),
      hasMore,
      ...(hasMore && last ? { nextCursor: { createdAt: last.created_at, runId: last.run_id } } : {}),
    };
  }
  private toMessagePage(
    runId: string,
    rows: Array<{ seq: number; ts: string; text: string; truncated: number }>,
    limit: number,
  ): MessagePage {
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const last = page[page.length - 1];
    return {
      messages: page.map((row) => ({
        runId,
        seq: row.seq,
        ts: row.ts,
        text: row.text,
        truncated: row.truncated === 1,
      })),
      hasMore,
      ...(hasMore && last ? { nextCursor: { seq: last.seq } } : {}),
    };
  }
  private isClosed = false;

  private getCachedTimeline(runId: string): TimelineCacheEntry | undefined {
    const entry = this.timelineCache.get(runId);
    if (!entry) return undefined;
    // Refresh LRU
    this.timelineCache.delete(runId);
    this.timelineCache.set(runId, entry);
    return entry;
  }

  private setCachedTimeline(runId: string, entry: Omit<TimelineCacheEntry, 'approxBytes'>): void {
    let approxBytes = 256;
    for (const item of entry.items.values()) {
      const stringChars =
        item.id.length +
        (item.text?.length ?? 0) +
        (item.command?.length ?? 0) +
        (item.output?.length ?? 0) +
        (item.cwd?.length ?? 0);
      approxBytes += stringChars * 2 + 128;
    }
    for (const id of entry.order) {
      approxBytes += id.length * 2 + 32;
    }

    const old = this.timelineCache.get(runId);
    if (old) {
      this.timelineCacheBytes = Math.max(0, this.timelineCacheBytes - old.approxBytes);
      this.timelineCache.delete(runId);
    }

    if (approxBytes > RunStore.MAX_TIMELINE_CACHE_BYTES) {
      return;
    }

    while (
      (this.timelineCache.size >= RunStore.MAX_TIMELINE_CACHE_ENTRIES ||
        this.timelineCacheBytes + approxBytes > RunStore.MAX_TIMELINE_CACHE_BYTES) &&
      this.timelineCache.size > 0
    ) {
      const oldestKey = this.timelineCache.keys().next().value;
      if (!oldestKey) break;
      const evicted = this.timelineCache.get(oldestKey);
      if (evicted) {
        this.timelineCacheBytes = Math.max(0, this.timelineCacheBytes - evicted.approxBytes);
      }
      this.timelineCache.delete(oldestKey);
    }

    const fullEntry: TimelineCacheEntry = { ...entry, approxBytes };
    this.timelineCache.set(runId, fullEntry);
    this.timelineCacheBytes += approxBytes;
  }

  clearTimelineCache(runId?: string): void {
    if (runId) {
      const old = this.timelineCache.get(runId);
      if (old) {
        this.timelineCacheBytes = Math.max(0, this.timelineCacheBytes - old.approxBytes);
        this.timelineCache.delete(runId);
      }
    } else {
      this.timelineCache.clear();
      this.timelineCacheBytes = 0;
    }
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.clearTimelineCache();
    try {
      this.db.close();
    } catch {
      /* ignore already closed */
    }
  }
  update(id: string, update: Partial<Run>, event: string, fence?: MutationFence): Run {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT json FROM runs WHERE run_id=?').get(id) as { json?: string } | undefined;
      if (!row?.json) throw new Error('RUN_NOT_FOUND');
      const current = JSON.parse(row.json) as Run;

      const isTerminal = (status: RunStatus): boolean => (terminalStatuses as ReadonlySet<string>).has(status);
      if (isTerminal(current.status) && !fence?.allowTerminalMutation) {
        if (update.status === undefined || !isTerminal(update.status) || update.status !== current.status) {
          throw new Error(`RUN_TERMINAL: Cannot mutate terminal run ${id} in status ${current.status}`);
        }
      }

      const isActive =
        ['queued', 'starting', 'running', 'cancel_requested', 'recovery_required'].includes(current.status) ||
        current.operationClaim !== undefined;
      const isLeaseActive = current.leaseExpiresAt
        ? Date.parse(current.leaseExpiresAt) > this.clock.now().getTime()
        : false;

      if (
        (current.status === 'recovery_required' || current.operationClaim !== undefined) &&
        fence?.expectedFenceToken === undefined
      ) {
        throw new Error('FENCE_REQUIRED');
      }

      if (fence?.ownerId !== undefined && current.ownerId !== fence.ownerId) {
        if (isActive && isLeaseActive) {
          throw new Error(`FENCE_REJECTED: Expected owner ${fence.ownerId} but run is owned by ${current.ownerId}`);
        }
      }

      if (fence?.expectedFenceToken !== undefined && (current.fenceToken ?? 1) !== fence.expectedFenceToken) {
        throw new Error(
          `FENCE_REJECTED: Expected fence token ${fence.expectedFenceToken} but run is at token ${current.fenceToken ?? 1}`,
        );
      }

      if (fence?.expectedStatus !== undefined && current.status !== fence.expectedStatus) {
        throw new Error(
          `FENCE_REJECTED: Expected status ${fence.expectedStatus} but run is at status ${current.status}`,
        );
      }

      const next = { ...current, ...update };
      if (update.status && !acceptsSteering(update.status)) {
        Object.assign(next, closeSteering(next, `run_${update.status}`));
      }
      if (fence?.ownerId !== undefined && current.ownerId !== fence.ownerId) {
        next.ownerId = fence.ownerId;
      }
      if (update.status && (isTerminal(update.status) || update.status === 'ready_for_review')) {
        next.leaseExpiresAt = undefined;
      }
      this.db.prepare('UPDATE runs SET json=? WHERE run_id=?').run(JSON.stringify(next), id);
      this.db.exec('COMMIT');

      this.persist(next, event);
      this.emit(`run:${id}`, next);
      this.emit('change', next);
      return next;
    } catch (cause) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore rollback error */
      }
      throw cause;
    }
  }
  setStatus(id: string, status: RunStatus, extras: Partial<Run> = {}, fence?: MutationFence): Run {
    return this.update(id, { ...extras, status }, `run.${status}`, fence);
  }
  enqueueSteer(runId: string, item: SteeringMessage, fence?: MutationFence): Run {
    this.assertSafeId(runId);
    const MAX_STEER_BYTES = 10 * 1024; // 10 KiB
    if (Buffer.byteLength(item.message, 'utf8') > MAX_STEER_BYTES) {
      throw new Error('STEER_MESSAGE_TOO_LONG');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const run = this.readRun(runId);
      if (fence) this.assertMutationFence(run, fence);
      if (!acceptsSteering(run.status)) throw new Error('STEER_RUN_NOT_ACTIVE');
      const queue = [...(run.steeringQueue ?? [])];
      if (queue.filter((m) => m.status === 'pending' || m.status === 'dispatching').length >= 10) {
        throw new Error('STEERING_QUEUE_FULL');
      }
      queue.push(item);
      let history = [...(run.steeringMessages ?? [])];
      history.push(item);
      if (history.length > 50) history = history.slice(-50);
      const nextPending = queue.find((m) => m.status === 'pending');
      const updated: Run = {
        ...run,
        steeringVersion: (run.steeringVersion ?? 0) + 1,
        steeringQueue: queue,
        steeringMessages: history,
        pendingSteer: nextPending
          ? { id: nextPending.id, message: nextPending.message, requestedAt: nextPending.queuedAt }
          : undefined,
      };
      this.db.prepare('UPDATE runs SET json=? WHERE run_id=?').run(JSON.stringify(updated), runId);
      this.db.exec('COMMIT');
      this.persist(updated, 'run.steer_enqueued');
      this.emit(`run:${runId}`, updated);
      this.emit('change', updated);
      return updated;
    } catch (cause) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore
      }
      throw cause;
    }
  }

  claimNextSteer(runId: string, criteria: string | SteerClaimCriteria): ClaimedSteer | undefined {
    this.assertSafeId(runId);
    const ownerId = typeof criteria === 'string' ? criteria : criteria.ownerId;
    const expectedFenceToken = typeof criteria === 'string' ? undefined : criteria.expectedFenceToken;
    const workerThreadId = typeof criteria === 'string' ? undefined : criteria.workerThreadId;
    const workerTurnId = typeof criteria === 'string' ? undefined : criteria.workerTurnId;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const run = this.readRun(runId);
      if (run.ownerId !== ownerId || run.status !== 'running') {
        this.db.exec('COMMIT');
        return undefined;
      }
      if (expectedFenceToken !== undefined && (run.fenceToken ?? 1) !== expectedFenceToken) {
        this.db.exec('COMMIT');
        return undefined;
      }
      if (workerThreadId !== undefined && run.workerThreadId !== workerThreadId) {
        this.db.exec('COMMIT');
        return undefined;
      }
      if (workerTurnId !== undefined && run.workerTurnId !== workerTurnId) {
        this.db.exec('COMMIT');
        return undefined;
      }
      if (run.leaseExpiresAt && Date.parse(run.leaseExpiresAt) <= this.clock.now().getTime()) {
        this.db.exec('COMMIT');
        return undefined;
      }
      const queue = [...(run.steeringQueue ?? [])];
      if (queue.some((m) => m.status === 'dispatching')) {
        this.db.exec('COMMIT');
        return undefined;
      }
      const pendingIndex = queue.findIndex((m) => m.status === 'pending');
      if (pendingIndex === -1) {
        this.db.exec('COMMIT');
        return undefined;
      }
      const nowIso = this.clock.now().toISOString();
      const currentFence = run.fenceToken ?? 1;
      const claimed: SteeringMessage = {
        ...queue[pendingIndex]!,
        status: 'dispatching',
        dispatchingAt: nowIso,
        dispatchOwnerId: ownerId,
        dispatchFenceToken: currentFence,
      };
      queue[pendingIndex] = claimed;
      let history = [...(run.steeringMessages ?? [])];
      const histIndex = history.findIndex((m) => m.id === claimed.id);
      if (histIndex >= 0) {
        history[histIndex] = claimed;
      } else {
        history.push(claimed);
      }
      if (history.length > 50) history = history.slice(-50);
      const nextPending = queue.find((m) => m.status === 'pending');
      const updated: Run = {
        ...run,
        steeringVersion: (run.steeringVersion ?? 0) + 1,
        steeringQueue: queue,
        steeringMessages: history,
        pendingSteer: nextPending
          ? { id: nextPending.id, message: nextPending.message, requestedAt: nextPending.queuedAt }
          : undefined,
      };
      this.db.prepare('UPDATE runs SET json=? WHERE run_id=?').run(JSON.stringify(updated), runId);
      this.db.exec('COMMIT');
      this.persist(updated, 'run.steer_dispatching');
      this.emit(`run:${runId}`, updated);
      this.emit('change', updated);
      return { message: claimed, fenceToken: currentFence, ownerId };
    } catch (cause) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore
      }
      throw cause;
    }
  }

  dequeueSteer(
    runId: string,
    steerId: string,
    status: 'delivered' | 'failed' | 'uncertain',
    error?: string,
    fence?: MutationFence,
  ): Run {
    this.assertSafeId(runId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const run = this.readRun(runId);
      if (fence) this.assertMutationFence(run, fence);
      let queue = [...(run.steeringQueue ?? [])];
      const targetIndex = queue.findIndex((m) => m.id === steerId);
      if (targetIndex === -1) {
        throw new Error(`STEER_NOT_FOUND: Steer message ${steerId} not in queue`);
      }
      const existing = queue[targetIndex]!;
      if (fence) {
        if (existing.status !== 'dispatching') {
          throw new Error(
            `STEER_CLAIM_INVALID: Steer message ${steerId} is in status ${existing.status}, expected dispatching`,
          );
        }
        if (
          fence.ownerId !== undefined &&
          existing.dispatchOwnerId !== undefined &&
          existing.dispatchOwnerId !== fence.ownerId
        ) {
          throw new Error(
            `STEER_CLAIM_OWNER_MISMATCH: Steer message ${steerId} claimed by ${existing.dispatchOwnerId}, expected ${fence.ownerId}`,
          );
        }
        if (
          fence.expectedFenceToken !== undefined &&
          existing.dispatchFenceToken !== undefined &&
          existing.dispatchFenceToken !== fence.expectedFenceToken
        ) {
          throw new Error(
            `STEER_CLAIM_TOKEN_MISMATCH: Steer message ${steerId} claimed at token ${existing.dispatchFenceToken}, expected ${fence.expectedFenceToken}`,
          );
        }
      }
      const nowIso = this.clock.now().toISOString();
      const target: SteeringMessage = {
        ...existing,
        status,
        sentAt: nowIso,
        dispatchingAt: undefined,
        ...(error ? { error: truncateUtf8Bytes(error, 500) } : {}),
      };
      queue[targetIndex] = target;
      if (queue.length > 50) queue = queue.slice(-50);
      let history = [...(run.steeringMessages ?? [])];
      const histIndex = history.findIndex((m) => m.id === steerId);
      if (histIndex >= 0) {
        history[histIndex] = target;
      } else {
        history.push(target);
      }
      if (history.length > 50) history = history.slice(-50);
      const nextPending = queue.find((m) => m.status === 'pending');
      const updated: Run = {
        ...run,
        steeringVersion: (run.steeringVersion ?? 0) + 1,
        steeringQueue: queue,
        steeringMessages: history,
        pendingSteer: nextPending
          ? { id: nextPending.id, message: nextPending.message, requestedAt: nextPending.queuedAt }
          : undefined,
      };
      this.db.prepare('UPDATE runs SET json=? WHERE run_id=?').run(JSON.stringify(updated), runId);
      this.db.exec('COMMIT');
      this.persist(updated, `run.steer_${status}`);
      this.emit(`run:${runId}`, updated);
      this.emit('change', updated);
      return updated;
    } catch (cause) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore
      }
      throw cause;
    }
  }

  finalizeSteerDispatch(runId: string, options: FinalizeSteerOptions): Run {
    this.assertSafeId(runId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT json FROM runs WHERE run_id=?').get(runId) as { json?: string } | undefined;
      if (!row?.json) throw new Error('RUN_NOT_FOUND');
      const current = JSON.parse(row.json) as Run;

      if (current.ownerId !== options.fence.ownerId) {
        throw new Error(
          `MUTATION_FENCE_OWNER_MISMATCH: Expected owner ${options.fence.ownerId} but run is owned by ${current.ownerId}`,
        );
      }
      if ((current.fenceToken ?? 1) !== options.fence.expectedFenceToken) {
        throw new Error(
          `MUTATION_FENCE_TOKEN_MISMATCH: Expected fence token ${options.fence.expectedFenceToken} but run is at token ${current.fenceToken ?? 1}`,
        );
      }
      if (current.status !== 'running') {
        throw new Error(
          `MUTATION_FENCE_STATUS_MISMATCH: Expected status running but run is at status ${current.status}`,
        );
      }
      if (options.fence.workerThreadId && current.workerThreadId !== options.fence.workerThreadId) {
        throw new Error(
          `MUTATION_FENCE_THREAD_MISMATCH: Expected thread ${options.fence.workerThreadId} but run is at ${current.workerThreadId}`,
        );
      }
      if (options.fence.workerTurnId && current.workerTurnId !== options.fence.workerTurnId) {
        throw new Error(
          `MUTATION_FENCE_TURN_MISMATCH: Expected turn ${options.fence.workerTurnId} but run is at ${current.workerTurnId}`,
        );
      }

      let queue = [...(current.steeringQueue ?? [])];
      const targetIndex = queue.findIndex((m) => m.id === options.steerId);
      if (targetIndex === -1) {
        throw new Error(`STEER_NOT_FOUND: Steer message ${options.steerId} not in queue`);
      }
      const existing = queue[targetIndex]!;
      if (existing.status !== 'dispatching') {
        throw new Error(
          `STEER_CLAIM_INVALID: Steer message ${options.steerId} is in status ${existing.status}, expected dispatching`,
        );
      }
      if (existing.dispatchOwnerId !== undefined && existing.dispatchOwnerId !== options.fence.ownerId) {
        throw new Error(
          `STEER_CLAIM_OWNER_MISMATCH: Steer message ${options.steerId} claimed by ${existing.dispatchOwnerId}, expected ${options.fence.ownerId}`,
        );
      }
      if (
        existing.dispatchFenceToken !== undefined &&
        existing.dispatchFenceToken !== options.fence.expectedFenceToken
      ) {
        throw new Error(
          `STEER_CLAIM_TOKEN_MISMATCH: Steer message ${options.steerId} claimed at token ${existing.dispatchFenceToken}, expected ${options.fence.expectedFenceToken}`,
        );
      }

      const nowIso = this.clock.now().toISOString();
      const target: SteeringMessage = {
        ...existing,
        status: options.status,
        sentAt: nowIso,
        dispatchingAt: undefined,
        ...(options.error ? { error: truncateUtf8Bytes(options.error, 500) } : {}),
      };
      queue[targetIndex] = target;
      if (queue.length > 50) queue = queue.slice(-50);
      let history = [...(current.steeringMessages ?? [])];
      const histIndex = history.findIndex((m) => m.id === options.steerId);
      if (histIndex >= 0) {
        history[histIndex] = target;
      } else {
        history.push(target);
      }
      if (history.length > 50) history = history.slice(-50);
      const nextPending = queue.find((m) => m.status === 'pending');
      let mergedDiagnostics = current.diagnostics;
      if (options.status === 'delivered') {
        mergedDiagnostics = {
          ...current.diagnostics,
          last_phase: 'steered',
          last_activity_at: nowIso,
        };
      }
      if (options.diagnostics) {
        mergedDiagnostics = {
          ...current.diagnostics,
          ...options.diagnostics,
          ...(current.diagnostics?.commands_active_count !== undefined
            ? { commands_active_count: current.diagnostics.commands_active_count }
            : {}),
          ...(current.diagnostics?.commands_completed_count !== undefined
            ? { commands_completed_count: current.diagnostics.commands_completed_count }
            : {}),
          last_activity_at: nowIso,
          last_phase:
            options.status === 'delivered'
              ? 'steered'
              : (options.diagnostics.last_phase ?? current.diagnostics?.last_phase),
        };
      }

      const next: Run = {
        ...current,
        steeringVersion: (current.steeringVersion ?? 0) + 1,
        steeringQueue: queue,
        steeringMessages: history,
        pendingSteer: nextPending
          ? { id: nextPending.id, message: nextPending.message, requestedAt: nextPending.queuedAt }
          : undefined,
        ...(mergedDiagnostics ? { diagnostics: mergedDiagnostics } : {}),
        ...(options.stats ? { stats: options.stats } : {}),
      };

      this.db.prepare('UPDATE runs SET json=? WHERE run_id=?').run(JSON.stringify(next), runId);

      // Append raw events or stderr while holding the transaction write lock
      if (options.status === 'delivered' && options.rawEvent) {
        this.appendRaw(runId, 'raw-events', options.rawEvent);
      } else if (options.status === 'failed' && options.error) {
        this.appendRaw(runId, 'stderr', `[steer error] ${options.error}\n`);
      }

      this.persist(next, options.status === 'delivered' ? 'run.steered' : 'run.steer_failed');
      this.db.exec('COMMIT');

      this.emit(`run:${runId}`, next);
      this.emit('change', next);
      return next;
    } catch (cause) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore
      }
      throw cause;
    }
  }
  claimAgentOperation(
    agentId: string,
    expectedRunId: string,
    expectedStatuses: readonly RunStatus[],
    ownerId: string,
    operation: AgentOperation,
    leaseDurationMs = 30_000,
  ): Run {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = this.clock.now();
      const runs = (this.db.prepare('SELECT json FROM runs').all() as Array<{ json: string }>).map(
        (row) => JSON.parse(row.json) as Run,
      );
      const latest = runs
        .filter((run) => run.agentId === agentId)
        .sort((a, b) => a.continuationIndex - b.continuationIndex)
        .at(-1);
      if (!latest || latest.runId !== expectedRunId || !expectedStatuses.includes(latest.status)) {
        throw new Error('AGENT_OPERATION_CLAIM_REJECTED');
      }
      // A lease expiry does not prove that the previous process has stopped its
      // external side effect. In particular, host promotion may still be
      // running after its claim is fenced. No new operation may overlap it.
      if (latest.recovery?.kind === 'settled_operation') {
        throw new Error('AGENT_OPERATION_RECOVERY_REQUIRED');
      }
      if (latest.operationClaim) throw new Error('AGENT_BUSY');
      const next: Run = {
        ...latest,
        ownerId,
        fenceToken: (latest.fenceToken ?? 1) + 1,
        leaseHeartbeatAt: now.toISOString(),
        leaseExpiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
        operationClaim: { operation, claimedAt: now.toISOString() },
      };
      this.db.prepare('UPDATE runs SET json=? WHERE run_id=?').run(JSON.stringify(next), next.runId);
      this.db.exec('COMMIT');
      this.persist(next, `run.${operation}_claimed`);
      this.emit(`run:${next.runId}`, next);
      this.emit('change', next);
      return next;
    } catch (cause) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore rollback error */
      }
      throw cause;
    }
  }
  addClaimedContinuation(
    claimedRunId: string,
    priorRunId: string,
    continuation: Run,
    priorUpdate: Partial<Run>,
    fence: Required<Pick<MutationFence, 'ownerId' | 'expectedFenceToken'>>,
    leaseDurationMs = 30_000,
  ): Run {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const claimed = this.readRun(claimedRunId);
      this.assertOperationClaim(claimed, fence, 'reply');
      const latest = this.latestRunForAgent(claimed.agentId);
      if (!latest || latest.runId !== claimedRunId || continuation.agentId !== claimed.agentId) {
        throw new Error('AGENT_OPERATION_CLAIM_REJECTED');
      }
      const prior = this.readRun(priorRunId);
      if (
        prior.agentId !== claimed.agentId ||
        (!['ready_for_review', 'superseded', 'cancelled'].includes(prior.status) && !prior.workerThreadId)
      ) {
        throw new Error('AGENT_UNAVAILABLE');
      }
      const now = this.clock.now();
      const enriched: Run = {
        ...continuation,
        fenceToken: continuation.fenceToken ?? 1,
        leaseHeartbeatAt: continuation.leaseHeartbeatAt ?? now.toISOString(),
        leaseExpiresAt: continuation.leaseExpiresAt ?? new Date(now.getTime() + leaseDurationMs).toISOString(),
      };
      this.db.prepare('INSERT INTO runs VALUES (?, ?)').run(enriched.runId, JSON.stringify(enriched));
      const updatedPrior: Run = {
        ...prior,
        ...(prior.status === 'ready_for_review' ? priorUpdate : {}),
        ...(prior.status === 'ready_for_review' ? { status: 'superseded' as const } : {}),
        ...(prior.runId === claimedRunId ? { operationClaim: undefined, leaseExpiresAt: undefined } : {}),
      };
      if (updatedPrior !== prior) {
        this.db.prepare('UPDATE runs SET json=? WHERE run_id=?').run(JSON.stringify(updatedPrior), updatedPrior.runId);
      }
      let releasedClaim = claimed;
      if (prior.runId !== claimedRunId) {
        releasedClaim = { ...claimed, operationClaim: undefined, leaseExpiresAt: undefined };
        this.db.prepare('UPDATE runs SET json=? WHERE run_id=?').run(JSON.stringify(releasedClaim), claimed.runId);
      }
      this.persist(enriched, 'run.queued');
      if (prior.status === 'ready_for_review') this.persist(updatedPrior, 'run.superseded');
      if (prior.runId !== claimedRunId) this.persist(releasedClaim, 'run.reply_released');
      this.db.exec('COMMIT');
      this.emit(`run:${enriched.runId}`, enriched);
      this.emit('change', enriched);
      return enriched;
    } catch (cause) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore rollback error */
      }
      throw cause;
    }
  }
  finalizeAgentDeletion(
    agentId: string,
    claimedRunId: string,
    deletedAt: string,
    fence: Required<Pick<MutationFence, 'ownerId' | 'expectedFenceToken'>>,
  ): Run[] {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const claimed = this.readRun(claimedRunId);
      this.assertOperationClaim(claimed, fence, 'delete');
      if (claimed.agentId !== agentId) throw new Error('AGENT_OPERATION_CLAIM_REJECTED');
      const runs = (this.db.prepare('SELECT json FROM runs').all() as Array<{ json: string }>).map(
        (row) => JSON.parse(row.json) as Run,
      );
      const updated = runs
        .filter((run) => run.agentId === agentId)
        .map((run): Run => {
          const rejected = run.status === 'ready_for_review';
          const recovered = run.status === 'recovery_required';
          return {
            ...run,
            ...(rejected ? { status: 'rejected' as const, completedAt: run.completedAt ?? deletedAt } : {}),
            ...(recovered ? { status: 'cancelled' as const, completedAt: run.completedAt ?? deletedAt } : {}),
            ...(run.runId === claimedRunId
              ? { operationClaim: undefined, recovery: undefined, leaseExpiresAt: undefined }
              : {}),
            diagnostics: {
              last_phase: run.diagnostics?.last_phase ?? run.status,
              last_activity_at: run.diagnostics?.last_activity_at ?? deletedAt,
              ...run.diagnostics,
              ...(rejected || recovered ? { last_phase: 'deleted', last_activity_at: deletedAt } : {}),
              ...(rejected || recovered ? { exit_reason: 'agent_deleted' } : {}),
              resources_deleted_at: deletedAt,
            },
          };
        });
      const write = this.db.prepare('UPDATE runs SET json=? WHERE run_id=?');
      for (const run of updated) write.run(JSON.stringify(run), run.runId);
      for (const run of updated)
        this.persist(run, run.status === 'rejected' ? 'run.rejected' : 'run.resources_deleted');
      this.db.exec('COMMIT');
      for (const run of updated) {
        this.clearTimelineCache(run.runId);
        this.emit(`run:${run.runId}`, run);
        this.emit('change', run);
      }
      return updated.sort((a, b) => a.continuationIndex - b.continuationIndex);
    } catch (cause) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore rollback error */
      }
      throw cause;
    }
  }
  /** Operator-only recovery of a completed, known preflight rejection, never an expired/ambiguous operation. */
  claimPromotionPreflightRecovery(agentId: string, runId: string, ownerId: string): Run {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.readRun(runId);
      const latest = this.getByAgent(agentId).at(-1);
      if (
        latest?.runId !== runId ||
        current.agentId !== agentId ||
        current.status !== 'recovery_required' ||
        current.operationClaim ||
        current.recovery?.kind !== 'settled_operation' ||
        current.recovery.operation !== 'promote' ||
        !/^PROMOTION_PARENT_PATH_CHANGED:[^\r\n]+$/.test(current.diagnostics?.recovery_error_excerpt ?? '')
      ) {
        throw new Error('PROMOTION_PREFLIGHT_RECOVERY_REJECTED');
      }
      const next: Run = {
        ...current,
        ownerId,
        fenceToken: (current.fenceToken ?? 1) + 1,
        leaseHeartbeatAt: this.clock.now().toISOString(),
        leaseExpiresAt: new Date(this.clock.now().getTime() + 30_000).toISOString(),
        operationClaim: { operation: 'promote', claimedAt: this.clock.now().toISOString() },
      };
      this.db.prepare('UPDATE runs SET json=? WHERE run_id=?').run(JSON.stringify(next), runId);
      this.persist(next, 'run.promotion_recovery_claimed');
      this.db.exec('COMMIT');
      return next;
    } catch (cause) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* already committed */
      }
      throw cause;
    }
  }

  finishPromotionPreflightRecovery(
    runId: string,
    fence: Required<Pick<MutationFence, 'ownerId' | 'expectedFenceToken'>>,
    success: boolean,
    changeSet?: Run['changeSet'],
  ): Run {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.readRun(runId);
      this.assertOperationClaim(current, fence, 'promote');
      if (current.status !== 'recovery_required') throw new Error('PROMOTION_PREFLIGHT_RECOVERY_REJECTED');
      const next: Run = {
        ...current,
        operationClaim: undefined,
        leaseExpiresAt: undefined,
        ...(success
          ? {
              status: 'ready_for_review' as const,
              recovery: undefined,
              errorCode: undefined,
              requiresUserAction: false,
              ...(changeSet ? { changeSet } : {}),
              diagnostics: {
                ...current.diagnostics,
                last_phase: 'ready_for_review',
                last_activity_at: this.clock.now().toISOString(),
                exit_reason: undefined,
                recovery_error_excerpt: undefined,
              },
            }
          : {}),
      };
      this.db.prepare('UPDATE runs SET json=? WHERE run_id=?').run(JSON.stringify(next), runId);
      this.persist(next, success ? 'run.promotion_recovered' : 'run.promotion_recovery_rejected');
      this.db.exec('COMMIT');
      this.emit(`run:${runId}`, next);
      this.emit('change', next);
      return next;
    } catch (cause) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* already committed */
      }
      throw cause;
    }
  }

  /** Called only after the manager's typed, pre-write failure; a stale fence must never unlock recovery. */
  releasePromotionPreflightClaim(
    runId: string,
    fence: Required<Pick<MutationFence, 'ownerId' | 'expectedFenceToken'>>,
  ): Run {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.readRun(runId);
      this.assertOperationClaim(current, fence, 'promote');
      const next: Run = { ...current, operationClaim: undefined, leaseExpiresAt: undefined };
      this.db.prepare('UPDATE runs SET json=? WHERE run_id=?').run(JSON.stringify(next), runId);
      this.persist(next, 'run.promotion_preflight_rejected');
      this.db.exec('COMMIT');
      this.emit(`run:${runId}`, next);
      this.emit('change', next);
      return next;
    } catch (cause) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* already committed */
      }
      throw cause;
    }
  }

  markOperationRecovery(
    runId: string,
    operation: AgentOperation,
    errorExcerpt: string,
    fence: Required<Pick<MutationFence, 'ownerId' | 'expectedFenceToken'>>,
  ): Run {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.readRun(runId);
      this.assertOperationClaim(current, fence, operation);
      const nowIso = this.clock.now().toISOString();
      const next: Run = {
        ...current,
        status: 'recovery_required',
        operationClaim: undefined,
        recovery: { kind: 'settled_operation', operation },
        leaseExpiresAt: undefined,
        completedAt: undefined,
        errorCode: 'AGENT_OPERATION_RECOVERY_REQUIRED',
        requiresUserAction: true,
        diagnostics: {
          ...current.diagnostics,
          last_phase: 'recovery_required',
          last_activity_at: nowIso,
          exit_reason: `The ${operation} operation did not complete cleanly and requires recovery.`,
          recovery_error_excerpt: errorExcerpt.slice(0, 500),
        },
      };
      this.db.prepare('UPDATE runs SET json=? WHERE run_id=?').run(JSON.stringify(next), runId);
      this.persist(next, 'run.recovery_required');
      this.db.exec('COMMIT');
      this.emit(`run:${runId}`, next);
      this.emit('change', next);
      return next;
    } catch (cause) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore rollback error */
      }
      throw cause;
    }
  }
  tryStart(
    id: string,
    serverLimit: number,
    workerLimit: number,
    ownerId?: string,
    extras: Partial<Run> = {},
    expectedFenceToken?: number,
    leaseDurationMs = 30_000,
  ): Run | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = this.clock.now();
      const reconciled = this.reconcileStaleRunsInternal(now, ownerId, leaseDurationMs);

      const rows = this.db.prepare('SELECT json FROM runs').all() as Array<{ json: string }>;
      const runs = rows.map((row) => JSON.parse(row.json) as Run);
      const current = runs.find((run) => run.runId === id);
      const active = runs.filter((run) =>
        ['starting', 'running', 'cancel_requested', 'recovery_required'].includes(run.status),
      );
      if (
        !current ||
        current.status !== 'queued' ||
        (ownerId !== undefined && current.ownerId !== ownerId) ||
        (expectedFenceToken !== undefined && (current.fenceToken ?? 1) !== expectedFenceToken) ||
        active.length >= serverLimit ||
        active.filter((run) => run.worker === current.worker).length >= workerLimit
      ) {
        this.db.exec('COMMIT');
        this.dispatchReconciledEvents(reconciled.updatedRuns);
        return undefined;
      }
      const nextFence = (current.fenceToken ?? 1) + 1;
      const next: Run = {
        ...current,
        ...extras,
        status: 'starting' as const,
        fenceToken: nextFence,
        ownerId: ownerId ?? current.ownerId,
        leaseHeartbeatAt: now.toISOString(),
        leaseExpiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
      };
      this.db.prepare('UPDATE runs SET json=? WHERE run_id=?').run(JSON.stringify(next), id);
      this.db.exec('COMMIT');

      this.dispatchReconciledEvents(reconciled.updatedRuns);
      this.persist(next, 'run.starting');
      this.emit(`run:${id}`, next);
      this.emit('change', next);
      return next;
    } catch (cause) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The transaction may already have committed before a persistence failure.
      }
      throw cause;
    }
  }
  reconcileStaleRuns(options: ReconcileOptions = {}): {
    reconciledCount: number;
    reconciledRunIds: string[];
    recoveryRunIds: string[];
  } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.reconcileStaleRunsInternal(
        options.now ?? this.clock.now(),
        options.ownerId,
        options.leaseDurationMs ?? 30_000,
      );
      this.db.exec('COMMIT');
      this.dispatchReconciledEvents(result.updatedRuns);
      if (result.reconciledRunIds.length > 0) {
        this.logServer('reconciled_stale_runs', {
          count: result.reconciledRunIds.length,
          run_ids: result.reconciledRunIds,
        });
      }
      return {
        reconciledCount: result.reconciledRunIds.length,
        reconciledRunIds: result.reconciledRunIds,
        recoveryRunIds: result.recoveryRunIds,
      };
    } catch (cause) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Rollback may fail if transaction already aborted.
      }
      throw cause;
    }
  }
  private reconcileStaleRunsInternal(
    now: Date,
    ownerId?: string,
    leaseDurationMs = 30_000,
  ): {
    reconciledRunIds: string[];
    recoveryRunIds: string[];
    updatedRuns: Array<{ run: Run; event: string; exitReason: string }>;
  } {
    const nowIso = now.toISOString();
    const nowMs = now.getTime();
    const rows = this.db.prepare('SELECT json FROM runs').all() as Array<{ json: string }>;
    const runs = rows.map((row) => JSON.parse(row.json) as Run);
    const staleRuns = runs.filter((run) => {
      if (!['starting', 'running', 'cancel_requested', 'queued'].includes(run.status) && !run.operationClaim) {
        return false;
      }
      if (run.leaseExpiresAt) {
        const expiryMs = Date.parse(run.leaseExpiresAt);
        return Number.isFinite(expiryMs) && expiryMs <= nowMs;
      }
      // Legacy records without lease metadata:
      // Handled conservatively; do not declare dead merely because a new process starts.
      return false;
    });

    const reconciledRunIds: string[] = [];
    const recoveryRunIds: string[] = [];
    const updatedRuns: Array<{ run: Run; event: string; exitReason: string }> = [];

    for (const current of staleRuns) {
      let nextStatus: RunStatus;
      let errorCode: string | undefined;
      let exitReason: string;

      if (current.operationClaim) {
        nextStatus = 'recovery_required';
        errorCode = 'AGENT_OPERATION_RECOVERY_REQUIRED';
        exitReason = `The ${current.operationClaim.operation} operation owner lease expired; manual recovery is required.`;
      } else if (current.status === 'cancel_requested') {
        nextStatus = 'recovery_required';
        exitReason = 'Local Engineer server restarted or lease expired during cancellation.';
      } else if (current.status === 'queued') {
        nextStatus = 'cancelled';
        errorCode = 'SERVER_PROCESS_RESTARTED';
        exitReason = 'Local Engineer server restarted or lease expired while this run was queued.';
      } else {
        nextStatus = 'recovery_required';
        errorCode = 'SERVER_PROCESS_RESTARTED';
        exitReason = 'Local Engineer server restarted or lease expired while this run was in progress.';
      }

      const nextFence = (current.fenceToken ?? 1) + 1;
      const next: Run = {
        ...current,
        status: nextStatus,
        fenceToken: nextFence,
        ...closeSteering(current, 'server_reconciled'),
        ...(ownerId ? { ownerId } : {}),
        leaseHeartbeatAt: ownerId ? nowIso : current.leaseHeartbeatAt,
        leaseExpiresAt:
          nextStatus === 'recovery_required' && ownerId && !current.operationClaim
            ? new Date(nowMs + leaseDurationMs).toISOString()
            : undefined,
        completedAt: nextStatus === 'cancelled' ? (current.completedAt ?? nowIso) : undefined,
        errorCode: errorCode ?? current.errorCode,
        operationClaim: undefined,
        recovery:
          nextStatus === 'recovery_required'
            ? current.operationClaim
              ? { kind: 'settled_operation', operation: current.operationClaim.operation }
              : {
                  kind: 'container_cleanup',
                  targetStatus: current.status === 'cancel_requested' ? 'cancelled' : 'failed',
                }
            : undefined,
        requiresUserAction: current.operationClaim !== undefined,
        diagnostics: {
          ...current.diagnostics,
          last_phase: nextStatus,
          last_activity_at: nowIso,
          commands_active_count: 0,
          exit_reason: exitReason,
        },
        result: current.result ?? {
          ...emptyResult(),
          summary: exitReason,
          unresolvedRisks: [exitReason],
        },
      };

      this.db.prepare('UPDATE runs SET json=? WHERE run_id=?').run(JSON.stringify(next), current.runId);
      updatedRuns.push({ run: next, event: `run.${nextStatus}`, exitReason });
      reconciledRunIds.push(current.runId);
      if (next.recovery?.kind === 'container_cleanup' && ownerId) recoveryRunIds.push(current.runId);
    }

    if (ownerId) {
      for (const current of runs) {
        if (
          current.status !== 'recovery_required' ||
          current.recovery?.kind !== 'container_cleanup' ||
          current.requiresUserAction ||
          staleRuns.some((run) => run.runId === current.runId)
        )
          continue;
        const leaseActive = current.leaseExpiresAt ? Date.parse(current.leaseExpiresAt) > nowMs : false;
        if (current.ownerId !== ownerId && leaseActive) continue;
        const adopted =
          current.ownerId === ownerId
            ? current
            : {
                ...current,
                ownerId,
                fenceToken: (current.fenceToken ?? 1) + 1,
                leaseHeartbeatAt: nowIso,
                leaseExpiresAt: new Date(nowMs + leaseDurationMs).toISOString(),
              };
        if (adopted !== current) {
          this.db.prepare('UPDATE runs SET json=? WHERE run_id=?').run(JSON.stringify(adopted), adopted.runId);
          updatedRuns.push({
            run: adopted,
            event: 'run.recovery_adopted',
            exitReason: 'Container cleanup recovery adopted.',
          });
        }
        recoveryRunIds.push(adopted.runId);
      }
    }

    return { reconciledRunIds, recoveryRunIds, updatedRuns };
  }
  private dispatchReconciledEvents(updatedRuns: Array<{ run: Run; event: string; exitReason: string }>): void {
    const nowIso = this.clock.now().toISOString();
    for (const { run, event, exitReason } of updatedRuns) {
      try {
        this.persist(run, event);
        this.appendRaw(run.runId, 'stderr', `${nowIso} [server] ${exitReason}\n`);
        this.emit(`run:${run.runId}`, run);
        this.emit('change', run);
      } catch {
        // Failure to persist auxiliary files for one run should not abort reconciliation of others.
      }
    }
  }
  private persist(run: Run, event: string): void {
    this.assertSafeId(run.runId);
    const dir = join(this.stateDir, 'runs', run.runId);
    mkdirSync(dir, { recursive: true });
    const safe = this.privateRun(run);
    this.atomic(join(dir, 'metadata.json'), JSON.stringify(safe, null, 2));
    appendFileSync(
      join(dir, 'events.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), event, run_id: run.runId, status: run.status })}\n`,
    );
    this.atomic(
      join(dir, 'request.json'),
      JSON.stringify(
        {
          title: run.title,
          task: run.task,
          grounding_packet: run.grounding,
          working_directory: run.workingDirectory,
          worker: run.worker,
        },
        null,
        2,
      ),
    );
    if (run.result)
      this.atomic(join(dir, 'result.json'), JSON.stringify({ result: run.result, status: run.status }, null, 2));
  }
  private privateRun(run: Run): Run {
    return run;
  }
  private atomic(path: string, contents: string): void {
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, contents, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, path);
  }
  appendRaw(runId: string, stream: 'stdout' | 'stderr' | 'raw-events', content: string): void {
    this.assertSafeId(runId);
    const file = stream === 'raw-events' ? 'harness/raw-events.jsonl' : `${stream}.log`;
    const path = join(this.stateDir, 'runs', runId, file);
    mkdirSync(join(path, '..'), { recursive: true });
    appendFileSync(path, content);
  }
  logServer(event: string, details: Record<string, unknown>): void {
    this.appendServerLog(`${JSON.stringify({ timestamp: new Date().toISOString(), event, ...details })}\n`);
  }
  private appendServerLog(entry: string): void {
    const current = join(this.stateDir, 'logs', 'server.log');
    const archived = `${current}.1`;
    if (existsSync(current) && statSync(current).size + Buffer.byteLength(entry) > this.maxServerLogBytes) {
      if (existsSync(archived)) unlinkSync(archived);
      renameSync(current, archived);
    }
    appendFileSync(current, entry);
  }

  private extractMessageContent(item: Record<string, unknown>): string {
    if (typeof item.text === 'string' && item.text) return item.text;
    if (Array.isArray(item.content)) {
      const texts: string[] = [];
      for (const part of item.content) {
        if (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string') {
          texts.push((part as { text: string }).text);
        }
      }
      if (texts.length > 0) return texts.join('\n');
    }
    return '';
  }

  readTimeline(runId: string, maxItems = 200, offset = 0): TimelinePage {
    this.assertSafeId(runId);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('INVALID_TIMELINE_OFFSET');
    }
    if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
      throw new Error('INVALID_TIMELINE_LIMIT');
    }
    const run = this.get(runId);
    const rawEventsFile = join(this.stateDir, 'runs', runId, 'harness', 'raw-events.jsonl');
    if (existsSync(rawEventsFile)) {
      try {
        const stats = statSync(rawEventsFile);
        if (!stats.isFile()) {
          throw new Error('NOT_A_FILE');
        }

        const MAX_OUTPUT_PER_COMMAND = 64 * 1024;
        const MAX_TEXT_PER_MESSAGE = 64 * 1024;
        const MAX_RAW_BYTES = 50 * 1024 * 1024;
        const MAX_LINE_LENGTH = 64 * 1024;
        const MAX_TIMELINE_EVENTS = 50_000;

        let items: Map<string, TimelineItem>;
        let order: string[];
        let historyTruncated: boolean;

        const cached = this.getCachedTimeline(runId);
        if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
          items = new Map(cached.items);
          order = [...cached.order];
          historyTruncated = cached.historyTruncated;
        } else {
          items = new Map<string, TimelineItem>();
          order = [];
          historyTruncated = stats.size > MAX_RAW_BYTES;

          const bytesToRead = Math.min(stats.size, MAX_RAW_BYTES);
          const fd = openSync(rawEventsFile, 'r');
          const chunkSize = 64 * 1024;
          const buffer = Buffer.alloc(chunkSize);
          const decoder = new StringDecoder('utf8');
          let remainder = '';
          let discardingLine = false;
          let totalBytesRead = 0;
          let eventCount = 0;

          try {
            const processLine = (line: string) => {
              if (!line.trim()) return;
              eventCount++;
              try {
                const ev = JSON.parse(line) as {
                  method?: string;
                  params?: Record<string, unknown>;
                };
                const method = ev.method ?? '';
                const params = ev.params ?? {};

                if (method === 'item/started') {
                  const item = params.item as Record<string, unknown> | undefined;
                  if (!item || typeof item.id !== 'string') return;
                  const id = truncateUtf8Bytes(item.id, 128);
                  if (!id) return;
                  const type =
                    item.type === 'commandExecution'
                      ? 'command'
                      : item.type === 'agentMessage'
                        ? 'message'
                        : item.type === 'userMessage'
                          ? order.length === 0
                            ? 'system'
                            : 'user'
                          : undefined;
                  if (!type) return;
                  const startedAt =
                    typeof params.startedAtMs === 'number'
                      ? new Date(params.startedAtMs).toISOString()
                      : new Date().toISOString();
                  const rawText = this.extractMessageContent(item);
                  const text = truncateUtf8Bytes(rawText, MAX_TEXT_PER_MESSAGE);
                  const timelineItem: TimelineItem = {
                    id,
                    type,
                    status: type === 'system' || type === 'user' ? 'completed' : 'in_progress',
                    ...(type === 'command'
                      ? {
                          command: typeof item.command === 'string' ? item.command : '',
                          cwd: typeof item.cwd === 'string' ? item.cwd : '',
                          output: '',
                        }
                      : {
                          text,
                        }),
                    startedAt,
                  };
                  items.set(id, timelineItem);
                  order.push(id);
                } else if (method === 'item/agentMessage/delta') {
                  const itemId = typeof params.itemId === 'string' ? truncateUtf8Bytes(params.itemId, 128) : undefined;
                  const delta = typeof params.delta === 'string' ? params.delta : '';
                  if (itemId && delta) {
                    const it = items.get(itemId);
                    if (it && (it.text?.length ?? 0) < MAX_TEXT_PER_MESSAGE) {
                      it.text = (it.text ?? '') + delta;
                      if (it.text.length > MAX_TEXT_PER_MESSAGE) {
                        it.text = it.text.slice(0, MAX_TEXT_PER_MESSAGE) + '\n[message truncated]';
                      }
                    }
                  }
                } else if (method === 'item/commandExecution/outputDelta') {
                  const itemId = typeof params.itemId === 'string' ? truncateUtf8Bytes(params.itemId, 128) : undefined;
                  const delta = typeof params.delta === 'string' ? params.delta : '';
                  if (itemId && delta) {
                    const it = items.get(itemId);
                    if (it && (it.output?.length ?? 0) < MAX_OUTPUT_PER_COMMAND) {
                      it.output = (it.output ?? '') + delta;
                      if (it.output.length > MAX_OUTPUT_PER_COMMAND) {
                        it.output = it.output.slice(0, MAX_OUTPUT_PER_COMMAND) + '\n[output truncated]';
                      }
                    }
                  }
                } else if (method === 'item/completed') {
                  const item = params.item as Record<string, unknown> | undefined;
                  if (!item || typeof item.id !== 'string') return;
                  const id = truncateUtf8Bytes(item.id, 128);
                  if (!id) return;
                  let it = items.get(id);
                  if (!it) {
                    const type =
                      item.type === 'commandExecution'
                        ? 'command'
                        : item.type === 'agentMessage'
                          ? 'message'
                          : item.type === 'userMessage'
                            ? order.length === 0
                              ? 'system'
                              : 'user'
                            : undefined;
                    if (!type) return;
                    it = { id, type, status: 'completed' };
                    items.set(id, it);
                    order.push(id);
                  }
                  const completedAt =
                    typeof params.completedAtMs === 'number'
                      ? new Date(params.completedAtMs).toISOString()
                      : new Date().toISOString();
                  it.completedAt = completedAt;
                  if (!it.startedAt) it.startedAt = completedAt;
                  if (it.type === 'command') {
                    const exitCode = typeof item.exitCode === 'number' ? item.exitCode : undefined;
                    it.exitCode = exitCode;
                    it.status =
                      item.status === 'failed' || (exitCode !== undefined && exitCode !== 0) ? 'failed' : 'completed';
                    if (typeof item.durationMs === 'number') it.durationMs = item.durationMs;
                    if (typeof item.command === 'string') it.command = item.command;
                    if (typeof item.cwd === 'string') it.cwd = item.cwd;
                    if (typeof item.aggregatedOutput === 'string') {
                      it.output =
                        item.aggregatedOutput.length > MAX_OUTPUT_PER_COMMAND
                          ? item.aggregatedOutput.slice(0, MAX_OUTPUT_PER_COMMAND) + '\n[output truncated]'
                          : item.aggregatedOutput;
                    }
                  } else if (it.type === 'message' || it.type === 'system' || it.type === 'user') {
                    it.status = 'completed';
                    const rawText = this.extractMessageContent(item);
                    if (rawText) it.text = truncateUtf8Bytes(rawText, MAX_TEXT_PER_MESSAGE);
                  }
                } else if (method === 'error') {
                  const err = params.error as Record<string, unknown> | undefined;
                  const errId = `err_${order.length + 1}`;
                  const message =
                    typeof err?.message === 'string'
                      ? err.message
                      : typeof params.additionalDetails === 'string'
                        ? params.additionalDetails
                        : 'Unknown worker error';
                  const timelineItem: TimelineItem = {
                    id: errId,
                    type: 'error',
                    status: 'failed',
                    text: truncateUtf8Bytes(message, MAX_TEXT_PER_MESSAGE),
                    startedAt: new Date().toISOString(),
                  };
                  items.set(errId, timelineItem);
                  order.push(errId);
                }
              } catch {
                // Ignore malformed line
              }
            };

            while (totalBytesRead < bytesToRead && eventCount < MAX_TIMELINE_EVENTS) {
              const toRead = Math.min(chunkSize, bytesToRead - totalBytesRead);
              const bytesRead = readSync(fd, buffer, 0, toRead, totalBytesRead);
              if (bytesRead === 0) break;
              totalBytesRead += bytesRead;

              const chunkStr = decoder.write(buffer.subarray(0, bytesRead));
              let combined = remainder + chunkStr;
              remainder = '';

              if (discardingLine) {
                const newlineIdx = combined.indexOf('\n');
                if (newlineIdx === -1) {
                  continue;
                }
                combined = combined.slice(newlineIdx + 1);
                discardingLine = false;
              }

              const parts = combined.split('\n');
              remainder = parts.pop() ?? '';

              if (Buffer.byteLength(remainder, 'utf8') > MAX_LINE_LENGTH) {
                historyTruncated = true;
                discardingLine = true;
                remainder = '';
              }

              for (const line of parts) {
                if (eventCount >= MAX_TIMELINE_EVENTS) {
                  historyTruncated = true;
                  break;
                }
                if (Buffer.byteLength(line, 'utf8') > MAX_LINE_LENGTH) {
                  historyTruncated = true;
                  continue;
                }
                processLine(line);
              }
            }

            const flushed = decoder.end();
            if (flushed && !discardingLine) {
              remainder += flushed;
            }

            if (totalBytesRead >= MAX_RAW_BYTES || eventCount >= MAX_TIMELINE_EVENTS) {
              historyTruncated = true;
            }

            if (remainder.trim().length > 0) {
              historyTruncated = true;
              remainder = '';
            }
          } finally {
            closeSync(fd);
          }

          this.setCachedTimeline(runId, {
            mtimeMs: stats.mtimeMs,
            size: stats.size,
            items: new Map(items),
            order: [...order],
            historyTruncated,
          });
        }

        if (run?.steeringMessages && run.steeringMessages.length > 0) {
          for (const sm of run.steeringMessages) {
            if (!items.has(sm.id)) {
              items.set(sm.id, {
                id: sm.id,
                type: 'user',
                status: sm.status === 'failed' ? 'failed' : 'completed',
                text: truncateUtf8Bytes(sm.message, MAX_TEXT_PER_MESSAGE),
                startedAt: sm.queuedAt || sm.sentAt,
                completedAt: sm.sentAt,
              });
              order.push(sm.id);
            }
          }
        }
        if (order.length > 0) {
          const allItems = order.map((id) => items.get(id)!);
          const total = allItems.length;
          const rawPaged = allItems.slice(offset, offset + maxItems);
          return this.paginateTimelineItems(rawPaged, total, offset, historyTruncated);
        }
        return { items: [], total: 0, hasMore: false, historyTruncated };
      } catch (cause) {
        if (
          cause instanceof Error &&
          (cause.message === 'INVALID_TIMELINE_OFFSET' || cause.message === 'INVALID_TIMELINE_LIMIT')
        ) {
          throw cause;
        }
        // Fall back to sqlite messages on read error
      }
    }

    // Fallback: SQLite messages table
    const countRow = this.db.prepare('SELECT COUNT(*) as count FROM messages WHERE run_id = ?').get(runId) as
      { count: number } | undefined;
    const total = countRow?.count ?? 0;
    const rows = this.db
      .prepare('SELECT seq, ts, text, truncated FROM messages WHERE run_id = ? ORDER BY seq ASC LIMIT ? OFFSET ?')
      .all(runId, maxItems, offset) as Array<{ seq: number; ts: string; text: string; truncated: number }>;
    const rawPaged: TimelineItem[] = rows.map((msg) => ({
      id: `msg_${msg.seq}`,
      type: 'message' as const,
      status: 'completed' as const,
      text: msg.text,
      startedAt: msg.ts,
      completedAt: msg.ts,
    }));
    return this.paginateTimelineItems(rawPaged, total, offset, true);
  }

  private paginateTimelineItems(
    rawPaged: TimelineItem[],
    total: number,
    offset: number,
    initialTruncated: boolean,
  ): TimelinePage {
    const MAX_PAGE_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MiB response cap
    // Reserve headroom for envelope properties in readTimeline and monitor wrapper
    const ENVELOPE_HEADROOM_BYTES = 2048;
    const ITEM_BUDGET = MAX_PAGE_RESPONSE_BYTES - ENVELOPE_HEADROOM_BYTES;

    let encodedBytes = 0;
    const paged: TimelineItem[] = [];
    let responseTruncated = false;

    for (let i = 0; i < rawPaged.length; i++) {
      let it = rawPaged[i]!;
      let itJson = JSON.stringify(it);
      let itBytes = Buffer.byteLength(itJson, 'utf8') + 1; // +1 for comma separator in JSON array

      if (encodedBytes + itBytes > ITEM_BUDGET) {
        if (paged.length === 0) {
          // A single item exceeds the entire budget. Truncate this item so pagination does not stall.
          responseTruncated = true;
          const maxContentBytes = Math.max(512, ITEM_BUDGET - 1024);
          if (it.text) {
            it = { ...it, text: truncateUtf8Bytes(it.text, maxContentBytes) + '\n[message truncated]' };
          } else if (it.output) {
            it = { ...it, output: truncateUtf8Bytes(it.output, maxContentBytes) + '\n[output truncated]' };
          } else if (it.command) {
            it = { ...it, command: truncateUtf8Bytes(it.command, maxContentBytes) + ' [truncated]' };
          }
          itJson = JSON.stringify(it);
          itBytes = Buffer.byteLength(itJson, 'utf8') + 1;
          paged.push(it);
          encodedBytes += itBytes;
        } else {
          responseTruncated = true;
          break;
        }
      } else {
        paged.push(it);
        encodedBytes += itBytes;
      }
    }

    const hasMore = offset + paged.length < total;
    return {
      items: paged,
      total,
      hasMore,
      historyTruncated: initialTruncated || responseTruncated,
    };
  }

  /**
   * Bounded single-pass stream analyzer over raw run events.
   * Computes command counts, failure counts, and collects bounded samples
   * and recent blockers across the run. When historyTruncated is true,
   * counts represent observed lower bounds up to the processing limits.
   */
  async analyzeTimeline(runId: string): Promise<RunTimelineAnalysis> {
    this.assertSafeId(runId);
    const run = this.get(runId);
    const rawEventsFile = join(this.stateDir, 'runs', runId, 'harness', 'raw-events.jsonl');

    const MAX_RAW_BYTES = 50 * 1024 * 1024; // 50MB
    const MAX_LINE_LENGTH = 64 * 1024; // 64KB
    const MAX_EVENTS = 50_000;

    let totalCommandsCount = 0;
    let failedCommandsCount = 0;
    let timelineItemsAnalyzed = 0;
    let historyTruncated = false;

    const commandsMap = new Map<string, { command: string; status: string; exitCode?: number; output: string }>();
    const commandOrder: string[] = [];
    const completedCommandIds = new Set<string>();
    const recentFailures: Array<{ command: string; exitCode: number; error: string }> = [];

    if (existsSync(rawEventsFile)) {
      let fd: number | undefined;
      try {
        const stats = statSync(rawEventsFile);
        if (!stats.isFile()) {
          return {
            commandsCount: 0,
            failedCommandsCount: 0,
            timelineItemsAnalyzed: 0,
            historyTruncated: true,
            sampleCommands: [],
            keyBlockers: [],
          };
        }
        if (stats.size > MAX_RAW_BYTES) {
          historyTruncated = true;
        }

        const bytesToRead = Math.min(stats.size, MAX_RAW_BYTES);
        fd = openSync(rawEventsFile, 'r');
        const chunkSize = 64 * 1024;
        const buffer = Buffer.alloc(chunkSize);
        const decoder = new StringDecoder('utf8');
        let remainder = '';
        let discardingLine = false;
        let totalBytesRead = 0;

        const processLine = (line: string) => {
          if (!line.trim()) return;
          timelineItemsAnalyzed++;
          try {
            const ev = JSON.parse(line) as {
              method?: string;
              params?: Record<string, unknown>;
            };
            const method = ev.method ?? '';
            const params = ev.params ?? {};

            if (method === 'item/started') {
              const item = params.item as Record<string, unknown> | undefined;
              if (item && item.type === 'commandExecution' && typeof item.id === 'string') {
                const rawCmd = typeof item.command === 'string' ? item.command : 'command';
                const cmd = truncateUtf8Bytes(rawCmd, 512);
                if (!commandsMap.has(item.id)) {
                  totalCommandsCount++;
                  commandOrder.push(item.id);
                }
                commandsMap.set(item.id, { command: cmd, status: 'in_progress', output: '' });
              }
            } else if (method === 'item/commandExecution/outputDelta') {
              const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
              const delta = typeof params.delta === 'string' ? params.delta : '';
              if (itemId && delta && commandsMap.has(itemId)) {
                const entry = commandsMap.get(itemId)!;
                entry.output = (entry.output + delta).slice(-500);
              }
            } else if (method === 'item/completed') {
              const item = params.item as Record<string, unknown> | undefined;
              if (item && typeof item.id === 'string') {
                if (item.type === 'commandExecution' || commandsMap.has(item.id)) {
                  if (!commandsMap.has(item.id)) {
                    totalCommandsCount++;
                    commandOrder.push(item.id);
                    const rawCmd = typeof item.command === 'string' ? item.command : 'command';
                    commandsMap.set(item.id, {
                      command: truncateUtf8Bytes(rawCmd, 512),
                      status: 'completed',
                      output: '',
                    });
                  }
                  const entry = commandsMap.get(item.id)!;
                  const exitCode = typeof item.exitCode === 'number' ? item.exitCode : undefined;
                  entry.exitCode = exitCode;
                  const isFailed = item.status === 'failed' || (exitCode !== undefined && exitCode !== 0);
                  entry.status = isFailed ? 'failed' : 'completed';

                  if (!completedCommandIds.has(item.id)) {
                    completedCommandIds.add(item.id);
                    if (isFailed) {
                      failedCommandsCount++;
                      const out =
                        typeof item.aggregatedOutput === 'string' && item.aggregatedOutput
                          ? item.aggregatedOutput
                          : entry.output;
                      const errSnippet = truncateUtf8Bytes(out.trim().slice(-300), 300);
                      recentFailures.push({ command: entry.command, exitCode: exitCode ?? 1, error: errSnippet });
                      if (recentFailures.length > 10) recentFailures.shift();
                    }
                  }
                }
              }
            } else if (method === 'error') {
              const err = params.error as Record<string, unknown> | undefined;
              const rawMessage =
                typeof err?.message === 'string'
                  ? err.message
                  : typeof params.additionalDetails === 'string'
                    ? params.additionalDetails
                    : 'Unknown worker error';
              const message = truncateUtf8Bytes(rawMessage, 300);
              recentFailures.push({ command: 'worker_error', exitCode: 1, error: message });
              if (recentFailures.length > 10) recentFailures.shift();
            }
          } catch {
            // Ignore malformed line
          }
        };

        while (totalBytesRead < bytesToRead && timelineItemsAnalyzed < MAX_EVENTS) {
          const toRead = Math.min(chunkSize, bytesToRead - totalBytesRead);
          const bytesRead = readSync(fd, buffer, 0, toRead, totalBytesRead);
          if (bytesRead === 0) break;
          totalBytesRead += bytesRead;

          const chunkStr = decoder.write(buffer.subarray(0, bytesRead));
          let combined = remainder + chunkStr;
          remainder = '';

          if (discardingLine) {
            const newlineIdx = combined.indexOf('\n');
            if (newlineIdx === -1) {
              continue;
            }
            combined = combined.slice(newlineIdx + 1);
            discardingLine = false;
          }

          const parts = combined.split('\n');
          remainder = parts.pop() ?? '';

          if (Buffer.byteLength(remainder, 'utf8') > MAX_LINE_LENGTH) {
            historyTruncated = true;
            discardingLine = true;
            remainder = '';
          }

          for (const line of parts) {
            if (timelineItemsAnalyzed >= MAX_EVENTS) {
              historyTruncated = true;
              break;
            }
            if (Buffer.byteLength(line, 'utf8') > MAX_LINE_LENGTH) {
              historyTruncated = true;
              continue;
            }
            processLine(line);
          }
        }

        const flushed = decoder.end();
        if (flushed && !discardingLine) {
          remainder += flushed;
        }

        if (totalBytesRead >= MAX_RAW_BYTES || timelineItemsAnalyzed >= MAX_EVENTS) {
          historyTruncated = true;
        }

        if (remainder.trim().length > 0) {
          historyTruncated = true;
          remainder = '';
        }
      } catch {
        historyTruncated = true;
      } finally {
        if (fd !== undefined) {
          try {
            closeSync(fd);
          } catch {
            // ignore
          }
        }
      }
    }

    if (run?.steeringMessages && run.steeringMessages.length > 0) {
      timelineItemsAnalyzed += run.steeringMessages.length;
    }

    if (timelineItemsAnalyzed === 0) {
      const countRow = this.db.prepare('SELECT COUNT(*) as count FROM messages WHERE run_id = ?').get(runId) as
        { count: number } | undefined;
      timelineItemsAnalyzed = (countRow?.count ?? 0) + (run?.steeringMessages?.length ?? 0);
    }

    // Sample up to 15 commands evenly across the run
    const sampleCommands: Array<{ command: string; status: string }> = [];
    if (commandOrder.length <= 15) {
      for (const id of commandOrder) {
        const c = commandsMap.get(id);
        if (c) sampleCommands.push({ command: c.command, status: c.status });
      }
    } else {
      const step = Math.max(1, Math.floor(commandOrder.length / 15));
      for (let i = 0; i < commandOrder.length && sampleCommands.length < 15; i += step) {
        const id = commandOrder[i];
        if (id) {
          const c = commandsMap.get(id);
          if (c) sampleCommands.push({ command: c.command, status: c.status });
        }
      }
    }

    const keyBlockers = recentFailures.map((f) => `${f.command} (exit ${f.exitCode})${f.error ? `: ${f.error}` : ''}`);

    return {
      commandsCount: totalCommandsCount,
      failedCommandsCount,
      timelineItemsAnalyzed,
      historyTruncated,
      sampleCommands,
      keyBlockers,
    };
  }

  readDiffs(runId: string): RunDiffsResponse | undefined {
    this.assertSafeId(runId);
    const run = this.get(runId);
    if (!run) return undefined;

    const revision = run.changeSet?.revision ?? 0;
    const repositories: RunDiffsRepositorySummary[] = [];
    const files: FileDiffItem[] = [];
    const rawPatches: string[] = [];

    const MAX_PATCH_BYTES = 10 * 1024 * 1024;
    const MAX_AGGREGATE_DIFF_BYTES = 20 * 1024 * 1024;
    let totalDiffBytes = 0;
    let aggregateTruncated = false;

    if (run.changeSet && Array.isArray(run.changeSet.repositories)) {
      for (const repo of run.changeSet.repositories) {
        let patchType: 'exact_full' | 'delta' | 'unavailable' = 'unavailable';
        let patchTruncated = false;
        let patchContent = '';

        const fullPatchPath = join(
          this.stateDir,
          'container-agents',
          run.agentId,
          'patches',
          `revision-${run.changeSet.revision}`,
          `${repo.repository}.full.patch`,
        );
        const deltaPatchPath = join(
          this.stateDir,
          'container-agents',
          run.agentId,
          'patches',
          `revision-${run.changeSet.revision}`,
          `${repo.repository}.delta.patch`,
        );

        const hasFull = existsSync(fullPatchPath);
        const hasDelta = !hasFull && existsSync(deltaPatchPath);
        const patchPath = hasFull ? fullPatchPath : hasDelta ? deltaPatchPath : undefined;
        if (hasFull) patchType = 'exact_full';
        else if (hasDelta) patchType = 'delta';

        if (patchPath) {
          try {
            const patchStat = statSync(patchPath);
            if (patchStat.isFile()) {
              const remainingBudget = Math.max(0, MAX_AGGREGATE_DIFF_BYTES - totalDiffBytes);
              if (remainingBudget === 0) {
                patchTruncated = true;
                aggregateTruncated = true;
              } else if (patchStat.size > remainingBudget) {
                const fd = openSync(patchPath, 'r');
                const buf = Buffer.alloc(remainingBudget);
                const bytesRead = readSync(fd, buf, 0, remainingBudget, 0);
                closeSync(fd);
                patchContent = truncateUtf8Bytes(buf.toString('utf8', 0, bytesRead), remainingBudget);
                patchTruncated = true;
                aggregateTruncated = true;
              } else if (patchStat.size > MAX_PATCH_BYTES) {
                const fd = openSync(patchPath, 'r');
                const buf = Buffer.alloc(MAX_PATCH_BYTES);
                const bytesRead = readSync(fd, buf, 0, MAX_PATCH_BYTES, 0);
                closeSync(fd);
                patchContent = truncateUtf8Bytes(buf.toString('utf8', 0, bytesRead), MAX_PATCH_BYTES);
                patchTruncated = true;
              } else {
                patchContent = readFileSync(patchPath, 'utf8');
              }
            }
          } catch {
            // ignore
          }
        }

        repositories.push({
          repository: repo.repository,
          changed_paths: Array.isArray(repo.changed_paths) ? repo.changed_paths.length : 0,
          additions: repo.additions ?? 0,
          deletions: repo.deletions ?? 0,
          patch_type: patchType,
          ...(patchTruncated ? { patch_truncated: true } : {}),
        });

        if (patchContent) {
          const patchBytes = Buffer.byteLength(patchContent, 'utf8');
          totalDiffBytes += patchBytes;
          rawPatches.push(patchContent);

          const parsedFiles = this.parseUnifiedDiff(patchContent, repo.repository);
          for (const pf of parsedFiles) {
            const fBytes = Buffer.byteLength(pf.diff, 'utf8');
            if (totalDiffBytes + fBytes > MAX_AGGREGATE_DIFF_BYTES) {
              aggregateTruncated = true;
              const fRemaining = Math.max(0, MAX_AGGREGATE_DIFF_BYTES - totalDiffBytes);
              if (fRemaining > 64) {
                const truncatedDiff = truncateUtf8Bytes(pf.diff, fRemaining);
                totalDiffBytes += Buffer.byteLength(truncatedDiff, 'utf8');
                files.push({ ...pf, diff: truncatedDiff });
              }
              break;
            }
            totalDiffBytes += fBytes;
            files.push(pf);
          }
        } else if (Array.isArray(repo.changed_paths)) {
          for (const p of repo.changed_paths) {
            if (totalDiffBytes >= MAX_AGGREGATE_DIFF_BYTES) {
              aggregateTruncated = true;
              break;
            }
            const fallbackDiff = `diff --git a/${p} b/${p}\n(No diff captured for revision ${revision})`;
            const diffBytes = Buffer.byteLength(fallbackDiff, 'utf8');
            if (totalDiffBytes + diffBytes > MAX_AGGREGATE_DIFF_BYTES) {
              aggregateTruncated = true;
              break;
            }
            totalDiffBytes += diffBytes;
            files.push({
              path: p,
              repository: repo.repository,
              status: 'modified',
              additions: 0,
              deletions: 0,
              diff: fallbackDiff,
            });
          }
        }
      }
    }

    // Also include filesChanged from run.result if not already present and under budget
    if (run.result && Array.isArray(run.result.filesChanged)) {
      const defaultRepo = repositories[0]?.repository ?? 'default';
      for (const fc of run.result.filesChanged) {
        if (totalDiffBytes >= MAX_AGGREGATE_DIFF_BYTES) {
          aggregateTruncated = true;
          break;
        }
        if (!files.some((f) => f.path === fc && f.repository === defaultRepo)) {
          const fallbackDiff = `diff --git a/${fc} b/${fc}\n(Reported by worker in final summary)`;
          const diffBytes = Buffer.byteLength(fallbackDiff, 'utf8');
          if (totalDiffBytes + diffBytes > MAX_AGGREGATE_DIFF_BYTES) {
            aggregateTruncated = true;
            break;
          }
          totalDiffBytes += diffBytes;
          files.push({
            path: fc,
            repository: defaultRepo,
            status: 'modified',
            additions: 0,
            deletions: 0,
            diff: fallbackDiff,
          });
        }
      }
    }

    const patchTypes = new Set(repositories.map((r) => r.patch_type));
    const overallPatchType: 'exact_full' | 'delta' | 'mixed' | 'unavailable' =
      patchTypes.size === 0 ? 'unavailable' : patchTypes.size === 1 ? [...patchTypes][0]! : 'mixed';

    const report = run.result
      ? {
          status: run.result.reportStatus,
          summary: run.result.summary,
          verification: (run.result.verification ?? []).map((v) => ({ name: v.name, status: v.status })),
          unresolved_risks: run.result.unresolvedRisks ?? [],
          files_changed: run.result.filesChanged ?? [],
          report_excerpt: run.result.reportExcerpt,
        }
      : undefined;

    const response: RunDiffsResponse = {
      run_id: runId,
      agent_id: run.agentId,
      revision,
      repositories,
      files,
      raw_patch: rawPatches.join('\n\n'),
      patch_type: overallPatchType,
      truncated: aggregateTruncated || repositories.some((r) => r.patch_truncated),
      summary: run.result?.summary,
      report,
    };

    // Strict final serialized budget guard
    let serialized = JSON.stringify(response);
    let serializedBytes = Buffer.byteLength(serialized, 'utf8');
    if (serializedBytes > MAX_AGGREGATE_DIFF_BYTES) {
      response.truncated = true;
      while (serializedBytes > MAX_AGGREGATE_DIFF_BYTES && response.files.length > 0) {
        response.files.pop();
        serialized = JSON.stringify(response);
        serializedBytes = Buffer.byteLength(serialized, 'utf8');
      }
      if (serializedBytes > MAX_AGGREGATE_DIFF_BYTES && response.raw_patch) {
        const overage = serializedBytes - MAX_AGGREGATE_DIFF_BYTES;
        const targetLen = Math.max(0, Buffer.byteLength(response.raw_patch, 'utf8') - overage - 100);
        response.raw_patch = truncateUtf8Bytes(response.raw_patch, targetLen);
      }
    }

    return response;
  }

  private parseUnifiedDiff(rawDiff: string, repository: string): FileDiffItem[] {
    if (!rawDiff || !rawDiff.trim()) return [];
    const files: FileDiffItem[] = [];
    const chunks = rawDiff.split(/(?=^diff --git )/m).filter(Boolean);
    for (const chunk of chunks) {
      const lines = chunk.split('\n');
      const headerLine = lines[0] || '';
      const match = /^diff --git\s+a\/(.*?)\s+b\/(.*?)$/.exec(headerLine.trim());
      const oldPath = match ? match[1] : '';
      const newPath = match ? match[2] : '';
      let path = newPath && newPath !== '/dev/null' ? newPath : oldPath;
      if (!path) {
        for (const l of lines) {
          if (!l) continue;
          if (l.startsWith('+++ b/')) {
            path = l.slice(6).trim();
            break;
          } else if (l.startsWith('--- a/')) {
            path = l.slice(6).trim();
          }
        }
      }
      if (!path) path = 'unknown';

      let status: 'added' | 'deleted' | 'modified' | 'renamed' = 'modified';
      if (chunk.includes('new file mode') || chunk.includes('--- /dev/null')) {
        status = 'added';
      } else if (chunk.includes('deleted file mode') || chunk.includes('+++ /dev/null')) {
        status = 'deleted';
      } else if (chunk.includes('similarity index') || chunk.includes('rename to')) {
        status = 'renamed';
      }

      let additions = 0;
      let deletions = 0;
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        if (line.startsWith('+') && !line.startsWith('+++')) {
          additions++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          deletions++;
        }
      }

      files.push({
        path,
        repository,
        status,
        additions,
        deletions,
        diff: chunk.trimEnd(),
      });
    }
    return files;
  }
}
export function emptyResult(): Result {
  return {
    reportStatus: 'missing',
    summary: 'Worker finished without a structured final report.',
    filesChanged: [],
    verification: [],
    unresolvedRisks: [],
    requiresUserAction: false,
    identityVerified: false,
  };
}
