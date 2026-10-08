import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http';
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
  monitorHtml,
  monitorStartupMessage,
  openBrowser,
  parseMonitorArgs,
  projectRun,
  projectRuns,
} from '../src/monitor.js';
import type { LocalEngineer, SafeRun } from '../src/service.js';

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
  body?: string,
  extraHeaders?: Record<string, string>,
  customHost?: string,
): Promise<{ status: number; allow?: string; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolved, failed) => {
    const headers: Record<string, string> = { ...extraHeaders };
    if (body !== undefined && headers['Content-Type'] === undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(body));
    }
    const req = request(
      { host: customHost ?? '127.0.0.1', port, method, path, headers },
      (response: IncomingMessage) => {
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
      },
    );
    req.on('error', failed);
    if (body !== undefined) {
      req.write(body);
    }
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

describe('monitor session activity and timeline', () => {
  it('serves live tool calls and messages from raw events', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'monitor-tl-'));
    temporaryRoots.push(stateDirectory);
    const store = new RunStore(stateDirectory);
    const runId = 'run_' + 'X'.repeat(16);
    store.add(
      makeRun({
        runId,
        agentId: 'agt_tl_1',
        status: 'running',
        createdAt: '2026-07-24T00:00:00.000Z',
      }),
    );

    // Write raw-events.jsonl to harness directory
    const harnessDir = join(stateDirectory, 'runs', runId, 'harness');
    mkdirSync(harnessDir, { recursive: true });
    const events = [
      JSON.stringify({
        method: 'item/started',
        params: {
          startedAtMs: 1790120000000,
          item: {
            id: 'call_1',
            type: 'commandExecution',
            command: 'powershell.exe -Command "git status"',
            cwd: 'C:/repos/test',
            status: 'inProgress',
          },
        },
      }),
      JSON.stringify({
        method: 'item/commandExecution/outputDelta',
        params: { itemId: 'call_1', delta: 'On branch main\n' },
      }),
      JSON.stringify({
        method: 'item/completed',
        params: {
          completedAtMs: 1790120001000,
          item: {
            id: 'call_1',
            type: 'commandExecution',
            command: 'powershell.exe -Command "git status"',
            cwd: 'C:/repos/test',
            status: 'completed',
            exitCode: 0,
            durationMs: 1000,
            aggregatedOutput: 'On branch main\nnothing to commit\n',
          },
        },
      }),
      JSON.stringify({
        method: 'item/started',
        params: {
          startedAtMs: 1790120002000,
          item: { id: 'msg_1', type: 'agentMessage', text: '' },
        },
      }),
      JSON.stringify({
        method: 'item/agentMessage/delta',
        params: { itemId: 'msg_1', delta: 'Repository is clean.' },
      }),
      JSON.stringify({
        method: 'item/completed',
        params: {
          completedAtMs: 1790120003000,
          item: { id: 'msg_1', type: 'agentMessage', text: 'Repository is clean.' },
        },
      }),
    ];
    writeFileSync(join(harnessDir, 'raw-events.jsonl'), events.join('\n') + '\n');

    const { server } = createMonitorServer(store, { port: 0, open: false, help: false });
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => done());
    });

    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const res = await httpRequest(port, 'GET', `/api/runs/${runId}/timeline`);
      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body);
      expect(parsed.run_id).toBe(runId);
      expect(parsed.active).toBe(true);
      expect(parsed.items).toHaveLength(2);

      const cmd = parsed.items[0];
      expect(cmd.type).toBe('command');
      expect(cmd.status).toBe('completed');
      expect(cmd.command).toBe('powershell.exe -Command "git status"');
      expect(cmd.cwd).toBe('C:/repos/test');
      expect(cmd.output).toBe('On branch main\nnothing to commit\n');
      expect(cmd.exitCode).toBe(0);
      expect(cmd.durationMs).toBe(1000);

      const msg = parsed.items[1];
      expect(msg.type).toBe('message');
      expect(msg.status).toBe('completed');
      expect(msg.text).toBe('Repository is clean.');

      // HEAD request
      const head = await httpRequest(port, 'HEAD', `/api/runs/${runId}/timeline`);
      expect(head.status).toBe(200);
      expect(head.body).toBe('');

      // Unknown run
      const unknown = await httpRequest(port, 'GET', `/api/runs/${'run_' + 'W'.repeat(16)}/timeline`);
      expect(unknown.status).toBe(404);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
    }
  });

  it('falls back to sqlite messages when raw-events.jsonl is not present', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'monitor-tl-fallback-'));
    temporaryRoots.push(stateDirectory);
    const store = new RunStore(stateDirectory);
    const runId = 'run_' + 'V'.repeat(16);
    store.add(
      makeRun({
        runId,
        agentId: 'agt_tl_2',
        status: 'promoted',
      }),
    );
    store.captureMessage(runId, 'item_fb_1', '2026-07-24T00:00:01.000Z', 'fallback note');

    const { server } = createMonitorServer(store, { port: 0, open: false, help: false });
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => done());
    });

    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const res = await httpRequest(port, 'GET', `/api/runs/${runId}/timeline`);
      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body);
      expect(parsed.active).toBe(false);
      expect(parsed.items).toHaveLength(1);
      expect(parsed.items[0].type).toBe('message');
      expect(parsed.items[0].text).toBe('fallback note');
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
    }
  });

  it('supports pagination with limit and offset on timeline endpoint', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'monitor-tl-page-'));
    temporaryRoots.push(stateDirectory);
    const store = new RunStore(stateDirectory);
    const runId = 'run_' + 'P'.repeat(16);
    store.add(
      makeRun({
        runId,
        agentId: 'agt_tl_page',
        status: 'running',
      }),
    );

    const harnessDir = join(stateDirectory, 'runs', runId, 'harness');
    mkdirSync(harnessDir, { recursive: true });
    const events = [
      JSON.stringify({
        method: 'item/started',
        params: {
          startedAtMs: 1790120000000,
          item: { id: 'call_1', type: 'commandExecution', command: 'echo 1' },
        },
      }),
      JSON.stringify({
        method: 'item/completed',
        params: {
          completedAtMs: 1790120001000,
          item: { id: 'call_1', type: 'commandExecution', exitCode: 0 },
        },
      }),
      JSON.stringify({
        method: 'item/started',
        params: {
          startedAtMs: 1790120002000,
          item: { id: 'msg_1', type: 'agentMessage', text: 'Step 1 done' },
        },
      }),
      JSON.stringify({
        method: 'item/completed',
        params: {
          completedAtMs: 1790120003000,
          item: { id: 'msg_1', type: 'agentMessage', text: 'Step 1 done' },
        },
      }),
    ];
    writeFileSync(join(harnessDir, 'raw-events.jsonl'), events.join('\n') + '\n');

    const { server } = createMonitorServer(store, { port: 0, open: false, help: false });
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => done());
    });

    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      // Page 1
      const res1 = await httpRequest(port, 'GET', `/api/runs/${runId}/timeline?limit=1&offset=0`);
      expect(res1.status).toBe(200);
      const parsed1 = JSON.parse(res1.body);
      expect(parsed1.count).toBe(1);
      expect(parsed1.total).toBe(2);
      expect(parsed1.has_more).toBe(true);
      expect(parsed1.items[0].id).toBe('call_1');

      // Page 2
      const res2 = await httpRequest(port, 'GET', `/api/runs/${runId}/timeline?limit=1&offset=1`);
      expect(res2.status).toBe(200);
      const parsed2 = JSON.parse(res2.body);
      expect(parsed2.count).toBe(1);
      expect(parsed2.total).toBe(2);
      expect(parsed2.has_more).toBe(false);
      expect(parsed2.items[0].id).toBe('msg_1');

      // Invalid offset
      const resInvalidOffset = await httpRequest(port, 'GET', `/api/runs/${runId}/timeline?offset=notanumber`);
      expect(resInvalidOffset.status).toBe(400);

      // Invalid limit
      const resInvalidLimit = await httpRequest(port, 'GET', `/api/runs/${runId}/timeline?limit=bad`);
      expect(resInvalidLimit.status).toBe(400);

      // Unsafe integer offset (exceeding Number.MAX_SAFE_INTEGER)
      const resUnsafeOffset = await httpRequest(port, 'GET', `/api/runs/${runId}/timeline?offset=9007199254740992`);
      expect(resUnsafeOffset.status).toBe(400);

      // Unsafe integer limit
      const resUnsafeLimit = await httpRequest(port, 'GET', `/api/runs/${runId}/timeline?limit=9007199254740992`);
      expect(resUnsafeLimit.status).toBe(400);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
    }
  });

  it('enforces 2 MiB HTTP response byte budget on timeline with non-ASCII and JSON-escaped control/quote strings', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'monitor-tl-budget-'));
    temporaryRoots.push(stateDirectory);
    const store = new RunStore(stateDirectory);
    const runId = 'run_' + 'B'.repeat(16);
    store.add(
      makeRun({
        runId,
        agentId: 'agt_tl_budget',
        status: 'running',
      }),
    );

    const harnessDir = join(stateDirectory, 'runs', runId, 'harness');
    mkdirSync(harnessDir, { recursive: true });

    // Create 80 messages each containing non-ASCII ('é', '中文', '🎉') and escaped control/quote chars ('"', '\n', '\t')
    // Each message is ~40 KiB UTF-8. 80 * 40 KiB ≈ 3.2 MiB (exceeding 2 MiB budget)
    const baseContent = 'é_中文_🎉_"quote"\n\t\r\\'.repeat(1500);
    const events: string[] = [];
    for (let i = 0; i < 80; i++) {
      events.push(
        JSON.stringify({
          method: 'item/completed',
          params: {
            completedAtMs: 1790120000000 + i * 1000,
            item: { id: `msg_${i}`, type: 'agentMessage', text: `msg_${i}_${baseContent}` },
          },
        }),
      );
    }
    writeFileSync(join(harnessDir, 'raw-events.jsonl'), events.join('\n') + '\n');

    const { server } = createMonitorServer(store, { port: 0, open: false, help: false });
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => done());
    });

    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      // Page 1: Request up to 100 items
      const res1 = await httpRequest(port, 'GET', `/api/runs/${runId}/timeline?limit=100&offset=0`);
      expect(res1.status).toBe(200);

      const res1Bytes = Buffer.byteLength(res1.body, 'utf8');
      expect(res1Bytes).toBeLessThanOrEqual(2 * 1024 * 1024);

      const parsed1 = JSON.parse(res1.body);
      expect(parsed1.run_id).toBe(runId);
      expect(parsed1.total).toBe(80);
      expect(parsed1.has_more).toBe(true);
      expect(parsed1.history_truncated).toBe(true);
      expect(parsed1.items.length).toBeGreaterThan(0);
      expect(parsed1.items.length).toBeLessThan(80);

      // Page 2: Fetch next page starting at offset = parsed1.items.length
      const nextOffset = parsed1.items.length;
      const res2 = await httpRequest(port, 'GET', `/api/runs/${runId}/timeline?limit=100&offset=${nextOffset}`);
      expect(res2.status).toBe(200);

      const res2Bytes = Buffer.byteLength(res2.body, 'utf8');
      expect(res2Bytes).toBeLessThanOrEqual(2 * 1024 * 1024);

      const parsed2 = JSON.parse(res2.body);
      expect(parsed2.items.length).toBeGreaterThan(0);
      expect(parsed2.items[0].id).toBe(`msg_${nextOffset}`);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
    }
  });

  it('enforces 2 MiB HTTP response byte budget on SQLite fallback timeline path', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'monitor-tl-sql-budget-'));
    temporaryRoots.push(stateDirectory);
    const store = new RunStore(stateDirectory);
    const runId = 'run_' + 'M'.repeat(16);
    store.add(
      makeRun({
        runId,
        agentId: 'agt_tl_sql',
        status: 'completed',
      }),
    );

    let server: Server | undefined;
    try {
      // Populate sqlite messages table with non-ASCII and escaped content
      const baseContent = 'é_中文_🎉_"quote"\n\t'.repeat(300);
      for (let i = 0; i < 400; i++) {
        store.captureMessage(
          runId,
          `item_${i}`,
          new Date(1790000000000 + i * 1000).toISOString(),
          `msg_${i}_${baseContent}`,
        );
      }

      const monitor = createMonitorServer(store, { port: 0, open: false, help: false });
      server = monitor.server;
      await new Promise<void>((done, fail) => {
        server.once('error', fail);
        server.listen(0, '127.0.0.1', () => done());
      });

      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      const res = await httpRequest(port, 'GET', `/api/runs/${runId}/timeline?limit=300&offset=0`);
      expect(res.status).toBe(200);

      const resBytes = Buffer.byteLength(res.body, 'utf8');
      expect(resBytes).toBeLessThanOrEqual(2 * 1024 * 1024);

      const parsed = JSON.parse(res.body);
      expect(parsed.items.length).toBeGreaterThan(0);
      expect(parsed.items.length).toBeLessThan(300);
      expect(parsed.has_more).toBe(true);
    } finally {
      if (server) {
        await new Promise<void>((done) => server.close(() => done()));
      }
      store.close();
    }
  });

  it('paginates SQLite messages in ascending order without raw-events file', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'monitor-sqlite-pg-'));
    temporaryRoots.push(stateDirectory);
    const store = new RunStore(stateDirectory);
    const runId = 'run_' + 'P'.repeat(16);
    store.add(
      makeRun({
        runId,
        agentId: 'agt_sqlite_pg',
        status: 'running',
      }),
    );

    try {
      // Insert 150 messages with known chronological order
      for (let i = 0; i < 150; i++) {
        store.captureMessage(
          runId,
          `item_${String(i).padStart(3, '0')}`,
          new Date(1790000000000 + i * 1000).toISOString(),
          `message text ${i}`,
        );
      }

      // Page 1: limit 100, offset 0
      const page1 = store.readTimeline(runId, 100, 0);
      expect(page1.items.length).toBe(100);
      expect(page1.total).toBe(150);
      expect(page1.hasMore).toBe(true);
      expect(page1.items[0]?.text).toBe('message text 0');
      expect(page1.items[99]?.text).toBe('message text 99');

      // Page 2: limit 100, offset 100
      const page2 = store.readTimeline(runId, 100, 100);
      expect(page2.items.length).toBe(50);
      expect(page2.total).toBe(150);
      expect(page2.hasMore).toBe(false);
      expect(page2.items[0]?.text).toBe('message text 100');
      expect(page2.items[49]?.text).toBe('message text 149');

      // Verify successive pages are disjoint
      const page1Ids = new Set(page1.items.map((it) => it.id));
      for (const it of page2.items) {
        expect(page1Ids.has(it.id)).toBe(false);
      }

      // Verify ordering
      for (let i = 0; i < page1.items.length; i++) {
        expect(page1.items[i]?.text).toBe(`message text ${i}`);
      }
      for (let i = 0; i < page2.items.length; i++) {
        expect(page2.items[i]?.text).toBe(`message text ${100 + i}`);
      }
    } finally {
      store.close();
    }
  });

  it('projects userMessage as system prompt in timeline', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'monitor-tl-sys-'));
    temporaryRoots.push(stateDirectory);
    const store = new RunStore(stateDirectory);
    const runId = 'run_' + 'S'.repeat(16);
    store.add(
      makeRun({
        runId,
        agentId: 'agt_tl_sys',
        status: 'running',
      }),
    );

    const harnessDir = join(stateDirectory, 'runs', runId, 'harness');
    mkdirSync(harnessDir, { recursive: true });
    const events = [
      JSON.stringify({
        method: 'item/started',
        params: {
          startedAtMs: 1790120000000,
          item: {
            id: 'item_user_prompt',
            type: 'userMessage',
            content: [{ type: 'text', text: '# Assignment\nImplement Raos-only Terraform migration' }],
          },
        },
      }),
      JSON.stringify({
        method: 'item/completed',
        params: {
          completedAtMs: 1790120001000,
          item: {
            id: 'item_user_prompt',
            type: 'userMessage',
            content: [{ type: 'text', text: '# Assignment\nImplement Raos-only Terraform migration' }],
          },
        },
      }),
    ];
    writeFileSync(join(harnessDir, 'raw-events.jsonl'), events.join('\n') + '\n');

    const { server } = createMonitorServer(store, { port: 0, open: false, help: false });
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => done());
    });

    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const res = await httpRequest(port, 'GET', `/api/runs/${runId}/timeline`);
      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body);
      expect(parsed.items).toHaveLength(1);
      expect(parsed.items[0].type).toBe('system');
      expect(parsed.items[0].status).toBe('completed');
      expect(parsed.items[0].text).toContain('# Assignment\nImplement Raos-only Terraform migration');
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
    }
  });

  it('serves diffs and parsed files via /api/runs/:runId/diffs', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'monitor-diffs-'));
    temporaryRoots.push(stateDirectory);
    const store = new RunStore(stateDirectory);
    const runId = 'run_' + 'D'.repeat(16);
    const agentId = 'agt_' + 'D'.repeat(16);

    const mockPatch = [
      'diff --git a/src/service.ts b/src/service.ts',
      'index 1111111..2222222 100644',
      '--- a/src/service.ts',
      '+++ b/src/service.ts',
      '@@ -10,3 +10,4 @@',
      ' existing line',
      '+new line added',
      'diff --git a/new-file.txt b/new-file.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new-file.txt',
      '@@ -0,0 +1,2 @@',
      '+hello',
      '+world',
    ].join('\n');

    const patchDir = join(stateDirectory, 'container-agents', agentId, 'patches', 'revision-1');
    mkdirSync(patchDir, { recursive: true });
    writeFileSync(join(patchDir, 'rti.full.patch'), mockPatch);

    store.add(
      makeRun({
        runId,
        agentId,
        status: 'ready_for_review',
        changeSet: {
          revision: 1,
          previous_revision: 0,
          digest: 'sha256:testdigest',
          repositories: [
            {
              repository: 'rti',
              changed_paths: ['src/service.ts', 'new-file.txt'],
              additions: 3,
              deletions: 0,
              patch_digest: 'sha256:patch',
              delta_changed_paths: ['src/service.ts', 'new-file.txt'],
              delta_additions: 3,
              delta_deletions: 0,
              delta_patch_digest: 'sha256:delta',
            },
          ],
        },
        result: {
          reportStatus: 'valid',
          summary: 'Successfully added new feature and file',
          filesChanged: ['src/service.ts', 'new-file.txt'],
          verification: [{ name: 'unit tests', status: 'passed' }],
          unresolvedRisks: [],
          requiresUserAction: false,
          identityVerified: true,
        },
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
      const res = await httpRequest(port, 'GET', `/api/runs/${runId}/diffs`);
      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body);
      expect(parsed.run_id).toBe(runId);
      expect(parsed.revision).toBe(1);
      expect(parsed.files).toHaveLength(2);
      expect(parsed.files[0].path).toBe('src/service.ts');
      expect(parsed.files[0].status).toBe('modified');
      expect(parsed.files[0].additions).toBe(1);
      expect(parsed.files[0].diff).toContain('+new line added');
      expect(parsed.files[1].path).toBe('new-file.txt');
      expect(parsed.files[1].status).toBe('added');
      expect(parsed.files[1].additions).toBe(2);
      expect(parsed.report.summary).toBe('Successfully added new feature and file');
      expect(parsed.report.verification[0].status).toBe('passed');

      // Test 404 for unknown run
      const resNotFound = await httpRequest(port, 'GET', `/api/runs/run_unknown/diffs`);
      expect(resNotFound.status).toBe(404);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
    }
  });
});

