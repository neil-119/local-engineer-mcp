import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { request, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Run } from '../src/domain.js';
import { RunStore } from '../src/store.js';
import {
  DEFAULT_PORT,
  launchCommand,
  MAX_RUNS,
  createMonitorServer,
  lifecycleOf,
  monitorStartupMessage,
  openBrowser,
  parseMonitorArgs,
  projectRun,
  projectRuns,
} from '../src/monitor.js';

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    runId: 'run_1',
    agentId: 'agt_1',
    ownerId: 'owner-secret',
    title: 'Example title',
    task: 'top secret task payload',
    grounding: { objective: 'grounding secret' },
    workingDirectory: 'C:/private/host/path',
    workspaceName: 'workspace-secret',
    worker: 'codex-local',
    status: 'running',
    continuationIndex: 0,
    createdAt: '2026-07-24T00:00:00.000Z',
    startedAt: '2026-07-24T00:00:01.000Z',
    workerThreadId: 'thread-secret',
    workerTurnId: 'turn-secret',
    requiresUserAction: false,
    ...overrides,
  } satisfies Run;
}

describe('monitor safe projection', () => {
  it('exposes bounded lifecycle, result, change, and token metadata', () => {
    const projected = projectRun(
      makeRun({
        status: 'ready_for_review',
        diagnostics: {
          last_phase: 'turn_completed',
          last_activity_at: '2026-07-24T00:00:02.000Z',
          commands_started_count: 3,
          commands_completed_count: 2,
          commands_active_count: 1,
          last_command_status: 'succeeded',
        },
        result: {
          reportStatus: 'valid',
          summary: 'Done.',
          filesChanged: ['src/a.ts'],
          verification: [{ name: 'pnpm test', status: 'passed' }],
          unresolvedRisks: ['none'],
          requiresUserAction: false,
          identityVerified: true,
          reportExcerpt: 'internal report secret',
        },
        changeSet: {
          revision: 2,
          previous_revision: 1,
          digest: 'sha256:abc',
          repositories: [
            {
              repository: 'my-repo',
              changed_paths: ['src/a.ts', 'src/b.ts'],
              additions: 5,
              deletions: 2,
              patch_digest: 'sha256:def',
              delta_changed_paths: ['src/a.ts'],
              delta_additions: 2,
              delta_deletions: 1,
              delta_patch_digest: 'sha256:ghi',
            },
          ],
        },
        stats: {
          worker_tokens: {
            total: 100,
            input: 80,
            cached_input: 10,
            output: 20,
            reasoning_output: 5,
            source: 'app_server',
          },
          parent_visible: {
            characters: 100,
            estimated_tokens: 25,
            changes_characters: 40,
            diff_characters: 40,
            file_characters: 20,
            lifecycle_characters: 0,
          },
        },
      }),
    );

    expect(projected.lifecycle).toBe('review');
    expect(projected.status).toBe('ready_for_review');
    expect(projected.title).toBe('Example title');
    expect(projected.worker).toBe('codex-local');
    expect(projected.run_id).toBe('run_1');
    expect(projected.agent_id).toBe('agt_1');
    expect(projected.created_at).toBe('2026-07-24T00:00:00.000Z');
    expect(projected.diagnostics).toMatchObject({
      last_phase: 'turn_completed',
      commands_started_count: 3,
      last_command_status: 'succeeded',
    });
    expect(projected.result).toMatchObject({
      report_status: 'valid',
      summary: 'Done.',
      verification: [{ name: 'pnpm test', status: 'passed' }],
    });
    expect(projected.change_set).toMatchObject({
      revision: 2,
      repositories: [{ repository: 'my-repo', changed_paths: 2, additions: 5, deletions: 2 }],
    });
    expect(projected.delegation_impact).toMatchObject({
      local_worker_tokens: { total: 100, output: 20 },
      parent_visible_review_tokens_estimate: 25,
    });
  });

  it('never exposes owner, task, grounding, host paths, or Codex IDs', () => {
    const projected = projectRun(makeRun());
    const serialized = JSON.stringify(projected);
    expect(projected).not.toHaveProperty('ownerId');
    expect(projected).not.toHaveProperty('task');
    expect(projected).not.toHaveProperty('grounding');
    expect(projected).not.toHaveProperty('workingDirectory');
    expect(projected).not.toHaveProperty('containerWorkingDirectory');
    expect(projected).not.toHaveProperty('workspaceName');
    expect(projected).not.toHaveProperty('repositories');
    expect(projected).not.toHaveProperty('workerThreadId');
    expect(projected).not.toHaveProperty('workerTurnId');
    expect(projected).not.toHaveProperty('result.reportExcerpt');
    expect(serialized).not.toContain('owner-secret');
    expect(serialized).not.toContain('top secret task');
    expect(serialized).not.toContain('grounding secret');
    expect(serialized).not.toContain('C:/private/host/path');
    expect(serialized).not.toContain('thread-secret');
    expect(serialized).not.toContain('turn-secret');
  });

  it('projects terminal runs and excludes sensitive failure excerpts', () => {
    const projected = projectRun(
      makeRun({
        status: 'failed',
        diagnostics: {
          last_phase: 'command_failed',
          last_activity_at: '2026-07-24T00:00:02.000Z',
          last_command_error_excerpt: 'secret failure detail',
        },
      }),
    );
    expect(projected.lifecycle).toBe('terminal');
    expect(projected.diagnostics).not.toHaveProperty('last_command_error_excerpt');
    expect(JSON.stringify(projected)).not.toContain('secret failure detail');
  });

  it('bounds the snapshot to MAX_RUNS', () => {
    const runs = Array.from({ length: MAX_RUNS * 2 }, (_, index) =>
      makeRun({ runId: `run_${index}`, createdAt: `2026-07-24T00:00:${String(index % 60).padStart(2, '0')}.000Z` }),
    );
    const snapshot = projectRuns(runs);
    expect(snapshot.count).toBe(MAX_RUNS);
    expect(snapshot.runs).toHaveLength(MAX_RUNS);
    expect(snapshot.schema_version).toBe(1);
    expect(projectRuns(runs, 5).runs).toHaveLength(5);
    expect(projectRuns(runs, 0).runs).toHaveLength(0);
  });

  it('tolerates legacy persisted change sets without delta fields', () => {
    const legacy = makeRun({
      changeSet: {
        revision: 1,
        previous_revision: 0,
        digest: 'sha256:legacy',
        repositories: [
          {
            repository: 'legacy-repo',
            changed_paths: ['file.ts'],
            additions: 3,
            deletions: 1,
          },
        ],
      } as Run['changeSet'],
    });

    expect(projectRun(legacy).change_set).toEqual({
      revision: 1,
      repositories: [
        {
          repository: 'legacy-repo',
          changed_paths: 1,
          additions: 3,
          deletions: 1,
          delta_changed_paths: 0,
          delta_additions: 0,
          delta_deletions: 0,
        },
      ],
    });
  });
});

