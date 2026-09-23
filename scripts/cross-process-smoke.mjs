#!/usr/bin/env node
/**
 * cross-process-smoke.mjs
 *
 * Genuine separate-OS-process Windows smoke: proves that SQLite WAL-mode fencing,
 * lease expiry, ingestEvent suppression, and the path-traversal guard all work
 * correctly when the store is shared across two real Node.js processes.
 *
 * Prerequisites:  pnpm build  (produces dist/store.js)
 * Run:            node scripts/cross-process-smoke.mjs
 * Exit 0 = all assertions pass; exit 1 = at least one failure.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerScript = join(__dirname, 'cross-process-worker.mjs');

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    process.stdout.write(`  ✓ ${label}\n`);
    passed++;
  } else {
    process.stdout.write(`  ✗ ${label}${detail ? `  →  ${detail}` : ''}\n`);
    failed++;
  }
}

function worker(stateDir, role, extra = {}) {
  const args = [
    workerScript,
    `--role=${role}`,
    `--state-dir=${stateDir}`,
    ...Object.entries(extra).map(([k, v]) => `--${k}=${v}`),
  ];
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  const stdout = result.stdout.trim();
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`Worker (${role}) stdout not JSON: ${stdout}\nstderr: ${result.stderr}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --------------------------------------------------------------------------
// Test 1: Cross-process lease expiry + ingestEvent fence suppression
// --------------------------------------------------------------------------
process.stdout.write('\nTest 1: Cross-process lease expiry → ingestEvent silently suppressed\n');
{
  const stateDir = mkdtempSync(join(tmpdir(), 'le-smoke-t1-'));
  try {
    // Process A: setup — creates and starts a run with 1-second lease
    const setup = worker(stateDir, 'setup');
    assert('Process A: setup succeeded', setup.ok, JSON.stringify(setup));
    assert('Process A: run in starting state', setup.fenceToken === 2, `fenceToken=${setup.fenceToken}`);

    const runId = setup.runId;
    const startingFence = setup.fenceToken; // fenceToken=2 after tryStart

    // Wait for the 1-second lease to actually expire (real wall-clock time)
    await sleep(1_300);

    // Process B: reconcile — scans for stale leases, advances fenceToken
    const reconcile = worker(stateDir, 'reconcile');
    assert('Process B: reconcile succeeded', reconcile.ok, JSON.stringify(reconcile));
    assert('Process B: one run reconciled', reconcile.reconciledCount === 1, `count=${reconcile.reconciledCount}`);
    assert('Process B: target run in reconciled list', reconcile.reconciledRunIds.includes(runId));

    // Check that the run is now recovery_required (not yet terminal — slot still held)
    const stateAfterReconcile = worker(stateDir, 'check-state', { 'run-id': runId });
    assert('Run is recovery_required after reconcile', stateAfterReconcile.status === 'recovery_required', `status=${stateAfterReconcile.status}`);
    assert('Run fenceToken advanced past starting token', (stateAfterReconcile.fenceToken ?? 1) > startingFence, `fenceToken=${stateAfterReconcile.fenceToken}`);

    // Process A: attempt ingestEvent with the stale fence token from before reconciliation
    const ingest = worker(stateDir, 'ingest-event', { 'run-id': runId, fence: startingFence });
    assert('Process A: ingestEvent call succeeded (no crash)', ingest.ok, JSON.stringify(ingest));
    assert('Process A: stale event was silently suppressed (not ingested)', ingest.ingested === false, `ingested=${ingest.ingested}`);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------------
// Test 2: Path traversal guard — assertSafeId rejects malicious runId
// --------------------------------------------------------------------------
process.stdout.write('\nTest 2: Path-traversal runId is rejected by assertSafeId\n');
{
  const stateDir = mkdtempSync(join(tmpdir(), 'le-smoke-t2-'));
  try {
    const result = worker(stateDir, 'assert-safe-id');
    assert('assertSafeId: call succeeded', result.ok !== false || result.caught?.startsWith('INVALID_RUN_ID'), JSON.stringify(result));
    assert('assertSafeId: INVALID_RUN_ID thrown for ../../../evil', result.ok === true && result.caught?.startsWith('INVALID_RUN_ID'), `caught=${result.caught}`);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------------
// Test 3: Cross-process double-reconcile idempotency
// --------------------------------------------------------------------------
process.stdout.write('\nTest 3: Double-reconcile is idempotent — second call reconciles zero runs\n');
{
  const stateDir = mkdtempSync(join(tmpdir(), 'le-smoke-t3-'));
  try {
    const setup = worker(stateDir, 'setup');
    assert('Setup succeeded', setup.ok, JSON.stringify(setup));

    await sleep(1_300);

    const r1 = worker(stateDir, 'reconcile');
    assert('First reconcile: one run', r1.reconciledCount === 1, `count=${r1.reconciledCount}`);

    const r2 = worker(stateDir, 'reconcile');
    assert('Second reconcile: zero new runs', r2.reconciledCount === 0, `count=${r2.reconciledCount}`);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------------
// Summary
// --------------------------------------------------------------------------
process.stdout.write(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
