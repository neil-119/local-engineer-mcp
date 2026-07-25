import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunStore } from '../src/store.js';
import type { Run } from '../src/domain.js';

describe('server log rotation', () => {
  it('rotates before the active log exceeds its configured limit', () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'local-engineer-log-'));
    const store = new RunStore(stateDirectory, 100);

    store.logServer('first', { detail: 'a'.repeat(50) });
    store.logServer('second', { detail: 'b'.repeat(50) });

    const activeLog = join(stateDirectory, 'logs', 'server.log');
    const archivedLog = `${activeLog}.1`;
    expect(existsSync(archivedLog)).toBe(true);
    expect(readFileSync(archivedLog, 'utf8')).toContain('"event":"first"');
    expect(readFileSync(activeLog, 'utf8')).toContain('"event":"second"');
  });
});

describe('shared-state concurrency claim', () => {
  it('starts only within the configured global and worker limits', () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'local-engineer-claim-'));
    const store = new RunStore(stateDirectory);
    const run = (runId: string): Run => ({
      runId,
      agentId: `agt_${runId}`,
      ownerId: 'owner',
      title: runId,
      task: 'No-op',
      workingDirectory: 'C:/work/example',
      worker: 'codex-local',
      status: 'queued',
      continuationIndex: 0,
      createdAt: `2026-07-22T00:00:0${runId.at(-1)}.000Z`,
      requiresUserAction: false,
    });
    store.add(run('run_1'));
    store.add(run('run_2'));

    expect(store.tryStart('run_1', 1, 1)?.status).toBe('starting');
    expect(store.tryStart('run_2', 1, 1)).toBeUndefined();
    store.setStatus('run_1', 'failed');
    expect(store.tryStart('run_2', 1, 1)?.status).toBe('starting');
  });
});