describe('monitor lifecycle classification', () => {
  it('classifies active, review, and terminal states', () => {
    expect(lifecycleOf('running')).toBe('active');
    expect(lifecycleOf('queued')).toBe('active');
    expect(lifecycleOf('starting')).toBe('active');
    expect(lifecycleOf('ready_for_review')).toBe('review');
    expect(lifecycleOf('promoted')).toBe('terminal');
    expect(lifecycleOf('failed')).toBe('terminal');
    expect(lifecycleOf('rejected')).toBe('terminal');
  });
});

describe('monitor CLI argument validation', () => {
  it('uses stable defaults and honors open', () => {
    expect(parseMonitorArgs([])).toEqual({ port: DEFAULT_PORT, open: true, help: false });
    expect(parseMonitorArgs(['--no-open'])).toEqual({ port: DEFAULT_PORT, open: false, help: false });
  });

  it('parses --port in both forms', () => {
    expect(parseMonitorArgs(['--port', '3000', '--no-open'])).toEqual({ port: 3000, open: false, help: false });
    expect(parseMonitorArgs(['--port=8080'])).toEqual({ port: 8080, open: true, help: false });
    const result = parseMonitorArgs(['--port', '65535']);
    expect(result.port).toBe(65535);
  });

  it('represents help without exiting the process', () => {
    expect(parseMonitorArgs(['--help'])).toEqual({ port: DEFAULT_PORT, open: true, help: true });
    expect(parseMonitorArgs(['-h', '--no-open'])).toEqual({ port: DEFAULT_PORT, open: false, help: true });
  });

  it('rejects out-of-range, non-numeric, and missing ports', () => {
    expect(() => parseMonitorArgs(['--port', '0'])).toThrow('CLI_MONITOR_PORT_INVALID');
    expect(() => parseMonitorArgs(['--port', '65536'])).toThrow('CLI_MONITOR_PORT_INVALID');
    expect(() => parseMonitorArgs(['--port', 'abc'])).toThrow('CLI_MONITOR_PORT_INVALID');
    expect(() => parseMonitorArgs(['--port=12.5'])).toThrow('CLI_MONITOR_PORT_INVALID');
    expect(() => parseMonitorArgs(['--port'])).toThrow('CLI_MONITOR_PORT_REQUIRED');
    expect(() => parseMonitorArgs(['--bogus'])).toThrow('CLI_MONITOR_UNKNOWN_OPTION');
  });
});