describe('monitor steering endpoint POST /api/runs/:runId/steer', () => {
  it.each([
    { failure: 'STEER_RUN_NOT_ACTIVE', status: 409, expected: 'refresh' },
    { failure: 'settled_after_service_return', status: 502, expected: 'Failed to dispatch' },
  ])(
    'reports $status instead of queued success when guidance cannot reach a settled run',
    async ({ failure, status, expected }) => {
      const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'monitor-steer-settled-'));
      temporaryRoots.push(stateDirectory);
      const store = new RunStore(stateDirectory);
      const runId = 'run_' + 'S'.repeat(16);
      const agentId = 'agt_' + 'S'.repeat(16);
      store.add(makeRun({ runId, agentId, status: 'running' }));
      const mockService = {
        steer: vi.fn().mockImplementation(async () => {
          if (failure === 'STEER_RUN_NOT_ACTIVE') throw new Error(failure);
          store.enqueueSteer(runId, {
            id: 'steer_settled',
            message: 'Late correction',
            status: 'pending',
            queuedAt: new Date().toISOString(),
          });
          store.setStatus(runId, 'ready_for_review');
          return { run_id: runId, agent_id: agentId, status: 'running' };
        }),
      } as unknown as LocalEngineer;
      const { server, csrfToken } = createMonitorServer(store, { port: 0, open: false, help: false }, mockService);
      await new Promise<void>((done, fail) => {
        server.once('error', fail);
        server.listen(0, '127.0.0.1', done);
      });
      try {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const response = await httpRequest(
          port,
          'POST',
          `/api/runs/${runId}/steer`,
          JSON.stringify({ message: 'Late correction' }),
          {
            'X-CSRF-Token': csrfToken,
          },
        );
        expect(response.status).toBe(status);
        expect(JSON.parse(response.body).error).toContain(expected);
        expect(response.body).not.toContain('"success":true');
      } finally {
        await new Promise<void>((done) => server.close(() => done()));
        store.close();
      }
    },
  );

  it('returns 405 Method Not Allowed for GET/PUT/DELETE requests', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'monitor-steer-'));
    temporaryRoots.push(stateDirectory);
    const store = new RunStore(stateDirectory);
    const runId = 'run_' + 'S'.repeat(16);
    store.add(makeRun({ runId }));

    const { server } = createMonitorServer(store, { port: 0, open: false, help: false });
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => done());
    });

    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const res = await httpRequest(port, 'GET', `/api/runs/${runId}/steer`);
      expect(res.status).toBe(405);
      expect(res.allow).toBe('POST');
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
    }
  });

  it('returns 503 Service Unavailable when monitor has no service access', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'monitor-steer-'));
    temporaryRoots.push(stateDirectory);
    const store = new RunStore(stateDirectory);
    const runId = 'run_' + 'S'.repeat(16);
    store.add(makeRun({ runId }));

    const { server, csrfToken } = createMonitorServer(store, { port: 0, open: false, help: false });
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => done());
    });

    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const res = await httpRequest(
        port,
        'POST',
        `/api/runs/${runId}/steer`,
        JSON.stringify({ message: 'Focus on fixing the test' }),
        { 'X-CSRF-Token': csrfToken },
      );
      expect(res.status).toBe(503);
      const parsed = JSON.parse(res.body);
      expect(parsed.error).toContain('Steering unavailable');
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
    }
  });

  it('returns 404 for unknown run handles', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'monitor-steer-'));
    temporaryRoots.push(stateDirectory);
    const store = new RunStore(stateDirectory);
    const mockService = { reply: vi.fn(), cancel: vi.fn() } as unknown as LocalEngineer;

    const { server, csrfToken } = createMonitorServer(store, { port: 0, open: false, help: false }, mockService);
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => done());
    });

    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const res = await httpRequest(
        port,
        'POST',
        '/api/runs/run_unknown/steer',
        JSON.stringify({ message: 'Redirect agent' }),
        { 'X-CSRF-Token': csrfToken },
      );
      expect(res.status).toBe(404);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
    }
  });

  it('returns 400 when message is empty or whitespace-only', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'monitor-steer-'));
    temporaryRoots.push(stateDirectory);
    const store = new RunStore(stateDirectory);
    const runId = 'run_' + 'S'.repeat(16);
    store.add(makeRun({ runId }));
    const mockService = { reply: vi.fn(), cancel: vi.fn() } as unknown as LocalEngineer;

    const { server, csrfToken } = createMonitorServer(store, { port: 0, open: false, help: false }, mockService);
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => done());
    });

    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const res = await httpRequest(port, 'POST', `/api/runs/${runId}/steer`, JSON.stringify({ message: '   ' }), {
        'X-CSRF-Token': csrfToken,
      });
      expect(res.status).toBe(400);
      const parsed = JSON.parse(res.body);
      expect(parsed.error).toContain('Message must not be empty');
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
    }
  });

  it('steers an idle run via service.steer', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'monitor-steer-'));
    temporaryRoots.push(stateDirectory);
    const store = new RunStore(stateDirectory);
    const runId = 'run_' + 'S'.repeat(16);
    const agentId = 'agt_' + 'S'.repeat(16);
    const nextRunId = 'run_' + 'N'.repeat(16);
    store.add(makeRun({ runId, agentId, status: 'ready_for_review', workerThreadId: 'thread-123' }));

    const steerMock = vi.fn().mockResolvedValue({
      run_id: nextRunId,
      agent_id: agentId,
      status: 'queued',
    } as unknown as SafeRun);
    const mockService = { steer: steerMock } as unknown as LocalEngineer;

    const { server, csrfToken } = createMonitorServer(store, { port: 0, open: false, help: false }, mockService);
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => done());
    });

    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const res = await httpRequest(
        port,
        'POST',
        `/api/runs/${runId}/steer`,
        JSON.stringify({ message: 'Please add more tests for edge cases' }),
        { 'X-CSRF-Token': csrfToken },
      );
      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body);
      expect(parsed.success).toBe(true);
      expect(parsed.run_id).toBe(nextRunId);
      expect(parsed.agent_id).toBe(agentId);
      expect(parsed.status).toBe('queued');
      expect(parsed.steered_in_flight).toBe(false);

      expect(steerMock).toHaveBeenCalledWith(runId, 'Please add more tests for edge cases');
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
    }
  });

  it('steers an active run in-flight on the same run without cancelling', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'monitor-steer-'));
    temporaryRoots.push(stateDirectory);
    const store = new RunStore(stateDirectory);
    const runId = 'run_' + 'A'.repeat(16);
    const agentId = 'agt_' + 'A'.repeat(16);
    store.add(makeRun({ runId, agentId, status: 'running', workerThreadId: 'thread-active' }));

    const steerMock = vi.fn().mockResolvedValue({
      run_id: runId,
      agent_id: agentId,
      status: 'running',
    } as unknown as SafeRun);
    const mockService = { steer: steerMock } as unknown as LocalEngineer;

    const { server, csrfToken } = createMonitorServer(store, { port: 0, open: false, help: false }, mockService);
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => done());
    });

    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const res = await httpRequest(
        port,
        'POST',
        `/api/runs/${runId}/steer`,
        JSON.stringify({ message: 'Stop and redirect here' }),
        { 'X-CSRF-Token': csrfToken },
      );
      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body);
      expect(parsed.success).toBe(true);
      expect(parsed.run_id).toBe(runId);
      expect(parsed.agent_id).toBe(agentId);
      expect(parsed.status).toBe('running');
      expect(parsed.steered_in_flight).toBe(true);

      expect(steerMock).toHaveBeenCalledWith(runId, 'Stop and redirect here');
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
    }
  });

  it('enforces Host, Origin, Content-Type, and CSRF token security on monitor endpoints', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'monitor-sec-'));
    temporaryRoots.push(stateDirectory);
    const store = new RunStore(stateDirectory);
    const runId = 'run_' + 'K'.repeat(16);
    store.add(makeRun({ runId }));
    const mockService = {
      steer: vi.fn().mockResolvedValue({ run_id: runId, status: 'running' }),
    } as unknown as LocalEngineer;

    const { server, csrfToken } = createMonitorServer(store, { port: 0, open: false, help: false }, mockService);
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => done());
    });

    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      // 1. Missing or foreign Host authority
      const foreignHost = await httpRequest(port, 'GET', '/api/runs', undefined, { Host: `attacker.example:${port}` });
      expect(foreignHost.status).toBe(403);

      // 2. Cross-site Sec-Fetch-Site rejection
      const crossSite = await httpRequest(port, 'GET', '/api/runs', undefined, { 'Sec-Fetch-Site': 'cross-site' });
      expect(crossSite.status).toBe(403);

      // 3. Foreign Origin rejection
      const foreignOrigin = await httpRequest(
        port,
        'POST',
        `/api/runs/${runId}/steer`,
        JSON.stringify({ message: 'pwn' }),
        { 'X-CSRF-Token': csrfToken, Origin: 'https://attacker.example' },
      );
      expect(foreignOrigin.status).toBe(403);

      // 4. Null Origin rejection
      const nullOrigin = await httpRequest(
        port,
        'POST',
        `/api/runs/${runId}/steer`,
        JSON.stringify({ message: 'pwn' }),
        { 'X-CSRF-Token': csrfToken, Origin: 'null' },
      );
      expect(nullOrigin.status).toBe(403);

      // 5. Non-JSON Content-Type rejection (e.g. text/plain, application/jsonp)
      const textPlain = await httpRequest(
        port,
        'POST',
        `/api/runs/${runId}/steer`,
        JSON.stringify({ message: 'text' }),
        { 'X-CSRF-Token': csrfToken, 'Content-Type': 'text/plain' },
      );
      expect(textPlain.status).toBe(415);

      const jsonp = await httpRequest(port, 'POST', `/api/runs/${runId}/steer`, JSON.stringify({ message: 'jsonp' }), {
        'X-CSRF-Token': csrfToken,
        'Content-Type': 'application/jsonp',
      });
      expect(jsonp.status).toBe(415);

      // 6. Host without port rejected on non-80 listener
      const noPortHost = await httpRequest(
        port,
        'POST',
        `/api/runs/${runId}/steer`,
        JSON.stringify({ message: 'no port' }),
        {
          Host: '127.0.0.1',
          Origin: `http://127.0.0.1:${port}`,
          'X-CSRF-Token': csrfToken,
        },
      );
      expect(noPortHost.status).toBe(403);

      // 7. Missing CSRF token
      const missingCsrf = await httpRequest(
        port,
        'POST',
        `/api/runs/${runId}/steer`,
        JSON.stringify({ message: 'no token' }),
      );
      expect(missingCsrf.status).toBe(403);

      // 8. Wrong CSRF token
      const wrongCsrf = await httpRequest(
        port,
        'POST',
        `/api/runs/${runId}/steer`,
        JSON.stringify({ message: 'bad token' }),
        { 'X-CSRF-Token': 'wrong-token-value' },
      );
      expect(wrongCsrf.status).toBe(403);

      // 9. Legitimate request with same-origin host, loopback origin, and valid token
      const legit = await httpRequest(port, 'POST', `/api/runs/${runId}/steer`, JSON.stringify({ message: 'legit' }), {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        'X-CSRF-Token': csrfToken,
      });
      expect(legit.status).toBe(200);

      // 10. Served HTML contains injected CSRF meta tag
      const htmlPage = await httpRequest(port, 'GET', '/');
      expect(htmlPage.status).toBe(200);
      expect(htmlPage.body).toContain(`<meta name="csrf-token" content="${csrfToken}">`);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
    }
  });

  it('paginates timeline past 100 items without stalling', async () => {
    const stateDirectory = mkdtempSync(join(testTemporaryDirectory(), 'monitor-page-stall-'));
    temporaryRoots.push(stateDirectory);
    const store = new RunStore(stateDirectory);
    const runId = 'run_' + 'Q'.repeat(16);
    store.add(makeRun({ runId, status: 'running' }));

    const harnessDir = join(stateDirectory, 'runs', runId, 'harness');
    mkdirSync(harnessDir, { recursive: true });

    // Generate 120 timeline command events
    const events: string[] = [];
    for (let i = 0; i < 120; i++) {
      events.push(
        JSON.stringify({
          method: 'item/started',
          params: {
            startedAtMs: 1790120000000 + i * 1000,
            item: {
              id: `cmd_${i}`,
              type: 'commandExecution',
              command: `echo test_${i}`,
              cwd: 'C:/repos/test',
            },
          },
        }),
      );
      events.push(
        JSON.stringify({
          method: 'item/completed',
          params: {
            completedAtMs: 1790120000500 + i * 1000,
            item: {
              id: `cmd_${i}`,
              type: 'commandExecution',
              command: `echo test_${i}`,
              cwd: 'C:/repos/test',
              status: 'completed',
              exitCode: 0,
            },
          },
        }),
      );
    }
    writeFileSync(join(harnessDir, 'raw-events.jsonl'), events.join('\n') + '\n');

    const { server } = createMonitorServer(store, { port: 0, open: false, help: false });
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => done());
    });

    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      // Page 1: first 100 items
      const resPage1 = await httpRequest(port, 'GET', `/api/runs/${runId}/timeline?limit=100&offset=0`);
      expect(resPage1.status).toBe(200);
      const parsed1 = JSON.parse(resPage1.body);
      expect(parsed1.count).toBe(100);
      expect(parsed1.total).toBe(120);
      expect(parsed1.has_more).toBe(true);
      expect(parsed1.items[0].id).toBe('cmd_0');

      // Page 2: tail poll starting from offset 100 with limit 50
      const resPage2 = await httpRequest(port, 'GET', `/api/runs/${runId}/timeline?limit=50&offset=100`);
      expect(resPage2.status).toBe(200);
      const parsed2 = JSON.parse(resPage2.body);
      expect(parsed2.count).toBe(20);
      expect(parsed2.total).toBe(120);
      expect(parsed2.has_more).toBe(false);
      expect(parsed2.items[0].id).toBe('cmd_100');
      expect(parsed2.items[19].id).toBe('cmd_119');
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
    }
  });
});

