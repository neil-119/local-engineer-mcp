import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const serverScriptPath = fileURLToPath(new URL('../container/file-tools-server.mjs', import.meta.url));

interface JsonRpcResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  capabilities?: { tools?: Record<string, unknown> };
  serverInfo?: { name?: string; version?: string };
  tools?: Array<{ name: string; description?: string }>;
  [key: string]: unknown;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number;
  result?: JsonRpcResult;
  error?: { code: number; message: string };
}

class TestMcpClient {
  private process: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (res: JsonRpcResponse) => void; reject: (err: Error) => void }>();
  private buffer = '';

  constructor(workspaceRoots: string[]) {
    this.process = spawn(process.execPath, [serverScriptPath, ...workspaceRoots], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, NODE_ENV: 'test', FILE_TOOLS_TEST_HOOKS: '1' },
    });

    this.process.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as JsonRpcResponse;
          if (parsed.id !== undefined && this.pending.has(parsed.id)) {
            const { resolve } = this.pending.get(parsed.id)!;
            this.pending.delete(parsed.id);
            resolve(parsed);
          }
        } catch {
          // ignore malformed
        }
      }
    });
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ isError?: boolean; text: string; structuredContent?: Record<string, unknown> }> {
    const res = await this.request('tools/call', { name, arguments: args });
    if (res.error) {
      throw new Error(`RPC_ERROR:${res.error.message}`);
    }
    const content = res.result?.content?.[0];
    return {
      isError: res.result?.isError,
      text: content?.text ?? '',
      structuredContent: res.result?.structuredContent,
    };
  }

  async setFailureHook(hook: string | null, error?: string): Promise<void> {
    await this.request('test/set_failure_hook', { hook, error });
  }

  close() {
    this.process.kill();
  }
}