describe('monitor browser launch abstraction', () => {
  it('returns the platform-specific launch command without launching', () => {
    expect(launchCommand('http://127.0.0.1:8899/', 'darwin')).toEqual(['open', 'http://127.0.0.1:8899/']);
    expect(launchCommand('http://127.0.0.1:8899/', 'win32')).toEqual([
      'cmd',
      '/c',
      'start',
      '',
      'http://127.0.0.1:8899/',
    ]);
    expect(launchCommand('http://127.0.0.1:8899/', 'linux')).toEqual(['xdg-open', 'http://127.0.0.1:8899/']);
  });

  it('prints the exact monitor URL', () => {
    expect(monitorStartupMessage('http://127.0.0.1:8899/')).toBe('Local Engineer monitor: http://127.0.0.1:8899/');
  });

  it('handles launcher errors and unreferences the detached child', () => {
    const child = new EventEmitter() as ChildProcess;
    child.unref = vi.fn();
    const spawnImpl = vi.fn(() => child);

    openBrowser('http://127.0.0.1:8899/', spawnImpl, 'win32');

    expect(spawnImpl).toHaveBeenCalledWith('cmd', ['/c', 'start', '', 'http://127.0.0.1:8899/'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    expect(child.unref).toHaveBeenCalledOnce();
    expect(() => child.emit('error', new Error('browser unavailable'))).not.toThrow();
  });
});

function httpRequest(
  port: number,
  method: string,
  path: string,
): Promise<{ status: number; allow?: string; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolved, failed) => {
    const req = request({ host: '127.0.0.1', port, method, path }, (response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        resolved({
          status: response.statusCode ?? 0,
          allow: response.headers['allow'],
          body: Buffer.concat(chunks).toString('utf8'),
          headers: response.headers,
        });
      });
    });
    req.on('error', failed);
    req.end();
  });
}

async function withServer(fn: (port: number) => Promise<void>): Promise<void> {
  const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'monitor-http-'));
  temporaryRoots.push(stateDirectory);
  const store = new RunStore(stateDirectory);
  store.add(makeRun());
  store.add(makeRun({ runId: 'run_2', agentId: 'agt_2', createdAt: '2026-07-24T00:00:01.000Z' }));
  store.add(
    makeRun({
      runId: 'run_legacy',
      agentId: 'agt_legacy',
      createdAt: '2026-07-23T00:00:00.000Z',
      changeSet: {
        revision: 1,
        previous_revision: 0,
        digest: 'sha256:legacy',
        repositories: [{ repository: 'legacy', changed_paths: [], additions: 0, deletions: 0 }],
      } as Run['changeSet'],
    }),
  );
  const { server } = createMonitorServer(store, { port: 0, open: false, help: false });
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => done());
  });
  try {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await fn(port);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    store.close();
  }
}

