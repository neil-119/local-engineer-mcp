import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { Result, Run, RunStatus } from './domain.js';

export const MAX_MESSAGE_TEXT = 8000;
export const MAX_MESSAGES_PER_RUN = 1000;

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
  ) {
    super();
    mkdirSync(join(stateDir, 'runs'), { recursive: true });
    mkdirSync(join(stateDir, 'logs'), { recursive: true });
    this.db = new DatabaseSync(join(stateDir, 'state.db'));
    this.db.exec(
      'PRAGMA journal_mode=WAL; ' +
        'CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, json TEXT NOT NULL); ' +
        'CREATE TABLE IF NOT EXISTS messages (' +
        'seq INTEGER PRIMARY KEY AUTOINCREMENT, ' +
        'run_id TEXT NOT NULL, item_id TEXT NOT NULL, ts TEXT NOT NULL, ' +
        'text TEXT NOT NULL, truncated INTEGER NOT NULL DEFAULT 0, ' +
        'UNIQUE (run_id, item_id))',
    );
  }
  add(run: Run): void {
    this.db.prepare('INSERT INTO runs VALUES (?, ?)').run(run.runId, JSON.stringify(run));
    this.persist(run, 'run.queued');
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
  captureMessage(runId: string, itemId: string, ts: string, text: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO messages (run_id, item_id, ts, text, truncated) VALUES (?, ?, ?, ?, ?)')
      .run(runId, itemId, ts, text.slice(0, MAX_MESSAGE_TEXT), text.length > MAX_MESSAGE_TEXT ? 1 : 0);
    this.pruneMessages(runId);
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
  close(): void {
    this.db.close();
  }
  update(id: string, update: Partial<Run>, event: string): Run {
    const current = this.get(id);
    if (!current) throw new Error('RUN_NOT_FOUND');
    const next = { ...current, ...update };
    this.db.prepare('UPDATE runs SET json=? WHERE run_id=?').run(JSON.stringify(next), id);
    this.persist(next, event);
    this.emit(`run:${id}`, next);
    this.emit('change', next);
    return next;
  }
  setStatus(id: string, status: RunStatus, extras: Partial<Run> = {}): Run {
    return this.update(id, { ...extras, status }, `run.${status}`);
  }
  tryStart(id: string, serverLimit: number, workerLimit: number, extras: Partial<Run> = {}): Run | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare('SELECT json FROM runs').all() as Array<{ json: string }>;
      const runs = rows.map((row) => JSON.parse(row.json) as Run);
      const current = runs.find((run) => run.runId === id);
      const active = runs.filter((run) => ['starting', 'running', 'cancel_requested'].includes(run.status));
      if (
        !current ||
        current.status !== 'queued' ||
        active.length >= serverLimit ||
        active.filter((run) => run.worker === current.worker).length >= workerLimit
      ) {
        this.db.exec('COMMIT');
        return undefined;
      }
      const next = { ...current, ...extras, status: 'starting' as const };
      this.db.prepare('UPDATE runs SET json=? WHERE run_id=?').run(JSON.stringify(next), id);
      this.db.exec('COMMIT');
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
  private persist(run: Run, event: string): void {
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
}
export const emptyResult = (): Result => ({
  reportStatus: 'missing',
  summary: 'Worker finished without a structured final report.',
  filesChanged: [],
  verification: [],
  unresolvedRisks: [],
  requiresUserAction: false,
  identityVerified: false,
});
