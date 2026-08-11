import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const checkOnly = args.length === 1 && args[0] === '--check';
if ((!checkOnly && args.length !== 0) || args.length > 1) fail('usage: apply_patch [--check] < structured-patch', 64);

const worktree = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
if (worktree.status !== 0) fail('apply_patch must run inside a Git worktree', 65);
const root = resolve(worktree.stdout.trim());
const patch = readFileSync(0, 'utf8').replace(/^\uFEFF/, '');
const operations = parsePatch(patch);

const planned = new Map();
for (const operation of operations) {
  const target = safePath(root, operation.path);
  if (operation.kind === 'add') {
    if (existsSync(target)) fail(`cannot add ${operation.path}: file already exists`);
    planned.set(target, { content: operation.lines.join('\n') + (operation.lines.length ? '\n' : ''), remove: false });
    continue;
  }
  if (!existsSync(target)) fail(`cannot ${operation.kind} ${operation.path}: file does not exist`);
  if (lstatSync(target).isSymbolicLink()) fail(`refusing to modify symbolic link: ${operation.path}`);
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
      const remove = spawnSync('rm', ['--', target]);
      if (remove.status !== 0) fail(`unable to delete ${relative(root, target)}`);
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
  if (!requested || isAbsolute(requested) || requested.includes('\\')) fail(`invalid relative path: ${requested}`);
  const target = resolve(root, requested);
  if (relative(root, target).startsWith('..') || relative(root, target) === '' || target.includes('/.git/')) {
    fail(`path escapes worktree: ${requested}`);
  }
  if (!existsSync(dirname(target))) fail(`parent directory does not exist: ${dirname(requested)}`);
  return target;
}

function fail(message, code = 1) {
  process.stderr.write(`apply_patch: ${message}\n`);
  process.exit(code);
}
