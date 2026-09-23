#!/usr/bin/env node
/**
 * cross-process-worker.mjs
 *
 * Child-process worker for the genuine cross-process Windows smoke test.
 * Runs under a plain `node` process against the compiled dist/store.js.
 *
 * Usage: node scripts/cross-process-worker.mjs --role=<role> --state-dir=<dir> [--run-id=<id>] [--fence=<n>]
 *
 * Roles:
 *   setup          – add a run with a 1-second lease and tryStart it; prints runId+fenceToken
 *   ingest-event   – attempt ingestEvent with the given runId+fence; prints "ingested" or "rejected"
 *   reconcile      – call reconcileStaleRuns (no time override, just wait for real expiry); prints recoveryRunIds
 *   check-state    – read and print the run's status and fenceToken from the DB
 *   assert-safe-id – attempt add() with a crafted traversal runId; expects INVALID_RUN_ID error
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distStore = pathToFileURL(join(__dirname, '..', 'dist', 'store.js')).href;

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.join('=')];
  }),
);

const role = args['role'];
const stateDir = args['state-dir'];
const runId = args['run-id'];
const fence = args['fence'] ? parseInt(args['fence'], 10) : undefined;

if (!role || !stateDir) {
  process.stderr.write('Missing --role or --state-dir\n');
  process.exit(1);
}

mkdirSync(stateDir, { recursive: true });

const { RunStore, emptyResult } = await import(distStore);

const pid = process.pid;
const ownerId = `owner_proc_${pid}`;

function buildRun(id) {
  const now = new Date().toISOString();
  return {
    runId: id,
    agentId: `agt_smoke`,
    ownerId,
    fenceToken: 1,
    title: 'Smoke Test Run',
    task: 'cross-process smoke',
    workingDirectory: stateDir,
    worker: 'local-container',
    status: 'queued',
    continuationIndex: 0,
    createdAt: now,
    requiresUserAction: false,
    diagnostics: { last_phase: 'queued', last_activity_at: now },
    result: emptyResult(),
  };
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

try {
  if (role === 'setup') {
    // Lease of 1 second so it expires quickly
    const id = runId ?? `run_smoke_${randomBytes(6).toString('base64url')}`;
    const store = new RunStore(stateDir);
    const run = buildRun(id);
    store.add(run, 1_000); // 1-second lease
    const started = store.tryStart(id, 10, 10, ownerId, {}, 1, 1_000);
    store.close();
    out({ ok: true, runId: id, fenceToken: started?.fenceToken ?? 1, ownerId });
  } else if (role === 'ingest-event') {
    if (!runId || fence === undefined) throw new Error('Missing --run-id or --fence');
    const store = new RunStore(stateDir);
    const raw = JSON.stringify({ method: 'item/completed', params: { threadId: 'th1', turnId: 'turn1', item: { type: 'agentMessage', id: 'msg1', text: 'hello' } } });
    const result = store.ingestEvent(
      runId,
      { raw: raw + '\n', message: { itemId: 'msg1', ts: new Date().toISOString(), text: 'hello' } },
      { ownerId, expectedFenceToken: fence },
    );
    store.close();
    out({ ok: true, ingested: result !== undefined, status: result?.status });
  } else if (role === 'reconcile') {
    const store = new RunStore(stateDir);
    const result = store.reconcileStaleRuns({ ownerId, leaseDurationMs: 1_000 });
    store.close();
    out({ ok: true, reconciledCount: result.reconciledCount, reconciledRunIds: result.reconciledRunIds, recoveryRunIds: result.recoveryRunIds });
  } else if (role === 'check-state') {
    if (!runId) throw new Error('Missing --run-id');
    const store = new RunStore(stateDir);
    const run = store.get(runId);
    store.close();
    out({ ok: true, status: run?.status, fenceToken: run?.fenceToken, recovery: run?.recovery });
  } else if (role === 'assert-safe-id') {
    const store = new RunStore(stateDir);
    try {
      const maliciousRun = buildRun('../../../evil');
      store.add(maliciousRun, 1_000);
      store.close();
      out({ ok: false, error: 'Expected INVALID_RUN_ID but no error was thrown' });
    } catch (e) {
      store.close();
      const caught = e instanceof Error ? e.message : String(e);
      out({ ok: caught.startsWith('INVALID_RUN_ID'), caught });
    }
  } else {
    throw new Error(`Unknown role: ${role}`);
  }
} catch (e) {
  out({ ok: false, error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
}