describe('monitor HTTP read-only boundary', () => {
  it('serves the HTML page over GET and permits HEAD', async () => {
    await withServer(async (port) => {
      const page = await httpRequest(port, 'GET', '/');
      expect(page.status).toBe(200);
      expect(page.body).toContain('Local Engineer Monitor');
      const head = await httpRequest(port, 'HEAD', '/');
      expect(head.status).toBe(200);
      expect(head.body).toBe('');
      expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(page.headers['content-security-policy']).toBe(head.headers['content-security-policy']);
      expect(page.headers['x-frame-options']).toBe('DENY');
      expect(page.headers['referrer-policy']).toBe('no-referrer');
    });
  });

  it('serves bounded JSON status on /api/runs without sensitive fields', async () => {
    await withServer(async (port) => {
      const result = await httpRequest(port, 'GET', '/api/runs?limit=1');
      expect(result.status).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.schema_version).toBe(1);
      expect(parsed.count).toBe(1);
      expect(parsed.runs).toHaveLength(1);
      expect(result.body).not.toContain('task');
      expect(result.body).not.toContain('podman');
      const head = await httpRequest(port, 'HEAD', '/api/runs');
      expect(head.status).toBe(200);
      expect(head.body).toBe('');
      expect(result.headers['x-content-type-options']).toBe('nosniff');
      expect(result.headers['x-content-type-options']).toBe(head.headers['x-content-type-options']);
    });
  });

  it('rejects every non-GET/HEAD method with 405 and an Allow header', async () => {
    await withServer(async (port) => {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const result = await httpRequest(port, method, '/api/runs');
        expect(result.status).toBe(405);
        expect(result.allow).toBe('GET, HEAD');
        const root = await httpRequest(port, method, '/');
        expect(root.status).toBe(405);
        expect(root.allow).toBe('GET, HEAD');
      }
    });
  });

  it('returns 404 for unknown paths', async () => {
    await withServer(async (port) => {
      const result = await httpRequest(port, 'GET', '/nope');
      expect(result.status).toBe(404);
    });
  });
});

function testTemporaryDirectory(): string {
  const path = join(process.cwd(), '.tmp', 'tests');
  mkdirSync(path, { recursive: true });
  return path;
}

describe('monitor run pagination', () => {
  it('pages runs and round-trips an opaque cursor without leaks', async () => {
    await withServer(async (port) => {
      const first = await httpRequest(port, 'GET', '/api/runs?limit=2');
      expect(first.status).toBe(200);
      const p1 = JSON.parse(first.body);
      expect(p1.schema_version).toBe(1);
      expect(p1.runs).toHaveLength(2);
      expect(p1.has_more).toBe(true);
      expect(typeof p1.next_cursor).toBe('string');
      expect(first.body).not.toContain('owner-secret');
      expect(first.body).not.toContain('top secret');
      expect(first.body).not.toContain('C:/private');
      expect(first.body).not.toContain('thread-secret');
      expect(first.body).not.toContain('turn-secret');
      expect(first.body).not.toContain('raw-events');

      const second = await httpRequest(port, 'GET', '/api/runs?limit=2&cursor=' + encodeURIComponent(p1.next_cursor));
      expect(second.status).toBe(200);
      const p2 = JSON.parse(second.body);
      expect(p2.runs).toHaveLength(1);
      expect(p2.has_more).toBe(false);
      expect(p2.next_cursor).toBeUndefined();
      const ids1 = p1.runs.map((r: { run_id: string }) => r.run_id);
      const ids2 = p2.runs.map((r: { run_id: string }) => r.run_id);
      expect(ids1.filter((x: string) => ids2.includes(x))).toEqual([]);
      expect(ids1.concat(ids2).sort()).toEqual(['run_1', 'run_2', 'run_legacy']);
    });
  });

  it('rejects invalid limit and invalid cursor with a safe 400', async () => {
    await withServer(async (port) => {
      expect((await httpRequest(port, 'GET', '/api/runs?limit=abc')).status).toBe(400);
      expect((await httpRequest(port, 'GET', '/api/runs?limit=0')).status).toBe(400);
      expect((await httpRequest(port, 'GET', '/api/runs?cursor=' + encodeURIComponent('not!!valid'))).status).toBe(400);
      expect((await httpRequest(port, 'GET', '/api/runs?cursor=' + encodeURIComponent('AAABBB'))).status).toBe(400);
      expect((await httpRequest(port, 'GET', '/api/runs?cursor=' + encodeURIComponent('%%%invalid'))).status).toBe(400);
    });
  });
});

