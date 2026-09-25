import { DatabaseSync } from 'node:sqlite';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { AgentOperation, Result, Run, RunStatus } from './domain.js';
import { terminalStatuses } from './domain.js';

export const MAX_MESSAGE_TEXT = 8000;
export const MAX_MESSAGES_PER_RUN = 1000;

export interface TimelineItem {
  id: string;
  type: 'message' | 'command' | 'error';
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

export class RunStore extends EventEmitter {
  private readonly db: DatabaseSync;
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
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
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

      const next = { ...current, ...update };
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
      if (prior.agentId !== claimed.agentId || !['ready_for_review', 'superseded'].includes(prior.status)) {
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
  readTimeline(runId: string, maxItems = 200): TimelineItem[] {
    this.assertSafeId(runId);
    const rawEventsFile = join(this.stateDir, 'runs', runId, 'harness', 'raw-events.jsonl');
    if (existsSync(rawEventsFile)) {
      try {
        const content = readFileSync(rawEventsFile, 'utf8');
        const lines = content.split('\n');
        const items = new Map<string, TimelineItem>();
        const order: string[] = [];
        const MAX_OUTPUT_PER_COMMAND = 64 * 1024;

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line) as {
              method?: string;
              params?: Record<string, unknown>;
            };
            const method = ev.method ?? '';
            const params = ev.params ?? {};

            if (method === 'item/started') {
              const item = params.item as Record<string, unknown> | undefined;
              if (!item || typeof item.id !== 'string') continue;
              const id = item.id;
              const type =
                item.type === 'commandExecution' ? 'command' : item.type === 'agentMessage' ? 'message' : undefined;
              if (!type) continue;
              const startedAt =
                typeof params.startedAtMs === 'number'
                  ? new Date(params.startedAtMs).toISOString()
                  : new Date().toISOString();
              const timelineItem: TimelineItem = {
                id,
                type,
                status: 'in_progress',
                ...(type === 'command'
                  ? {
                      command: typeof item.command === 'string' ? item.command : '',
                      cwd: typeof item.cwd === 'string' ? item.cwd : '',
                      output: '',
                    }
                  : {
                      text: typeof item.text === 'string' ? item.text : '',
                    }),
                startedAt,
              };
              items.set(id, timelineItem);
              order.push(id);
            } else if (method === 'item/agentMessage/delta') {
              const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
              const delta = typeof params.delta === 'string' ? params.delta : '';
              if (itemId && delta) {
                const it = items.get(itemId);
                if (it) it.text = (it.text ?? '') + delta;
              }
            } else if (method === 'item/commandExecution/outputDelta') {
              const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
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
              if (!item || typeof item.id !== 'string') continue;
              const id = item.id;
              let it = items.get(id);
              if (!it) {
                const type =
                  item.type === 'commandExecution' ? 'command' : item.type === 'agentMessage' ? 'message' : undefined;
                if (!type) continue;
                it = { id, type, status: 'completed' };
                items.set(id, it);
                order.push(id);
              }
              const completedAt =
                typeof params.completedAtMs === 'number'
                  ? new Date(params.completedAtMs).toISOString()
                  : new Date().toISOString();
              it.completedAt = completedAt;
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
              } else if (it.type === 'message') {
                it.status = 'completed';
                if (typeof item.text === 'string') it.text = item.text;
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
                text: message,
                startedAt: new Date().toISOString(),
              };
              items.set(errId, timelineItem);
              order.push(errId);
            }
          } catch {
            // Ignore malformed line
          }
        }
        if (order.length > 0) {
          const result = order.map((id) => items.get(id)!);
          return result.slice(-maxItems);
        }
      } catch {
        // Fall back to sqlite messages on read error
      }
    }

    // Fallback: SQLite messages table
    const page = this.listMessagesPage(runId, maxItems);
    return page.messages.reverse().map((msg, index) => ({
      id: `msg_${msg.seq || index}`,
      type: 'message' as const,
      status: 'completed' as const,
      text: msg.text,
      startedAt: msg.ts,
      completedAt: msg.ts,
    }));
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
