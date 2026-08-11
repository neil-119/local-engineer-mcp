import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const helper = fileURLToPath(new URL('../container/apply_patch.mjs', import.meta.url));
const temporaryDirectories: string[] = [];

function worktree(): string {
  const base = join(process.cwd(), '.tmp', 'worker-patch-helper');
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, 'local-engineer-patch-'));
  temporaryDirectories.push(directory);
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  mkdirSync(join(directory, 'src'));
  return directory;
}

function apply(directory: string, patch: string, checkOnly = false) {
  return spawnSync(process.execPath, [helper, ...(checkOnly ? ['--check'] : [])], {
    cwd: directory,
    encoding: 'utf8',
    input: patch,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('container apply_patch helper', () => {
  it('checks and applies structured updates while preserving CRLF', () => {
    const directory = worktree();
    const file = join(directory, 'src', 'sample.ts');
    writeFileSync(file, 'export const answer = 41;\r\n', 'utf8');
    const patch = `*** Begin Patch
*** Update File: src/sample.ts
@@
-export const answer = 41;
+export const answer = 42;
*** End Patch
`;

    expect(apply(directory, patch, true).status).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('export const answer = 41;\r\n');
    expect(apply(directory, patch).status).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('export const answer = 42;\r\n');
  });

  it('rejects mixed Git-diff syntax and unmatched context', () => {
    const directory = worktree();
    writeFileSync(join(directory, 'src', 'sample.ts'), 'const value = 1;\n', 'utf8');
    const mixed = `*** Begin Patch
--- a/src/sample.ts
+++ b/src/sample.ts
*** End Patch
`;
    expect(apply(directory, mixed).status).not.toBe(0);
    expect(apply(directory, mixed).stderr).toContain('do not mix Git unified diffs');
    const unmatched = `*** Begin Patch
*** Update File: src/sample.ts
@@
-const missing = true;
+const value = 2;
*** End Patch
`;
    expect(apply(directory, unmatched).status).not.toBe(0);
    expect(apply(directory, unmatched).stderr).toContain('patch context did not match');
  });
});
