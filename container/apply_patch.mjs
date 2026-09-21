/**
 * In-Container Structured Patch Application Helper
 *
 * Replays structured patch formats emitted by LLM workers within the container:
 * - Parses `*** Begin Patch` blocks, chunk headers, context lines, insertions, and deletions.
 * - Supports dry-run validation via `--check`.
 * - Handles string escapes (`\n`) for CLI invocations and stdin pipes.
 * - Prevents directory traversal attacks via `safePath` boundary checks.
 */

import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const checkOnly = args[0] === '--check' || args.includes('--check');
const positional = args.filter((arg) => arg !== '--check');
if (positional.length > 1) fail('usage: apply_patch [--check] [patch-file | patch-content | < structured-patch]', 64);

let rawPatch;
if (positional.length === 1) {
  const arg = positional[0];
  if (arg.trim().startsWith('*** Begin Patch')) {
    rawPatch = arg;
  } else if (existsSync(arg)) {
    try {
      rawPatch = readFileSync(arg, 'utf8');
    } catch {
      fail(`unable to read patch file: ${arg}`, 64);
    }
  } else {
    fail(`patch file not found: ${arg}`, 64);
  }
} else {
  if (process.stdin.isTTY) {
    fail('usage: apply_patch [--check] [patch-file | patch-content | < structured-patch]', 64);
  }
  try {
    rawPatch = readFileSync(0, 'utf8');
  } catch {
    fail('usage: apply_patch [--check] [patch-file | patch-content | < structured-patch]', 64);
  }
}

const worktree = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
if (worktree.status !== 0) fail('apply_patch must run inside a Git worktree', 65);
const nativeRealpath = realpathSync.native ?? realpathSync;
const root = nativeRealpath(resolve(worktree.stdout.trim()));
let patch = rawPatch.replace(/^\uFEFF/, '');
if (!patch.includes('\n') && patch.includes('\\n')) {
  patch = patch.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
}
const operations = parsePatch(patch);

const planned = new Map();
for (const operation of operations) {
  const target = safePath(root, operation.path);
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (operation.kind === 'add') {
    if (existing) {
      if (existing.isSymbolicLink()) fail(`refusing to overwrite symbolic link: ${operation.path}`);
      fail(`cannot add ${operation.path}: file already exists`);
    }
    planned.set(target, { content: operation.lines.join('\n') + (operation.lines.length ? '\n' : ''), remove: false });
    continue;
  }
  if (!existing) fail(`cannot ${operation.kind} ${operation.path}: file does not exist`);
  if (existing.isSymbolicLink()) fail(`refusing to modify symbolic link: ${operation.path}`);
  const source = planned.get(target)?.content ?? readFileSync(target, 'utf8');
  if (operation.kind === 'delete') {
    planned.set(target, { remove: true });
    continue;
  }
  planned.set(target, { content: applyHunks(source, operation.hunks, operation.path), remove: false });
}

if (!checkOnly) {
  for (const [target, change] of planned) {
    if (change.remove) {
      try {
        rmSync(target, { force: true });
      } catch {
        fail(`unable to delete ${relative(root, target)}`);
      }
    } else {
      writeFileSync(target, change.content, 'utf8');
    }
  }
}

function parsePatch(input) {
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') {
    fail('patch must start with *** Begin Patch and end with *** End Patch');
  }
  if (lines.some((line) => line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('diff --git '))) {
    fail('do not mix Git unified diffs with structured apply_patch format');
  }
  const operations = [];
  let index = 1;
  while (index < lines.length - 1) {
    const header = lines[index++];
    const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(header);
    if (!match) fail(`invalid patch section: ${header}`);
    const kind = match[1].toLowerCase();
    const path = match[2];
    const body = [];
    while (index < lines.length - 1 && !lines[index].startsWith('*** ')) body.push(lines[index++]);
    if (kind === 'add') {
      if (body.some((line) => !line.startsWith('+'))) fail(`new file ${path} must use + lines only`);
      operations.push({ kind, path, lines: body.map((line) => line.slice(1)) });
    } else if (kind === 'delete') {
      if (body.length) fail(`delete section for ${path} must not contain patch content`);
      operations.push({ kind, path });
    } else {
      operations.push({ kind, path, hunks: parseHunks(body, path) });
    }
  }
  if (!operations.length) fail('patch contains no file operations');
  return operations;
}

function parseHunks(lines, path) {
  const hunks = [];
  let current;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      current = [];
      hunks.push(current);
      continue;
    }
    if (!current || !/^[ +-]/.test(line)) fail(`invalid update line for ${path}: ${line}`);
    current.push({ type: line[0], text: line.slice(1) });
  }
  if (!hunks.length) fail(`update section for ${path} requires at least one @@ hunk`);
  return hunks;
}

function applyHunks(source, hunks, path) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const trailing = source.endsWith('\n');
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  if (trailing) lines.pop();
  let cursor = 0;
  for (const hunk of hunks) {
    const expected = hunk.filter((entry) => entry.type !== '+').map((entry) => entry.text);
    const replacement = hunk.filter((entry) => entry.type !== '-').map((entry) => entry.text);
    const position = findExact(lines, expected, cursor);
    if (position < 0) fail(`patch context did not match ${path}; re-read the current file and create a smaller patch`);
    lines.splice(position, expected.length, ...replacement);
    cursor = position + replacement.length;
  }
  return lines.join(eol) + (trailing ? eol : '');
}

function findExact(lines, expected, start) {
  if (!expected.length) return start;
  for (let index = start; index <= lines.length - expected.length; index++) {
    if (expected.every((line, offset) => lines[index + offset] === line)) return index;
  }
  return -1;
}

function safePath(root, requested) {
  if (!requested || isAbsolute(requested) || requested.includes('\\') || requested.includes(':')) {
    fail(`invalid relative path: ${requested}`);
  }
  const target = resolve(root, requested);
  const relativeTarget = relative(root, target);
  if (
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(relativeTarget) ||
    relativeTarget === '' ||
    /(?:^|[\\/])(?:\.git|git~\d+)(?:[\\/]|$)/i.test(relativeTarget)
  ) {
    fail(`path escapes worktree: ${requested}`);
  }
  if (!existsSync(dirname(target))) fail(`parent directory does not exist: ${dirname(requested)}`);
  const actualParent = nativeRealpath(dirname(target));
  const relativeParent = relative(root, actualParent);
  if (
    relativeParent === '..' ||
    relativeParent.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(relativeParent) ||
    /(?:^|[\\/])(?:\.git|git~\d+)(?:[\\/]|$)/i.test(relativeParent)
  ) {
    fail(`path escapes worktree through symbolic link: ${requested}`);
  }
  return target;
}

function fail(message, code = 1) {
  process.stderr.write(`apply_patch: ${message}\n`);
  process.exit(code);
}
