import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  it('reports a missing patch file instead of treating its name as patch content', () => {
    const directory = worktree();
    const result = spawnSync(process.execPath, [helper, '--check', 'dummy-new-file.patch'], {
      cwd: directory,
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('patch file not found: dummy-new-file.patch');
  });

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

  it('accepts patch from a patch file path or raw string argument, and deletes files', () => {
    const directory = worktree();
    const file = join(directory, 'src', 'to-delete.ts');
    writeFileSync(file, 'export const removeMe = true;\n', 'utf8');

    // Test file argument
    const patchContent = `*** Begin Patch
*** Delete File: src/to-delete.ts
*** End Patch
`;
    const patchFile = join(directory, 'delete.patch');
    writeFileSync(patchFile, patchContent, 'utf8');

    // Check with --check and patch file argument
    const checkResult = spawnSync(process.execPath, [helper, '--check', patchFile], {
      cwd: directory,
      encoding: 'utf8',
    });
    expect(checkResult.status).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('export const removeMe = true;\n');

    // Apply with patch file argument
    const applyResult = spawnSync(process.execPath, [helper, patchFile], {
      cwd: directory,
      encoding: 'utf8',
    });
    expect(applyResult.status).toBe(0);
    expect(() => readFileSync(file, 'utf8')).toThrow();

    // Test raw string argument for adding a file
    const addPatch = `*** Begin Patch
*** Add File: src/added.ts
+export const added = 100;
*** End Patch
`;
    const addResult = spawnSync(process.execPath, [helper, addPatch], {
      cwd: directory,
      encoding: 'utf8',
    });
    expect(addResult.status).toBe(0);
    expect(readFileSync(join(directory, 'src', 'added.ts'), 'utf8')).toBe('export const added = 100;\n');
  });

  it('rejects writes through a symbolic-link parent outside the worktree', () => {
    const directory = worktree();
    const outside = mkdtempSync(join(process.cwd(), '.tmp', 'worker-patch-outside-'));
    temporaryDirectories.push(outside);
    symlinkSync(outside, join(directory, 'escape'), 'junction');
    const patch = `*** Begin Patch
*** Add File: escape/leak.txt
+blocked
*** End Patch
`;

    const result = apply(directory, patch);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('path escapes worktree through symbolic link');
  });

  it('rejects adding a file over an existing or dangling symbolic link', () => {
    const directory = worktree();
    const outside = join(directory, 'nonexistent-target');
    symlinkSync(outside, join(directory, 'src', 'dangling.ts'), 'junction');
    const patch = `*** Begin Patch
*** Add File: src/dangling.ts
+malicious
*** End Patch
`;

    const result = apply(directory, patch);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refusing to overwrite symbolic link');
  });

  it('rejects Alternate Data Streams and 8.3 git alias escapes', () => {
    const directory = worktree();
    const adsPatch = `*** Begin Patch
*** Add File: src/sample.ts:hidden
+stream
*** End Patch
`;
    expect(apply(directory, adsPatch).status).not.toBe(0);
    expect(apply(directory, adsPatch).stderr).toContain('invalid relative path');

    const gitAliasPatch = `*** Begin Patch
*** Add File: GIT~1/hooks/pre-commit
+evil
*** End Patch
`;
    expect(apply(directory, gitAliasPatch).status).not.toBe(0);
    expect(apply(directory, gitAliasPatch).stderr).toContain('path escapes worktree');
  });

  it.runIf(process.platform === 'win32')(
    'PowerShell wrapper apply_patch.ps1 supports pipeline input and positional args',
    () => {
      const directory = worktree();
      const ps1Helper = fileURLToPath(new URL('../container/apply_patch.ps1', import.meta.url));

      const patchContent = `*** Begin Patch\n*** Add File: src/via-pipe.ts\n+export const piped = true;\n*** End Patch\n`;

      // Test pipeline input with --check
      const checkResult = spawnSync(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `$patch = @'\n${patchContent}'@; $patch | & '${ps1Helper}' --check`,
        ],
        {
          cwd: directory,
          encoding: 'utf8',
        },
      );
      expect(checkResult.status, checkResult.stderr).toBe(0);
      expect(() => readFileSync(join(directory, 'src', 'via-pipe.ts'), 'utf8')).toThrow();

      // Test pipeline application
      const applyResult = spawnSync(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `$patch = @'\n${patchContent}'@; $patch | & '${ps1Helper}'`,
        ],
        {
          cwd: directory,
          encoding: 'utf8',
        },
      );
      expect(applyResult.status).toBe(0);
      expect(readFileSync(join(directory, 'src', 'via-pipe.ts'), 'utf8')).toBe('export const piped = true;\n');

      // Test positional argument
      const updatePatch = `*** Begin Patch\n*** Update File: src/via-pipe.ts\n@@\n-export const piped = true;\n+export const piped = 42;\n*** End Patch\n`;
      const argResult = spawnSync(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `& '${ps1Helper}' '${updatePatch.replace(/'/g, "''")}'`,
        ],
        {
          cwd: directory,
          encoding: 'utf8',
        },
      );
      expect(argResult.status).toBe(0);
      expect(readFileSync(join(directory, 'src', 'via-pipe.ts'), 'utf8')).toBe('export const piped = 42;\n');
    },
  );
});