describe('monitor DOM XSS prevention and safe rendering', () => {
  it('sanitizes malicious markup, script tags, event handlers, and quotes in formatSafeMarkdown and safeDomId', () => {
    const html = monitorHtml('test-token');
    expect(html).not.toContain('cdnjs.cloudflare.com');
    expect(html).not.toContain('cdn.jsdelivr.net');

    // Extract safeDomId and formatSafeMarkdown directly from monitorHtml
    const sStart = html.indexOf('function safeDomId(prefix, rawId) {');
    const sEnd = html.indexOf('function createSystemPromptElement(it) {');
    expect(sStart).toBeGreaterThan(-1);
    expect(sEnd).toBeGreaterThan(sStart);
    const sBody = html.slice(sStart, sEnd);
    const safeDomId = new Function('prefix', 'rawId', sBody + '\nreturn safeDomId(prefix, rawId);');

    const pwnedId = 'x"><img src=x onerror="globalThis.PWNED=1">';
    const cleanedId = safeDomId('msg', pwnedId);
    expect(cleanedId).not.toContain('<');
    expect(cleanedId).not.toContain('>');
    expect(cleanedId).not.toContain('"');
    expect(cleanedId).not.toContain("'");
    expect(cleanedId).toMatch(/^msg-[a-zA-Z0-9_-]+$/);

    // Extract formatSafeMarkdown and esc directly from monitorHtml
    const escStart = html.indexOf('function esc(val) {');
    const escEnd = html.indexOf('function fmtTime(iso) {');
    expect(escStart).toBeGreaterThan(-1);
    expect(escEnd).toBeGreaterThan(escStart);
    const escBody = html.slice(escStart, escEnd);
    const escFn = new Function('val', escBody + '\nreturn esc(val);');

    const mdStart = html.indexOf('function formatSafeMarkdown(text) {');
    const mdEnd = html.indexOf('function createToolCallElement(it) {');
    expect(mdStart).toBeGreaterThan(-1);
    expect(mdEnd).toBeGreaterThan(mdStart);
    const mdBody = html.slice(mdStart, mdEnd);
    const formatSafeMarkdown = new Function('text', 'esc', mdBody + '\nreturn formatSafeMarkdown(text);');

    const payloads = [
      '<script>alert(1)</script>',
      '<img src="x" onerror="globalThis.PWNED=1">',
      '<svg onload="alert(1)">',
      '[click](javascript:alert(1))',
      '"><script src="//evil.com/x.js"></script>',
      '<a href="jav&#x09;ascript:alert(1)">click</a>',
    ];

    for (const payload of payloads) {
      const rendered = formatSafeMarkdown(payload, escFn);
      expect(rendered).not.toContain('<script');
      expect(rendered).not.toContain('<img');
      expect(rendered).not.toContain('<svg');
      expect(rendered).not.toContain('<iframe');
      expect(rendered).not.toContain('<object');
      expect(rendered).not.toContain('<a href="javascript');
      if (payload.includes('<')) {
        expect(rendered).toContain('&lt;');
      }
    }
  });

  it('generates injective DOM element IDs preventing collisions', () => {
    const html = monitorHtml('test-token');
    const sStart = html.indexOf('function safeDomId(prefix, rawId) {');
    const sEnd = html.indexOf('function createSystemPromptElement(it) {');
    const sBody = html.slice(sStart, sEnd);
    const safeDomId = new Function('prefix', 'rawId', sBody + '\nreturn safeDomId(prefix, rawId);');

    // Injective property: distinct rawIds MUST produce distinct DOM IDs
    expect(safeDomId('t', 'a:b')).not.toBe(safeDomId('t', 'a?b'));
    expect(safeDomId('t', 'a:b')).not.toBe(safeDomId('t', 'a_b'));
    expect(safeDomId('t', 'a:b')).not.toBe(safeDomId('t', 'a/b'));
    expect(safeDomId('t', 'item-1')).toBe('t-item-1');
  });

  it('stops immediate pagination and displays capped notice when activeTimelineItems hits DOM cap of 2000', async () => {
    const html = monitorHtml('test-token');

    const pStart = html.indexOf('function pollTimelineLive(runId) {');
    const pEnd = html.indexOf('// ==========================================', pStart);
    expect(pStart).toBeGreaterThan(-1);
    expect(pEnd).toBeGreaterThan(pStart);
    const pollCode = html.slice(pStart, pEnd);

    const mockChatStream = {
      querySelector: vi.fn().mockReturnValue(null),
      appendChild: vi.fn(),
    };
    const mockChatViewport = { scrollTop: 0, scrollHeight: 1000, clientHeight: 800 };
    const mockLiveIndicator = { style: { display: 'none' } };

    const activeTimelineItems: Array<{ id: string; status: string }> = [];
    for (let i = 0; i < 2000; i++) {
      activeTimelineItems.push({ id: `item_${i}`, status: 'completed' });
    }

    const mockServerResponse = {
      active: true,
      count: 50,
      total: 2050,
      has_more: true,
      items: Array.from({ length: 50 }, (_, i) => ({ id: `item_${1990 + i}`, status: 'completed' })),
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockServerResponse,
    });

    const scheduledTimeouts: Array<{ fn: () => void; delay: number }> = [];
    const mockSetTimeout = vi.fn().mockImplementation((fn: () => void, delay: number) => {
      scheduledTimeouts.push({ fn, delay });
      return 123;
    });

    const mockDocument = {
      createElement: vi.fn().mockImplementation(() => ({
        className: '',
        style: {},
        textContent: '',
      })),
    };
    const mockWindow = {
      _inFlightProgressFetches: new Set(),
    };

    const runner = new Function(
      'runId',
      'selectedRunId',
      'activeTimelineItems',
      'chatStream',
      'chatViewport',
      'liveIndicator',
      'timelinePollTimer',
      'fetch',
      'setTimeout',
      'createTimelineItemElement',
      'updateTimelineItemInDom',
      'isUserNearBottom',
      'document',
      'window',
      pollCode + '\npollTimelineLive(runId);',
    );

    runner(
      'run_test',
      'run_test',
      activeTimelineItems,
      mockChatStream,
      mockChatViewport,
      mockLiveIndicator,
      null,
      mockFetch,
      mockSetTimeout,
      () => ({}),
      () => {},
      () => true,
      mockDocument,
      mockWindow,
    );

    await new Promise((r) => setTimeout(r, 20));

    expect(activeTimelineItems.length).toBe(2000);
    expect(mockChatStream.appendChild).toHaveBeenCalled();
    const appendedEl = mockChatStream.appendChild.mock.calls[0]![0] as { className: string; textContent: string };
    expect(appendedEl.className).toBe('timeline-capped-notice');
    expect(appendedEl.textContent).toContain('2,000');

    const immediate50ms = scheduledTimeouts.filter((t) => t.delay === 50);
    expect(immediate50ms).toHaveLength(0);
  });
});