describe('monitor assistant messages', () => {
  async function withMessageServer(fn: (port: number, store: RunStore, runId: string) => Promise<void>): Promise<void> {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'monitor-msg-'));
    temporaryRoots.push(stateDirectory);
    const store = new RunStore(stateDirectory);
    const runId = 'run_' + 'Z'.repeat(16);
    store.add(
      makeRun({
        runId,
        agentId: 'agt_1',
        ownerId: 'owner-secret',
        task: 'top secret task payload',
        grounding: { objective: 'grounding secret' },
        workingDirectory: 'C:/private/host/path',
        workerThreadId: 'thread-secret',
        workerTurnId: 'turn-secret',
        createdAt: '2026-07-24T00:00:00.000Z',
      }),
    );
    store.captureMessage(runId, 'item_a_1', '2026-07-24T00:00:01.000Z', 'assistant note one');
    store.captureMessage(runId, 'item_b_2', '2026-07-24T00:00:02.000Z', 'assistant note two');
    store.captureMessage(runId, 'item_c_3', '2026-07-24T00:00:03.000Z', 'assistant note three');
    const { server } = createMonitorServer(store, { port: 0, open: false, help: false });
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => done());
    });
    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      await fn(port, store, runId);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
    }
  }

  it('serves paged safe messages and never exposes internal ids', async () => {
    await withMessageServer(async (port, _store, runId) => {
      const page = await httpRequest(port, 'GET', `/api/runs/${runId}/messages?limit=2`);
      expect(page.status).toBe(200);
      const body = JSON.parse(page.body);
      expect(body.run_id).toBe(runId);
      expect(body.messages).toHaveLength(2);
      expect(body.has_more).toBe(true);
      expect(typeof body.next_cursor).toBe('string');
      expect(Object.keys(body.messages[0]!).sort()).toEqual(['text', 'ts']);
      expect(body.messages[0]!.text).toBe('assistant note three');
      expect(body.messages[1]!.text).toBe('assistant note two');
      // internal item ids and private ids must not appear anywhere in the payload
      const serialized = page.body;
      expect(serialized).not.toContain('item_a_1');
      expect(serialized).not.toContain('item_b_2');
      expect(serialized).not.toContain('item_c_3');
      expect(serialized).not.toContain('owner-secret');
      expect(serialized).not.toContain('top secret');
      expect(serialized).not.toContain('C:/private');
      expect(serialized).not.toContain('thread-secret');
      expect(serialized).not.toContain('turn-secret');
      expect(serialized).not.toContain('raw-events');

      const second = await httpRequest(
        port,
        'GET',
        `/api/runs/${runId}/messages?limit=2&cursor=` + encodeURIComponent(body.next_cursor),
      );
      expect(second.status).toBe(200);
      const p2 = JSON.parse(second.body);
      expect(p2.messages).toHaveLength(1);
      expect(p2.messages[0]!.text).toBe('assistant note one');
      expect(p2.has_more).toBe(false);
      expect(p2.next_cursor).toBeUndefined();
    });
  });

  it('encodes an opaque Local Engineer cursor with no codex ids', async () => {
    await withMessageServer(async (port, _store, runId) => {
      const page = await httpRequest(port, 'GET', `/api/runs/${runId}/messages?limit=2`);
      expect(page.status).toBe(200);
      const body = JSON.parse(page.body);
      expect(body.has_more).toBe(true);
      const cursor: string = body.next_cursor;
      expect(typeof cursor).toBe('string');

      // The decoded cursor must contain only a Local Engineer-owned integer sequence.
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
      expect(Object.keys(decoded).sort()).toEqual(['seq']);
      expect(decoded).toEqual({ seq: expect.any(Number) });
      expect(JSON.stringify(decoded)).not.toMatch(/item|thread|turn/);

      // The raw cursor string and the full payload must not carry any internal id.
      expect(cursor).not.toContain('item_a_1');
      expect(cursor).not.toContain('item_b_2');
      expect(cursor).not.toContain('item_c_3');
      expect(page.body).not.toMatch(/item_a_1|item_b_2|item_c_3/);
    });
  });

  it('returns 404 for unknown or invalid run handles', async () => {
    await withMessageServer(async (port, _store, runId) => {
      const unknown = await httpRequest(port, 'GET', `/api/runs/${'run_' + 'Y'.repeat(16)}/messages`);
      expect(unknown.status).toBe(404);
      const traversal = await httpRequest(port, 'GET', '/api/runs/run_..%2F..%2Fetc/messages');
      expect(traversal.status).toBe(404);
      const short = await httpRequest(port, 'GET', `/api/runs/${'run_1'}/messages`);
      expect(short.status).toBe(404);
      expect((await httpRequest(port, 'GET', `/api/runs/${runId}/messages?limit=abc`)).status).toBe(400);
      expect(
        (await httpRequest(port, 'GET', `/api/runs/${runId}/messages?cursor=` + encodeURIComponent('bad!!'))).status,
      ).toBe(400);
    });
  });
});