describe('Container File Tools MCP Server', () => {
  let testWorkspace: string;
  let client: TestMcpClient;

  beforeEach(() => {
    testWorkspace = join(tmpdir(), `le-test-workspace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(testWorkspace, { recursive: true });
    client = new TestMcpClient(['--rw', testWorkspace]);
  });

  afterEach(() => {
    client.close();
    if (existsSync(testWorkspace)) {
      rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  describe('startup validation and workspace roots', () => {
    it('fails startup if no roots are provided', () => {
      const res = spawnSync(process.execPath, [serverScriptPath], {
        env: { ...process.env, LOCAL_ENGINEER_WORKSPACE_ROOTS: '', CODEX_WORKSPACE_ROOT: '' },
      });
      expect(res.status).toBe(1);
    });

    it('fails startup if --ro or --rw has no argument', () => {
      const res = spawnSync(process.execPath, [serverScriptPath, '--ro']);
      expect(res.status).toBe(1);
    });

    it('fails startup if a specified root does not exist', () => {
      const missing = join(testWorkspace, 'nonexistent-root-dir');
      const res = spawnSync(process.execPath, [serverScriptPath, '--rw', missing]);
      expect(res.status).toBe(1);
    });

    it('fails startup if a specified root is a regular file instead of a directory', () => {
      const fileAsRoot = join(testWorkspace, 'file-root.txt');
      writeFileSync(fileAsRoot, 'not a dir');
      const res = spawnSync(process.execPath, [serverScriptPath, '--rw', fileAsRoot]);
      expect(res.status).toBe(1);
    });

    it('makes read-only win for duplicate canonical roots regardless of flag ordering', async () => {
      // Order 1: --rw then --ro
      const client1 = new TestMcpClient(['--rw', testWorkspace, '--ro', testWorkspace]);
      try {
        const file = join(testWorkspace, 'dup1.txt');
        writeFileSync(file, 'original', 'utf8');
        const readRes = await client1.callTool('read_file', { file_path: 'dup1.txt' });
        expect(readRes.isError).toBeFalsy();
        const writeRes = await client1.callTool('write_file', { file_path: 'dup1.txt', content: 'mutated' });
        expect(writeRes.isError).toBe(true);
        expect(writeRes.text).toContain('Access denied:');
        expect(writeRes.text).toContain('read-only repository');
      } finally {
        client1.close();
      }

      // Order 2: --ro then --rw
      const client2 = new TestMcpClient(['--ro', testWorkspace, '--rw', testWorkspace]);
      try {
        const file = join(testWorkspace, 'dup2.txt');
        writeFileSync(file, 'original', 'utf8');
        const readRes = await client2.callTool('read_file', { file_path: 'dup2.txt' });
        expect(readRes.isError).toBeFalsy();
        const writeRes = await client2.callTool('write_file', { file_path: 'dup2.txt', content: 'mutated' });
        expect(writeRes.isError).toBe(true);
        expect(writeRes.text).toContain('Access denied:');
        expect(writeRes.text).toContain('read-only repository');
      } finally {
        client2.close();
      }
    });

    it('selects the most-specific containing root when broad RW contains nested RO', async () => {
      const nestedRo = join(testWorkspace, 'nested-ro');
      mkdirSync(nestedRo, { recursive: true });

      const rwFile = join(testWorkspace, 'allowed.txt');
      const roFile = join(nestedRo, 'forbidden.txt');
      writeFileSync(rwFile, 'outer', 'utf8');
      writeFileSync(roFile, 'inner', 'utf8');

      // Broad RW root on testWorkspace, nested RO root on nestedRo
      const clientOver = new TestMcpClient(['--rw', testWorkspace, '--ro', nestedRo]);
      try {
        // Outer file can be read and edited
        const outerRead = await clientOver.callTool('read_file', { file_path: 'allowed.txt' });
        expect(outerRead.isError).toBeFalsy();
        const outerEdit = await clientOver.callTool('edit_file', {
          file_path: 'allowed.txt',
          old_string: 'outer',
          new_string: 'outer-edited',
        });
        expect(outerEdit.isError).toBeFalsy();

        // Nested file can be read, but editing or writing to nested RO fails
        const innerRead = await clientOver.callTool('read_file', { file_path: 'nested-ro/forbidden.txt' });
        expect(innerRead.isError).toBeFalsy();
        const innerEdit = await clientOver.callTool('edit_file', {
          file_path: 'nested-ro/forbidden.txt',
          old_string: 'inner',
          new_string: 'inner-edited',
        });
        expect(innerEdit.isError).toBe(true);
        expect(innerEdit.text).toContain('Access denied:');
        expect(innerEdit.text).toContain('read-only repository');
      } finally {
        clientOver.close();
      }
    });
  });

  describe('read_file', () => {
    it('returns exact raw text without line number prefixes and provides structured metadata', async () => {
      const filePath = join(testWorkspace, 'hello.txt');
      const rawContent = 'Line one\nLine two\nLine three\n';
      writeFileSync(filePath, rawContent, 'utf8');

      const res = await client.callTool('read_file', { file_path: 'hello.txt' });
      expect(res.isError).toBeFalsy();
      expect(res.text).toBe(rawContent);
      expect(res.structuredContent).toBeDefined();
      expect(res.structuredContent?.start_line).toBe(1);
      expect(res.structuredContent?.end_line).toBe(4);
    });

    it('reads partial slices as exact raw text with correct structured line ranges', async () => {
      const filePath = join(testWorkspace, 'numbers.txt');
      const lines = ['one', 'two', 'three', 'four', 'five'];
      writeFileSync(filePath, lines.join('\n'), 'utf8');

      const res = await client.callTool('read_file', { file_path: 'numbers.txt', offset: 2, limit: 2 });
      expect(res.isError).toBeFalsy();
      expect(res.text).toBe('two\nthree\n');
      expect(res.structuredContent?.start_line).toBe(2);
      expect(res.structuredContent?.end_line).toBe(3);
    });

    it('fails when file does not exist', async () => {
      const res = await client.callTool('read_file', { file_path: 'missing.txt' });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('File not found');
    });

    it('rejects path traversal outside workspace', async () => {
      const res = await client.callTool('read_file', { file_path: '../../outside.txt' });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('Access denied');
    });
  });

  describe('edit_file', () => {
    it('rejects empty old_string immediately without hanging', async () => {
      const filePath = join(testWorkspace, 'hang.txt');
      writeFileSync(filePath, 'some text here', 'utf8');
      await client.callTool('read_file', { file_path: 'hang.txt' });

      const startTime = Date.now();
      const res = await client.callTool('edit_file', {
        file_path: 'hang.txt',
        old_string: '',
        new_string: 'replacement',
      });
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(1500);
      expect(res.isError).toBe(true);
      expect(res.text).toContain('old_string is required and cannot be empty');
    });

    it('rejects editing regions outside observed ranges after partial read', async () => {
      const filePath = join(testWorkspace, 'large.txt');
      const lines = [
        'function header() {}',
        '// Region A',
        'const a = 1;',
        '// Region B',
        'const b = 2;',
        '// Region C',
        'const c = 3;',
      ];
      writeFileSync(filePath, lines.join('\n'), 'utf8');

      // Partial read only lines 1-3 (Region A)
      await client.callTool('read_file', { file_path: 'large.txt', offset: 1, limit: 3 });

      // Attempt to edit Region C (lines 6-7) which was NOT observed
      const res = await client.callTool('edit_file', {
        file_path: 'large.txt',
        old_string: 'const c = 3;',
        new_string: 'const c = 42;',
      });

      expect(res.isError).toBe(true);
      expect(res.text).toContain(
        'File was only partially read and target edit region was not observed in this session',
      );

      // Now edit Region A which WAS observed
      const resOk = await client.callTool('edit_file', {
        file_path: 'large.txt',
        old_string: 'const a = 1;',
        new_string: 'const a = 99;',
      });

      expect(resOk.isError).toBeFalsy();
      expect(readFileSync(filePath, 'utf8')).toContain('const a = 99;');
    });

    it('fails if file has not been read in this session', async () => {
      const filePath = join(testWorkspace, 'unopened.txt');
      writeFileSync(filePath, 'const x = 10;\n', 'utf8');

      const res = await client.callTool('edit_file', {
        file_path: 'unopened.txt',
        old_string: '10',
        new_string: '20',
      });

      expect(res.isError).toBe(true);
      expect(res.text).toContain('File has not been read during this session. Read the file before editing it.');
    });

    it('fails if file changed on disk since it was read', async () => {
      const filePath = join(testWorkspace, 'stale.txt');
      writeFileSync(filePath, 'original content', 'utf8');

      await client.callTool('read_file', { file_path: 'stale.txt' });

      // Mutate file externally
      writeFileSync(filePath, 'external modification', 'utf8');

      const res = await client.callTool('edit_file', {
        file_path: 'stale.txt',
        old_string: 'original',
        new_string: 'updated',
      });

      expect(res.isError).toBe(true);
      expect(res.text).toContain('The file has changed since it was last read. Read it again before editing.');
    });

    it('fails if old_string is not found', async () => {
      const filePath = join(testWorkspace, 'code.js');
      writeFileSync(filePath, 'const a = 1;', 'utf8');

      await client.callTool('read_file', { file_path: 'code.js' });

      const res = await client.callTool('edit_file', {
        file_path: 'code.js',
        old_string: 'const b = 2;',
        new_string: 'const c = 3;',
      });

      expect(res.isError).toBe(true);
      expect(res.text).toContain('old_string was not found in the current file.');
    });

    it('fails if old_string matches multiple locations and replace_all is false', async () => {
      const filePath = join(testWorkspace, 'repeat.js');
      writeFileSync(filePath, 'foo = 1;\nfoo = 2;\nfoo = 3;', 'utf8');

      await client.callTool('read_file', { file_path: 'repeat.js' });

      const res = await client.callTool('edit_file', {
        file_path: 'repeat.js',
        old_string: 'foo',
        new_string: 'bar',
      });

      expect(res.isError).toBe(true);
      expect(res.text).toContain('old_string matched 3 locations.');
      expect(res.text).toContain('Provide more surrounding context so the match is unique');
    });

    it('succeeds on unique match and updates session state for subsequent edits', async () => {
      const filePath = join(testWorkspace, 'Worker.cs');
      writeFileSync(filePath, 'public class Worker {\n    private const int Timeout = 30;\n}\n', 'utf8');

      await client.callTool('read_file', { file_path: 'Worker.cs' });

      const edit1 = await client.callTool('edit_file', {
        file_path: 'Worker.cs',
        old_string: 'private const int Timeout = 30;',
        new_string: 'private const int Timeout = 60;',
      });

      expect(edit1.isError).toBeFalsy();
      const parsed1 = JSON.parse(edit1.text);
      expect(parsed1.success).toBe(true);
      expect(parsed1.replacements).toBe(1);

      expect(readFileSync(filePath, 'utf8')).toContain('Timeout = 60;');

      // Second edit immediately WITHOUT rereading
      const edit2 = await client.callTool('edit_file', {
        file_path: 'Worker.cs',
        old_string: 'Timeout = 60;',
        new_string: 'Timeout = 120;',
      });

      expect(edit2.isError).toBeFalsy();
      const parsed2 = JSON.parse(edit2.text);
      expect(parsed2.success).toBe(true);
      expect(parsed2.replacements).toBe(1);
      expect(readFileSync(filePath, 'utf8')).toContain('Timeout = 120;');
    });

    it('replaces all occurrences when replace_all is true', async () => {
      const filePath = join(testWorkspace, 'all.txt');
      writeFileSync(filePath, 'apple banana apple cherry apple', 'utf8');

      await client.callTool('read_file', { file_path: 'all.txt' });

      const res = await client.callTool('edit_file', {
        file_path: 'all.txt',
        old_string: 'apple',
        new_string: 'orange',
        replace_all: true,
      });

      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(res.text);
      expect(parsed.replacements).toBe(3);
      expect(readFileSync(filePath, 'utf8')).toBe('orange banana orange cherry orange');
    });
  });

  describe('write_file', () => {
    it('creates new file and its parent directories directly', async () => {
      const newPath = 'nested/dir/new_file.txt';

      const res = await client.callTool('write_file', {
        file_path: newPath,
        content: 'Brand new content\n',
      });

      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(res.text);
      expect(parsed.success).toBe(true);
      expect(parsed.created).toBe(true);

      const diskPath = join(testWorkspace, 'nested', 'dir', 'new_file.txt');
      expect(existsSync(diskPath)).toBe(true);
      expect(readFileSync(diskPath, 'utf8')).toBe('Brand new content\n');
    });

    it('rejects whole-file replacement of existing file if never read', async () => {
      const filePath = join(testWorkspace, 'existing.txt');
      writeFileSync(filePath, 'original', 'utf8');

      const res = await client.callTool('write_file', {
        file_path: 'existing.txt',
        content: 'overwritten',
      });

      expect(res.isError).toBe(true);
      expect(res.text).toContain('File has not been read during this session. Read the file before overwriting it.');
    });

    it('rejects whole-file replacement if only partially read', async () => {
      const filePath = join(testWorkspace, 'partial.txt');
      writeFileSync(filePath, 'line 1\nline 2\nline 3\nline 4\n', 'utf8');

      await client.callTool('read_file', { file_path: 'partial.txt', offset: 1, limit: 2 });

      const res = await client.callTool('write_file', {
        file_path: 'partial.txt',
        content: 'full replacement',
      });

      expect(res.isError).toBe(true);
      expect(res.text).toContain(
        'File was only partially read. A complete read is required before replacing the entire file.',
      );
    });

    it('allows intentional whole-file replacement after complete read', async () => {
      const filePath = join(testWorkspace, 'complete.txt');
      writeFileSync(filePath, 'line 1\nline 2\nline 3\n', 'utf8');

      await client.callTool('read_file', { file_path: 'complete.txt' });

      const res = await client.callTool('write_file', {
        file_path: 'complete.txt',
        content: 'brand new full content',
      });

      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(res.text);
      expect(parsed.success).toBe(true);
      expect(parsed.created).toBe(false);
      expect(readFileSync(filePath, 'utf8')).toBe('brand new full content');
    });
  });

  describe('atomic rollback and data preservation', () => {
    it('preserves existing destination when move fails', async () => {
      const src = join(testWorkspace, 'src.txt');
      const dest = join(testWorkspace, 'dest.txt');
      writeFileSync(src, 'new data', 'utf8');
      writeFileSync(dest, 'valuable original data', 'utf8');

      await client.callTool('read_file', { file_path: 'src.txt' });
      // destination not read -> move with overwrite=true will fail freshness check
      const res = await client.callTool('move_file', {
        source_path: 'src.txt',
        destination_path: 'dest.txt',
        overwrite: true,
      });

      expect(res.isError).toBe(true);
      // Ensure destination was NOT unlinked or lost!
      expect(existsSync(dest)).toBe(true);
      expect(readFileSync(dest, 'utf8')).toBe('valuable original data');
      expect(existsSync(src)).toBe(true);
    });

    it('preserves existing destination when copy fails', async () => {
      const src = join(testWorkspace, 'src_copy.txt');
      const dest = join(testWorkspace, 'dest_copy.txt');
      writeFileSync(src, 'new copy data', 'utf8');
      writeFileSync(dest, 'valuable original destination', 'utf8');

      await client.callTool('read_file', { file_path: 'src_copy.txt' });
      // destination not read -> fails freshness
      const res = await client.callTool('copy_file', {
        source_path: 'src_copy.txt',
        destination_path: 'dest_copy.txt',
        overwrite: true,
      });

      expect(res.isError).toBe(true);
      expect(existsSync(dest)).toBe(true);
      expect(readFileSync(dest, 'utf8')).toBe('valuable original destination');
    });

    it('rejects moving non-regular file sources or destinations', async () => {
      const subDir = join(testWorkspace, 'subdir');
      mkdirSync(subDir, { recursive: true });

      const res = await client.callTool('move_file', {
        source_path: 'subdir',
        destination_path: 'new_sub',
      });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('Source is not a regular file');
    });
  });

  describe('fail-closed symlink and junction protection', () => {
    it('rejects symbolic links on reads, writes, and list operations', () => {
      const targetFile = join(testWorkspace, 'target.txt');
      const linkFile = join(testWorkspace, 'link.txt');
      writeFileSync(targetFile, 'secret content');

      try {
        symlinkSync(targetFile, linkFile);
      } catch {
        // Symlinks might require elevated privileges on older Windows; skip if OS forbids
        return;
      }

      return (async () => {
        const readRes = await client.callTool('read_file', { file_path: 'link.txt' });
        expect(readRes.isError).toBe(true);
        expect(readRes.text).toContain('symbolic link or junction detected');

        const writeRes = await client.callTool('write_file', { file_path: 'link.txt', content: 'new data' });
        expect(writeRes.isError).toBe(true);
        expect(writeRes.text).toContain('symbolic link or junction detected');

        const copyRes = await client.callTool('copy_file', { source_path: 'link.txt', destination_path: 'dest.txt' });
        expect(copyRes.isError).toBe(true);
        expect(copyRes.text).toContain('symbolic link');
      })();
    });

    it('rejects new file creation when an ancestor is a link or junction escaping workspace', () => {
      const outsideDir = join(tmpdir(), `le-outside-${Date.now()}`);
      mkdirSync(outsideDir, { recursive: true });
      const linkDir = join(testWorkspace, 'link_dir');

      try {
        const type = process.platform === 'win32' ? 'junction' : 'dir';
        symlinkSync(outsideDir, linkDir, type);
      } catch {
        rmSync(outsideDir, { recursive: true, force: true });
        return;
      }

      return (async () => {
        try {
          const res = await client.callTool('write_file', {
            file_path: 'link_dir/escaped.txt',
            content: 'bad escape',
          });
          expect(res.isError).toBe(true);
          expect(res.text).toContain('symbolic link or junction detected');
        } finally {
          rmSync(outsideDir, { recursive: true, force: true });
        }
      })();
    });
  });

  describe('resource bounds and ReDoS safety', () => {
    it('rejects pathological ReDoS regex without hanging or crashing', async () => {
      const filePath = join(testWorkspace, 'redos.txt');
      writeFileSync(filePath, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa!\n', 'utf8');

      const startTime = Date.now();
      const res = await client.callTool('grep_files', {
        query: '(a+)+$',
        is_regex: true,
      });
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(1500);
      expect(res.isError).toBe(true);
      expect(res.text).toContain('Search timed out');
    });

    it('rejects oversized queries in grep_files', async () => {
      const res = await client.callTool('grep_files', {
        query: 'a'.repeat(1500),
      });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('query exceeds maximum allowed length');
    });

    it('enforces maximum depth and entries in list_dir', async () => {
      mkdirSync(join(testWorkspace, 'd1', 'd2', 'd3'), { recursive: true });
      writeFileSync(join(testWorkspace, 'd1', 'd2', 'd3', 'deep.txt'), 'deep');

      const res = await client.callTool('list_dir', { path: '.', recursive: true, max_depth: 2 });
      expect(res.isError).toBeFalsy();
      const entries = JSON.parse(res.text);
      const paths = entries.map((e: { path: string }) => e.path);
      expect(paths).toContain('d1');
      expect(paths).toContain('d1/d2');
      expect(paths).not.toContain('d1/d2/d3/deep.txt');
    });
  });

  describe('environment files and git lockdown', () => {
    it('allows reading and editing .env and .env.example files inside workspace', async () => {
      const envPath = join(testWorkspace, '.env');
      const examplePath = join(testWorkspace, '.env.example');
      writeFileSync(envPath, 'FOO=bar\n', 'utf8');
      writeFileSync(examplePath, 'FOO=example\n', 'utf8');

      const readEnv = await client.callTool('read_file', { file_path: '.env' });
      expect(readEnv.isError).toBeFalsy();
      expect(readEnv.text).toBe('FOO=bar\n');

      const editEnv = await client.callTool('edit_file', {
        file_path: '.env',
        old_string: 'FOO=bar',
        new_string: 'FOO=baz',
      });
      expect(editEnv.isError).toBeFalsy();
      expect(readFileSync(envPath, 'utf8')).toBe('FOO=baz\n');

      const readExample = await client.callTool('read_file', { file_path: '.env.example' });
      expect(readExample.isError).toBeFalsy();
      expect(readExample.text).toBe('FOO=example\n');
    });

    it('strictly forbids access to .git metadata and git~1', async () => {
      const gitDir = join(testWorkspace, '.git');
      mkdirSync(gitDir, { recursive: true });
      writeFileSync(join(gitDir, 'config'), '[core]\n\trepositoryformatversion = 0\n', 'utf8');

      const readRes = await client.callTool('read_file', { file_path: '.git/config' });
      expect(readRes.isError).toBe(true);
      expect(readRes.text).toContain('Git repository metadata (.git) is forbidden');

      const read83 = await client.callTool('read_file', { file_path: 'git~1/config' });
      expect(read83.isError).toBe(true);
      expect(read83.text).toContain('Git repository metadata (.git) is forbidden');
    });
  });

  describe('line endings (CRLF vs LF)', () => {
    it('matches multiline LF edits against CRLF files and preserves CRLF on disk', async () => {
      const crlfPath = join(testWorkspace, 'crlf.txt');
      writeFileSync(crlfPath, 'first line\r\nsecond line\r\nthird line\r\n', 'utf8');

      const readRes = await client.callTool('read_file', { file_path: 'crlf.txt' });
      expect(readRes.isError).toBeFalsy();

      const editRes = await client.callTool('edit_file', {
        file_path: 'crlf.txt',
        old_string: 'second line\nthird line',
        new_string: 'updated second\nupdated third',
      });
      expect(editRes.isError).toBeFalsy();

      const contents = readFileSync(crlfPath, 'utf8');
      expect(contents).toBe('first line\r\nupdated second\r\nupdated third\r\n');
    });
  });

  describe('copy_file read-state preservation and non-ASCII ranges', () => {
    it('preserves partial read state on copy and blocks editing unread non-ASCII regions', async () => {
      const srcPath = join(testWorkspace, 'utf8-source.txt');
      const content = '日本語のタイトル行です\nfunction processData() { return 42; }\n別の末尾行です\n';
      writeFileSync(srcPath, content, 'utf8');

      // Read only line 1
      const readPart = await client.callTool('read_file', {
        file_path: 'utf8-source.txt',
        offset: 1,
        limit: 1,
      });
      expect(readPart.isError).toBeFalsy();
      expect(readPart.text).toBe('日本語のタイトル行です\n');

      // Copy file to destination
      const copyRes = await client.callTool('copy_file', {
        source_path: 'utf8-source.txt',
        destination_path: 'utf8-dest.txt',
      });
      expect(copyRes.isError).toBeFalsy();

      // Destination should NOT allow editing line 2 because only line 1 was observed
      const editUnread = await client.callTool('edit_file', {
        file_path: 'utf8-dest.txt',
        old_string: 'function processData() { return 42; }',
        new_string: 'function processData() { return 100; }',
      });
      expect(editUnread.isError).toBe(true);
      expect(editUnread.text).toContain('File was only partially read and target edit region was not observed');

      // Destination should NOT allow whole-file replacement because complete read was not performed
      const overwriteUnread = await client.callTool('write_file', {
        file_path: 'utf8-dest.txt',
        content: 'new entire content',
      });
      expect(overwriteUnread.isError).toBe(true);
      expect(overwriteUnread.text).toContain('File was only partially read. A complete read is required');

      // Read line 2 of destination
      const readLine2 = await client.callTool('read_file', {
        file_path: 'utf8-dest.txt',
        offset: 2,
        limit: 1,
      });
      expect(readLine2.isError).toBeFalsy();
      expect(readLine2.text).toBe('function processData() { return 42; }\n');

      // Now editing line 2 of destination should succeed
      const editObserved = await client.callTool('edit_file', {
        file_path: 'utf8-dest.txt',
        old_string: 'function processData() { return 42; }',
        new_string: 'function processData() { return 100; }',
      });
      expect(editObserved.isError).toBeFalsy();
      expect(readFileSync(join(testWorkspace, 'utf8-dest.txt'), 'utf8')).toContain('return 100;');
    });
  });

  describe('deterministic rollback and failure injection', () => {
    it('restores original destination file when atomicWrite fails after backup', async () => {
      const filePath = join(testWorkspace, 'atomic-rollback.txt');
      writeFileSync(filePath, 'original content', 'utf8');

      // Read file first
      await client.callTool('read_file', { file_path: 'atomic-rollback.txt' });

      // Inject failure after backup is created
      await client.setFailureHook('atomic_write_after_backup', 'Injected failure after backup');

      const editRes = await client.callTool('edit_file', {
        file_path: 'atomic-rollback.txt',
        old_string: 'original content',
        new_string: 'mutated content',
      });
      expect(editRes.isError).toBe(true);
      expect(editRes.text).toContain('Injected failure after backup');

      // Original file should be restored intact
      expect(readFileSync(filePath, 'utf8')).toBe('original content');

      // Clear hook
      await client.setFailureHook(null);
    });

    it('emits distinct rollback-incomplete error when rollback itself fails', async () => {
      const filePath = join(testWorkspace, 'rollback-incomplete.txt');
      writeFileSync(filePath, 'original content', 'utf8');

      await client.callTool('read_file', { file_path: 'rollback-incomplete.txt' });

      // Inject failure after replacement that leads to rollback, and inject failure during rollback itself
      await client.setFailureHook(
        'atomic_write_after_replacement,atomic_write_during_rollback',
        'Injected rollback disk failure',
      );

      const editRes = await client.callTool('edit_file', {
        file_path: 'rollback-incomplete.txt',
        old_string: 'original content',
        new_string: 'mutated content',
      });
      expect(editRes.isError).toBe(true);
      expect(editRes.text).toContain('Rollback incomplete');
      expect(editRes.text).toContain('Original backup preserved at:');

      await client.setFailureHook(null);
    });

    it('restores both source and destination when move_file fails after replacement (existing destination)', async () => {
      const srcPath = join(testWorkspace, 'move-src.txt');
      const destPath = join(testWorkspace, 'move-dest.txt');
      writeFileSync(srcPath, 'new source content', 'utf8');
      writeFileSync(destPath, 'original dest content', 'utf8');

      await client.callTool('read_file', { file_path: 'move-src.txt' });
      await client.callTool('read_file', { file_path: 'move-dest.txt' });

      await client.setFailureHook('move_file_after_replacement', 'Injected move failure after replacement');

      const moveRes = await client.callTool('move_file', {
        source_path: 'move-src.txt',
        destination_path: 'move-dest.txt',
        overwrite: true,
      });
      expect(moveRes.isError).toBe(true);
      expect(moveRes.text).toContain('Injected move failure after replacement');

      // Both source and destination must be restored with their original contents
      expect(existsSync(srcPath)).toBe(true);
      expect(readFileSync(srcPath, 'utf8')).toBe('new source content');
      expect(existsSync(destPath)).toBe(true);
      expect(readFileSync(destPath, 'utf8')).toBe('original dest content');

      await client.setFailureHook(null);
    });

    it('restores source and leaves destination absent when move_file fails after replacement (nonexistent destination)', async () => {
      const srcPath = join(testWorkspace, 'move-src-nonexist.txt');
      const destPath = join(testWorkspace, 'move-dest-nonexist.txt');
      writeFileSync(srcPath, 'new source content nonexist', 'utf8');

      await client.callTool('read_file', { file_path: 'move-src-nonexist.txt' });

      await client.setFailureHook('move_file_after_replacement', 'Injected move failure after replacement');

      const moveRes = await client.callTool('move_file', {
        source_path: 'move-src-nonexist.txt',
        destination_path: 'move-dest-nonexist.txt',
      });
      expect(moveRes.isError).toBe(true);
      expect(moveRes.text).toContain('Injected move failure after replacement');

      // Source must be restored; destination must remain absent
      expect(existsSync(srcPath)).toBe(true);
      expect(readFileSync(srcPath, 'utf8')).toBe('new source content nonexist');
      expect(existsSync(destPath)).toBe(false);

      await client.setFailureHook(null);
    });

    it('restores source and destination in simulated EXDEV move when failure occurs after unlink', async () => {
      const srcPath = join(testWorkspace, 'move-exdev-src.txt');
      const destPath = join(testWorkspace, 'move-exdev-dest.txt');
      writeFileSync(srcPath, 'exdev source content', 'utf8');
      writeFileSync(destPath, 'exdev original dest content', 'utf8');

      await client.callTool('read_file', { file_path: 'move-exdev-src.txt' });
      await client.callTool('read_file', { file_path: 'move-exdev-dest.txt' });

      await client.setFailureHook(
        'simulate_exdev,move_file_after_replacement',
        'Injected EXDEV failure after source unlink',
      );

      const moveRes = await client.callTool('move_file', {
        source_path: 'move-exdev-src.txt',
        destination_path: 'move-exdev-dest.txt',
        overwrite: true,
      });
      expect(moveRes.isError).toBe(true);
      expect(moveRes.text).toContain('Injected EXDEV failure after source unlink');

      // Both source and destination must be restored via copy-back and backup restoration
      expect(existsSync(srcPath)).toBe(true);
      expect(readFileSync(srcPath, 'utf8')).toBe('exdev source content');
      expect(existsSync(destPath)).toBe(true);
      expect(readFileSync(destPath, 'utf8')).toBe('exdev original dest content');

      await client.setFailureHook(null);
    });

    it('restores source and leaves destination absent in simulated EXDEV move without existing destination', async () => {
      const srcPath = join(testWorkspace, 'move-exdev-src2.txt');
      const destPath = join(testWorkspace, 'move-exdev-dest2.txt');
      writeFileSync(srcPath, 'exdev source content 2', 'utf8');

      await client.callTool('read_file', { file_path: 'move-exdev-src2.txt' });

      await client.setFailureHook(
        'simulate_exdev,move_file_after_replacement',
        'Injected EXDEV failure after source unlink',
      );

      const moveRes = await client.callTool('move_file', {
        source_path: 'move-exdev-src2.txt',
        destination_path: 'move-exdev-dest2.txt',
      });
      expect(moveRes.isError).toBe(true);
      expect(moveRes.text).toContain('Injected EXDEV failure after source unlink');

      // Source copied back; destination unlinked
      expect(existsSync(srcPath)).toBe(true);
      expect(readFileSync(srcPath, 'utf8')).toBe('exdev source content 2');
      expect(existsSync(destPath)).toBe(false);

      await client.setFailureHook(null);
    });

    it('reports rollback-incomplete error with recovery status when move_file rollback itself fails', async () => {
      const srcPath = join(testWorkspace, 'move-rb-fail-src.txt');
      const destPath = join(testWorkspace, 'move-rb-fail-dest.txt');
      writeFileSync(srcPath, 'rb src content', 'utf8');
      writeFileSync(destPath, 'rb dest content', 'utf8');

      await client.callTool('read_file', { file_path: 'move-rb-fail-src.txt' });
      await client.callTool('read_file', { file_path: 'move-rb-fail-dest.txt' });

      await client.setFailureHook(
        'move_file_after_replacement,move_file_during_rollback',
        'Injected disk error during move rollback',
      );

      const moveRes = await client.callTool('move_file', {
        source_path: 'move-rb-fail-src.txt',
        destination_path: 'move-rb-fail-dest.txt',
        overwrite: true,
      });
      expect(moveRes.isError).toBe(true);
      expect(moveRes.text).toContain('Rollback incomplete: failed to restore files');
      expect(moveRes.text).toContain('Injected disk error during move rollback');
      expect(moveRes.text).toContain('Recovery status:');
      expect(moveRes.text).toContain('source=');
      expect(moveRes.text).toContain('destination=');
      expect(moveRes.text).toContain('dest_backup=');

      await client.setFailureHook(null);
    });

    it('unlinks newly created file when atomicWrite fails after replacement on a new file', async () => {
      const newFilePath = join(testWorkspace, 'new-file-rollback.txt');
      expect(existsSync(newFilePath)).toBe(false);

      await client.setFailureHook('atomic_write_after_replacement', 'Injected failure on new file write');

      const writeRes = await client.callTool('write_file', {
        file_path: 'new-file-rollback.txt',
        content: 'content that should not remain',
      });
      expect(writeRes.isError).toBe(true);
      expect(writeRes.text).toContain('Injected failure on new file write');

      // Newly created file must be unlinked
      expect(existsSync(newFilePath)).toBe(false);

      await client.setFailureHook(null);
    });

    it('reports rollback-incomplete error when unlinking newly created file fails in atomicWrite', async () => {
      const newFilePath = join(testWorkspace, 'new-file-rb-fail.txt');
      expect(existsSync(newFilePath)).toBe(false);

      await client.setFailureHook(
        'atomic_write_after_replacement,atomic_write_during_rollback',
        'Injected rollback unlink failure',
      );

      const writeRes = await client.callTool('write_file', {
        file_path: 'new-file-rb-fail.txt',
        content: 'content that cannot be cleaned up',
      });
      expect(writeRes.isError).toBe(true);
      expect(writeRes.text).toContain('Rollback incomplete: failed to remove newly created file');
      expect(writeRes.text).toContain('Injected rollback unlink failure');
      expect(existsSync(newFilePath)).toBe(true);

      await client.setFailureHook(null);
    });

    it('removes replacement and restores original destination when copy_file fails after replacement (existing destination)', async () => {
      const srcPath = join(testWorkspace, 'copy-src.txt');
      const destPath = join(testWorkspace, 'copy-dest.txt');
      writeFileSync(srcPath, 'new source content', 'utf8');
      writeFileSync(destPath, 'original dest content', 'utf8');

      await client.callTool('read_file', { file_path: 'copy-src.txt' });
      await client.callTool('read_file', { file_path: 'copy-dest.txt' });

      await client.setFailureHook('copy_file_after_replacement', 'Injected copy failure after replacement');

      const copyRes = await client.callTool('copy_file', {
        source_path: 'copy-src.txt',
        destination_path: 'copy-dest.txt',
        overwrite: true,
      });
      expect(copyRes.isError).toBe(true);
      expect(copyRes.text).toContain('Injected copy failure after replacement');

      // Original destination must remain intact
      expect(readFileSync(destPath, 'utf8')).toBe('original dest content');
      // Original source must remain intact
      expect(readFileSync(srcPath, 'utf8')).toBe('new source content');

      await client.setFailureHook(null);
    });

    it('unlinks newly created destination when copy_file fails after replacement (destExists=false)', async () => {
      const srcPath = join(testWorkspace, 'copy-src-new.txt');
      const destPath = join(testWorkspace, 'copy-dest-new.txt');
      writeFileSync(srcPath, 'copy source for new dest', 'utf8');

      await client.callTool('read_file', { file_path: 'copy-src-new.txt' });

      await client.setFailureHook('copy_file_after_replacement', 'Injected copy failure on new dest');

      const copyRes = await client.callTool('copy_file', {
        source_path: 'copy-src-new.txt',
        destination_path: 'copy-dest-new.txt',
      });
      expect(copyRes.isError).toBe(true);
      expect(copyRes.text).toContain('Injected copy failure on new dest');

      // Destination must not remain
      expect(existsSync(destPath)).toBe(false);
      // Source must remain untouched
      expect(existsSync(srcPath)).toBe(true);
      expect(readFileSync(srcPath, 'utf8')).toBe('copy source for new dest');

      await client.setFailureHook(null);
    });

    it('reports rollback-incomplete error when removing newly created destination fails in copy_file', async () => {
      const srcPath = join(testWorkspace, 'copy-src-new-fail.txt');
      const destPath = join(testWorkspace, 'copy-dest-new-fail.txt');
      writeFileSync(srcPath, 'copy source for new dest fail', 'utf8');

      await client.callTool('read_file', { file_path: 'copy-src-new-fail.txt' });

      await client.setFailureHook(
        'copy_file_after_replacement,copy_file_during_rollback',
        'Injected rollback unlink failure on copy',
      );

      const copyRes = await client.callTool('copy_file', {
        source_path: 'copy-src-new-fail.txt',
        destination_path: 'copy-dest-new-fail.txt',
      });
      expect(copyRes.isError).toBe(true);
      expect(copyRes.text).toContain('Rollback incomplete: failed to remove newly created file');
      expect(copyRes.text).toContain('Injected rollback unlink failure on copy');
      expect(existsSync(destPath)).toBe(true);

      await client.setFailureHook(null);
    });
  });

  describe('direct-file resource bounds in grep_files', () => {
    it('rejects oversized files passed directly to grep_files', async () => {
      const hugeFile = join(testWorkspace, 'huge.txt');
      // 10 MB + 1024 bytes (exceeds MAX_FILE_SIZE of 10MB)
      const buffer = Buffer.alloc(10 * 1024 * 1024 + 1024, 'x');
      writeFileSync(hugeFile, buffer);

      const res = await client.callTool('grep_files', {
        path: 'huge.txt',
        query: 'some_needle',
      });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('exceeds maximum supported size of 10485760 bytes');
    });
  });

  describe('runtime argument validation', () => {
    it('rejects string "false" for boolean arguments and fails closed', async () => {
      const filePath = join(testWorkspace, 'bool-test.txt');
      writeFileSync(filePath, 'foo bar foo\n', 'utf8');
      await client.callTool('read_file', { file_path: 'bool-test.txt' });

      const editRes = await client.callTool('edit_file', {
        file_path: 'bool-test.txt',
        old_string: 'foo',
        new_string: 'baz',
        replace_all: 'false' as unknown as boolean,
      });
      expect(editRes.isError).toBe(true);
      expect(editRes.text).toContain("Invalid value for 'replace_all': expected boolean");

      const copyRes = await client.callTool('copy_file', {
        source_path: 'bool-test.txt',
        destination_path: 'bool-test-copy.txt',
        overwrite: 'true' as unknown as boolean,
      });
      expect(copyRes.isError).toBe(true);
      expect(copyRes.text).toContain("Invalid value for 'overwrite': expected boolean");
    });

    it('rejects malformed and out-of-range integer arguments', async () => {
      const filePath = join(testWorkspace, 'int-test.txt');
      writeFileSync(filePath, 'line1\nline2\nline3\n', 'utf8');

      const resOffsetStr = await client.callTool('read_file', {
        file_path: 'int-test.txt',
        offset: '1' as unknown as number,
      });
      expect(resOffsetStr.isError).toBe(true);
      expect(resOffsetStr.text).toContain("Invalid value for 'offset': expected integer");

      const resOffsetNeg = await client.callTool('read_file', {
        file_path: 'int-test.txt',
        offset: -1,
      });
      expect(resOffsetNeg.isError).toBe(true);
      expect(resOffsetNeg.text).toContain('is less than minimum allowed (1)');

      const resLimitNeg = await client.callTool('read_file', {
        file_path: 'int-test.txt',
        limit: -5,
      });
      expect(resLimitNeg.isError).toBe(true);
      expect(resLimitNeg.text).toContain('is less than minimum allowed (0)');

      const resLimitExceed = await client.callTool('read_file', {
        file_path: 'int-test.txt',
        limit: 20000,
      });
      expect(resLimitExceed.isError).toBe(true);
      expect(resLimitExceed.text).toContain('exceeds maximum allowed (10000)');

      const resDepthZero = await client.callTool('list_dir', {
        max_depth: 0,
      });
      expect(resDepthZero.isError).toBe(true);
      expect(resDepthZero.text).toContain('is less than minimum allowed (1)');
    });
  });

  describe('read state preservation across partial reads', () => {
    it('preserves complete-read status when an unchanged file is later partially read', async () => {
      const filePath = join(testWorkspace, 'full-then-part.txt');
      writeFileSync(filePath, 'line 1\nline 2\nline 3\nline 4\nline 5\n', 'utf8');

      // 1. Complete read
      const fullRead = await client.callTool('read_file', { file_path: 'full-then-part.txt' });
      expect(fullRead.isError).toBeFalsy();

      // 2. Later partial read of line 1
      const partRead = await client.callTool('read_file', {
        file_path: 'full-then-part.txt',
        offset: 1,
        limit: 1,
      });
      expect(partRead.isError).toBeFalsy();

      // 3. Whole-file replacement via write_file must succeed because file was completely read
      const writeRes = await client.callTool('write_file', {
        file_path: 'full-then-part.txt',
        content: 'completely replaced content\n',
      });
      expect(writeRes.isError).toBeFalsy();
      expect(readFileSync(filePath, 'utf8')).toBe('completely replaced content\n');
    });
  });

  describe('newline normalization in edit_file', () => {
    it('normalizes LF replacement text to CRLF when existing file is CRLF', async () => {
      const crlfPath = join(testWorkspace, 'crlf-test.yaml');
      writeFileSync(crlfPath, 'apiVersion: v1\r\nkind: Namespace\r\nmetadata:\r\n  name: rti\r\n', 'utf8');

      await client.callTool('read_file', { file_path: 'crlf-test.yaml' });

      // Model supplies LF new_string against CRLF file
      const editRes = await client.callTool('edit_file', {
        file_path: 'crlf-test.yaml',
        old_string: '  name: rti',
        new_string: '  name: rti\n  # Added comment line',
      });
      expect(editRes.isError).toBeFalsy();

      const rawBytes = readFileSync(crlfPath);
      const text = rawBytes.toString('utf8');
      expect(text).toContain('  name: rti\r\n  # Added comment line\r\n');

      // Assert complete resulting bytes use the original CRLF convention (no lone LF)
      const crlfCount = (text.match(/\r\n/g) || []).length;
      const totalLfCount = (text.match(/\n/g) || []).length;
      expect(crlfCount).toBe(5);
      expect(totalLfCount).toBe(crlfCount);
      expect(text).not.toMatch(/[^\r]\n/);
    });

    it('normalizes CRLF replacement text to LF when existing file is LF', async () => {
      const lfPath = join(testWorkspace, 'lf-test.yaml');
      writeFileSync(lfPath, 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: rti\n', 'utf8');

      await client.callTool('read_file', { file_path: 'lf-test.yaml' });

      // Model supplies CRLF new_string against LF file
      const editRes = await client.callTool('edit_file', {
        file_path: 'lf-test.yaml',
        old_string: '  name: rti',
        new_string: '  name: rti\r\n  # Added comment line',
      });
      expect(editRes.isError).toBeFalsy();

      const rawBytes = readFileSync(lfPath);
      const text = rawBytes.toString('utf8');
      expect(text).toContain('  name: rti\n  # Added comment line\n');

      // Assert complete resulting bytes use the original LF convention (no CR at all)
      expect(text).not.toContain('\r');
      expect((text.match(/\n/g) || []).length).toBe(5);
    });

    it('does not alter genuinely mixed line endings outside the replacement', async () => {
      const mixedPath = join(testWorkspace, 'mixed-test.txt');
      // Line 1 is CRLF, Line 2 is LF, Line 3 is CRLF
      writeFileSync(mixedPath, 'line 1\r\nline 2\nline 3\r\n', 'utf8');

      await client.callTool('read_file', { file_path: 'mixed-test.txt' });

      const editRes = await client.callTool('edit_file', {
        file_path: 'mixed-test.txt',
        old_string: 'line 2',
        new_string: 'line 2 replaced',
      });
      expect(editRes.isError).toBeFalsy();

      const text = readFileSync(mixedPath, 'utf8');
      // line 1 is still CRLF, line 3 is still CRLF, line 2 is LF
      expect(text).toBe('line 1\r\nline 2 replaced\nline 3\r\n');
    });
  });

  describe('file metadata preservation in atomicWrite', () => {
    it.runIf(process.platform !== 'win32')('preserves executable 0755 permissions on replaced file', async () => {
      const scriptPath = join(testWorkspace, 'script.sh');
      writeFileSync(scriptPath, '#!/bin/sh\necho hello\n', { mode: 0o755 });

      // Verify initial mode has 0755 permissions
      const initialMode = statSync(scriptPath).mode & 0o777;
      expect(initialMode).toBe(0o755);

      await client.callTool('read_file', { file_path: 'script.sh' });
      const editRes = await client.callTool('edit_file', {
        file_path: 'script.sh',
        old_string: 'echo hello',
        new_string: 'echo world',
      });
      expect(editRes.isError).toBeFalsy();

      const finalMode = statSync(scriptPath).mode & 0o777;
      expect(finalMode).toBe(0o755);
    });
  });

  describe('backup cleanup error handling and deterministic failures', () => {
    it('fails with distinct cleanup error when atomicWrite backup cleanup fails', async () => {
      const filePath = join(testWorkspace, 'backup-fail.txt');
      writeFileSync(filePath, 'original content', 'utf8');

      await client.callTool('read_file', { file_path: 'backup-fail.txt' });
      await client.setFailureHook('atomic_write_backup_cleanup', 'Injected backup unlink failure');

      const editRes = await client.callTool('edit_file', {
        file_path: 'backup-fail.txt',
        old_string: 'original content',
        new_string: 'mutated content',
      });

      expect(editRes.isError).toBe(true);
      expect(editRes.text).toContain('Backup cleanup incomplete: failed to remove backup file');
      expect(editRes.text).toContain('Injected backup unlink failure');
      expect(editRes.text).toContain('Backup preserved at:');
      expect(editRes.text).toContain('Recovery path:');

      await client.setFailureHook(null);
    });

    it('fails with distinct cleanup error when move_file backup cleanup fails', async () => {
      const srcPath = join(testWorkspace, 'move-bu-src.txt');
      const destPath = join(testWorkspace, 'move-bu-dest.txt');
      writeFileSync(srcPath, 'move src', 'utf8');
      writeFileSync(destPath, 'move dest', 'utf8');

      await client.callTool('read_file', { file_path: 'move-bu-src.txt' });
      await client.callTool('read_file', { file_path: 'move-bu-dest.txt' });
      await client.setFailureHook('move_file_backup_cleanup', 'Injected move backup unlink failure');

      const moveRes = await client.callTool('move_file', {
        source_path: 'move-bu-src.txt',
        destination_path: 'move-bu-dest.txt',
        overwrite: true,
      });

      expect(moveRes.isError).toBe(true);
      expect(moveRes.text).toContain('Backup cleanup incomplete: failed to remove backup file');
      expect(moveRes.text).toContain('Injected move backup unlink failure');
      expect(moveRes.text).toContain('Backup preserved at:');
      expect(moveRes.text).toContain('Recovery path:');

      await client.setFailureHook(null);
    });

    it('fails with distinct cleanup error when copy_file backup cleanup fails', async () => {
      const srcPath = join(testWorkspace, 'copy-bu-src.txt');
      const destPath = join(testWorkspace, 'copy-bu-dest.txt');
      writeFileSync(srcPath, 'copy src', 'utf8');
      writeFileSync(destPath, 'copy dest', 'utf8');

      await client.callTool('read_file', { file_path: 'copy-bu-src.txt' });
      await client.callTool('read_file', { file_path: 'copy-bu-dest.txt' });
      await client.setFailureHook('copy_file_backup_cleanup', 'Injected copy backup unlink failure');

      const copyRes = await client.callTool('copy_file', {
        source_path: 'copy-bu-src.txt',
        destination_path: 'copy-bu-dest.txt',
        overwrite: true,
      });

      expect(copyRes.isError).toBe(true);
      expect(copyRes.text).toContain('Backup cleanup incomplete: failed to remove backup file');
      expect(copyRes.text).toContain('Injected copy backup unlink failure');
      expect(copyRes.text).toContain('Backup preserved at:');
      expect(copyRes.text).toContain('Recovery path:');

      await client.setFailureHook(null);
    });
  });

  describe('delete_file tool', () => {
    it('exposes delete_file in tools/list response', async () => {
      const res = await client.request('tools/list');
      const tools = res.result?.tools?.map((t) => t.name);
      expect(tools).toContain('delete_file');
    });

    it('fails if file has not been read in this session', async () => {
      const filePath = join(testWorkspace, 'del-unread.txt');
      writeFileSync(filePath, 'unread content\n', 'utf8');

      const res = await client.callTool('delete_file', { file_path: 'del-unread.txt' });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('File has not been read during this session. Read the file before deleting it.');
      expect(existsSync(filePath)).toBe(true);
    });

    it('fails if file was only partially read', async () => {
      const filePath = join(testWorkspace, 'del-partial.txt');
      writeFileSync(filePath, 'line 1\nline 2\nline 3\nline 4\nline 5\n', 'utf8');

      await client.callTool('read_file', { file_path: 'del-partial.txt', offset: 1, limit: 2 });

      const res = await client.callTool('delete_file', { file_path: 'del-partial.txt' });
      expect(res.isError).toBe(true);
      expect(res.text).toContain(
        'File was only partially read. A complete read is required before deleting the entire file.',
      );
      expect(existsSync(filePath)).toBe(true);
    });

    it('fails if file changed on disk since it was read', async () => {
      const filePath = join(testWorkspace, 'del-stale.txt');
      writeFileSync(filePath, 'original content\n', 'utf8');

      await client.callTool('read_file', { file_path: 'del-stale.txt' });
      writeFileSync(filePath, 'modified content\n', 'utf8');

      const res = await client.callTool('delete_file', { file_path: 'del-stale.txt' });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('The file has changed since it was last read. Read it again before deleting.');
      expect(existsSync(filePath)).toBe(true);
    });

    it('rejects deletion in read-only root', async () => {
      const roWorkspace = join(tmpdir(), `le-test-ro-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      mkdirSync(roWorkspace, { recursive: true });
      const roFile = join(roWorkspace, 'ro-file.txt');
      writeFileSync(roFile, 'read only content\n', 'utf8');

      const roClient = new TestMcpClient(['--ro', roWorkspace]);
      try {
        await roClient.callTool('read_file', { file_path: roFile });
        const res = await roClient.callTool('delete_file', { file_path: roFile });
        expect(res.isError).toBe(true);
        expect(res.text).toContain('Access denied: Path');
        expect(res.text).toContain('is inside a read-only repository.');
        expect(existsSync(roFile)).toBe(true);
      } finally {
        roClient.close();
        rmSync(roWorkspace, { recursive: true, force: true });
      }
    });

    it('rejects deleting non-regular files (directories and symlinks)', async () => {
      const subDir = join(testWorkspace, 'sub-dir');
      mkdirSync(subDir, { recursive: true });

      const resDir = await client.callTool('delete_file', { file_path: 'sub-dir' });
      expect(resDir.isError).toBe(true);
      expect(resDir.text).toContain('Refusing to delete: path is not a regular file: sub-dir');

      if (process.platform !== 'win32') {
        const targetFile = join(testWorkspace, 'target.txt');
        const linkFile = join(testWorkspace, 'link.txt');
        writeFileSync(targetFile, 'target content\n', 'utf8');
        symlinkSync(targetFile, linkFile);

        const resLink = await client.callTool('delete_file', { file_path: 'link.txt' });
        expect(resLink.isError).toBe(true);
        expect(resLink.text).toMatch(
          /(Refusing to delete: path is not a regular file|Access denied: symbolic link or junction detected)/,
        );
      }
    });

    it('successfully deletes a regular file after complete read and clears session read state', async () => {
      const filePath = join(testWorkspace, 'del-success.txt');
      writeFileSync(filePath, 'delete me\n', 'utf8');

      await client.callTool('read_file', { file_path: 'del-success.txt' });
      const delRes = await client.callTool('delete_file', { file_path: 'del-success.txt' });

      expect(delRes.isError).toBeFalsy();
      const parsed = JSON.parse(delRes.text);
      expect(parsed.success).toBe(true);
      expect(parsed.deleted).toBe(true);
      expect(existsSync(filePath)).toBe(false);

      // Attempting to delete again fails unread
      writeFileSync(filePath, 're-created\n', 'utf8');
      const secondDel = await client.callTool('delete_file', { file_path: 'del-success.txt' });
      expect(secondDel.isError).toBe(true);
      expect(secondDel.text).toContain('File has not been read during this session. Read the file before deleting it.');
    });

    it('restores file when delete_file fails after backup', async () => {
      const filePath = join(testWorkspace, 'del-rollback.txt');
      writeFileSync(filePath, 'keep me safe\n', 'utf8');

      await client.callTool('read_file', { file_path: 'del-rollback.txt' });
      await client.setFailureHook('delete_file_after_backup', 'Injected delete failure');

      const delRes = await client.callTool('delete_file', { file_path: 'del-rollback.txt' });
      expect(delRes.isError).toBe(true);
      expect(delRes.text).toContain('Failed to delete file: Injected delete failure');
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, 'utf8')).toBe('keep me safe\n');

      await client.setFailureHook(null);
    });

    it('reports rollback-incomplete error when both delete and rollback fail', async () => {
      const filePath = join(testWorkspace, 'del-rollback-fail.txt');
      writeFileSync(filePath, 'data to preserve\n', 'utf8');

      await client.callTool('read_file', { file_path: 'del-rollback-fail.txt' });
      await client.setFailureHook('delete_file_after_backup,delete_file_during_rollback', 'Injected double failure');

      const delRes = await client.callTool('delete_file', { file_path: 'del-rollback-fail.txt' });
      expect(delRes.isError).toBe(true);
      expect(delRes.text).toContain('Rollback incomplete: failed to restore deleted file');
      expect(delRes.text).toContain('Backup preserved at:');

      await client.setFailureHook(null);
    });

    it('fails with distinct cleanup error when delete_file backup unlink fails', async () => {
      const filePath = join(testWorkspace, 'del-cleanup-fail.txt');
      writeFileSync(filePath, 'cleanup test\n', 'utf8');

      await client.callTool('read_file', { file_path: 'del-cleanup-fail.txt' });
      await client.setFailureHook('delete_file_unlink', 'Injected delete unlink failure');

      const delRes = await client.callTool('delete_file', { file_path: 'del-cleanup-fail.txt' });
      expect(delRes.isError).toBe(true);
      expect(delRes.text).toContain('backup removal failed');
      expect(delRes.text).toContain('Injected delete unlink failure');
      expect(delRes.text).toContain('Original file restored at:');
      expect(delRes.text).not.toContain('Backup preserved at:');
      expect(delRes.text).not.toContain('Recovery path:');
      expect(existsSync(filePath)).toBe(true);

      await client.setFailureHook(null);
    });
  });

  describe('resource-cap byte-length enforcement', () => {
    it('rejects multibyte Unicode in write_file exceeding 10MB byte cap even if character length is smaller', async () => {
      const emojiContent = '🚀'.repeat(3_000_000);
      const res = await client.callTool('write_file', {
        file_path: 'unicode-too-large.txt',
        content: emojiContent,
      });

      expect(res.isError).toBe(true);
      expect(res.text).toContain('content size (12000000 bytes) exceeds maximum allowed limit of 10485760 bytes.');
    });

    it('rejects multibyte Unicode in edit_file replacement strings exceeding 10MB byte cap', async () => {
      const filePath = join(testWorkspace, 'edit-unicode.txt');
      writeFileSync(filePath, 'placeholder\n', 'utf8');
      await client.callTool('read_file', { file_path: 'edit-unicode.txt' });

      const emojiString = '🎉'.repeat(3_000_000);
      const res = await client.callTool('edit_file', {
        file_path: 'edit-unicode.txt',
        old_string: 'placeholder',
        new_string: emojiString,
      });

      expect(res.isError).toBe(true);
      expect(res.text).toContain('exceeds maximum allowed limit of 10485760 bytes.');
    });

    it('rejects final-size expansion in edit_file when resulting content exceeds 10MB byte cap', async () => {
      const filePath = join(testWorkspace, 'expand-size.txt');
      const chunk6MB = 'UNIQUE_ANCHOR\n' + 'A'.repeat(6 * 1024 * 1024);
      writeFileSync(filePath, chunk6MB, 'utf8');

      await client.callTool('read_file', { file_path: 'expand-size.txt' });

      const chunk5MB = 'B'.repeat(5 * 1024 * 1024);
      const res = await client.callTool('edit_file', {
        file_path: 'expand-size.txt',
        old_string: 'UNIQUE_ANCHOR',
        new_string: chunk5MB,
      });

      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/Resulting file size \(\d+ bytes\) exceeds maximum allowed limit of 10485760 bytes\./);
    });
  });

  describe('recovery artifact visibility', () => {
    it('does not blanket-hide legitimate dotfiles ending in .bak or .tmp in list_dir or grep_files', async () => {
      writeFileSync(join(testWorkspace, '.my-config.bak'), 'legacy backup config key=123\n', 'utf8');
      writeFileSync(join(testWorkspace, '.scratch.tmp'), 'temporary scratch notes key=456\n', 'utf8');

      const listRes = await client.callTool('list_dir', {});
      expect(listRes.isError).toBeFalsy();
      const entries = JSON.parse(listRes.text);
      const paths = entries.map((e: { path: string }) => e.path);
      expect(paths).toContain('.my-config.bak');
      expect(paths).toContain('.scratch.tmp');

      const grepRes = await client.callTool('grep_files', { query: 'key=' });
      expect(grepRes.isError).toBeFalsy();
      expect(grepRes.text).toContain('.my-config.bak');
      expect(grepRes.text).toContain('.scratch.tmp');
    });
  });
});
