#!/usr/bin/env node
/**
 * Local Engineer Container File Tools MCP Server
 *
 * Runs strictly INSIDE the running worker container and provides the model
 * with deterministic, structured primitives for file inspection and mutation:
 * - read_file: Reads exact raw file slices and records freshness metadata & observed ranges.
 * - edit_file: Performs exact text replacement in a previously read, fresh file within observed ranges.
 * - write_file: Creates a new file or replaces a completely read file atomically with rollback.
 * - delete_file: Deletes a regular file with a prior complete read and rollback protection.
 * - move_file: Moves / renames files within the workspace with backup and rollback.
 * - copy_file: Copies files within the workspace with backup and rollback.
 * - grep_files: Bounded literal and safe regex search across workspace files.
 * - list_dir: Explores directory structures without shell execution.
 *
 * All operations are strictly constrained to the configured workspace roots
 * and respect read-only vs read-write repository access ACLs.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import vm from 'node:vm';

// ============================================================================
// Resource Limits & Safety Constants
// ============================================================================

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB (10,485,760 bytes)
const MAX_FILE_SIZE = MAX_FILE_BYTES;
const MAX_READ_LIMIT = 10000; // 10,000 lines
const MAX_GREP_RESULTS = 500;
const MAX_GREP_FILES = 2000;
const MAX_GREP_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_LIST_DEPTH = 10;
const MAX_LIST_ENTRIES = 500;

// ============================================================================
// Test Failure Injection & Runtime Argument Validation
// ============================================================================

let testFailureHook = process.env.FILE_TOOLS_TEST_FAILURE_HOOK || null;
let testFailureError = 'Injected test failure';

function shouldFailHook(hookName) {
  if (!testFailureHook) return false;
  if (testFailureHook === hookName) return true;
  if (testFailureHook.includes(',') && testFailureHook.split(',').map((s) => s.trim()).includes(hookName)) {
    return true;
  }
  return false;
}

function checkTestFailureHook(hookName) {
  if (shouldFailHook(hookName)) {
    throw new Error(testFailureError);
  }
}

function validateOptionalBoolean(val, name) {
  if (val === undefined || val === null) {
    return { ok: true, value: false };
  }
  if (typeof val === 'boolean') {
    return { ok: true, value: val };
  }
  return {
    ok: false,
    error: `Invalid value for '${name}': expected boolean (true or false), received ${typeof val} (${JSON.stringify(val)}).`,
  };
}

function validateOptionalInteger(val, name, { min, max, defaultValue } = {}) {
  if (val === undefined || val === null) {
    return { ok: true, value: defaultValue };
  }
  if (typeof val !== 'number' || !Number.isFinite(val) || !Number.isInteger(val)) {
    return {
      ok: false,
      error: `Invalid value for '${name}': expected integer, received ${typeof val} (${JSON.stringify(val)}).`,
    };
  }
  if (min !== undefined && val < min) {
    return {
      ok: false,
      error: `Invalid value for '${name}': value (${val}) is less than minimum allowed (${min}).`,
    };
  }
  if (max !== undefined && val > max) {
    return {
      ok: false,
      error: `Invalid value for '${name}': value (${val}) exceeds maximum allowed (${max}).`,
    };
  }
  return { ok: true, value: val };
}

// ============================================================================
// Workspace & Path Confinement
// ============================================================================

/**
 * @typedef {Object} WorkspaceRoot
 * @property {string} path - Canonical filesystem path
 * @property {'read-write' | 'read-only'} access - Access mode
 */

const configuredRoots = parseWorkspaceRoots();

function canonicalKey(p) {
  let norm = path.resolve(p).replaceAll('\\', '/');
  if (process.platform === 'win32') {
    norm = norm.toLowerCase();
  }
  return norm.replace(/\/+$/, '');
}

function parseWorkspaceRoots() {
  const cliArgs = process.argv.slice(2);
  /** @type {WorkspaceRoot[]} */
  const roots = [];

  let idx = 0;
  while (idx < cliArgs.length) {
    const arg = cliArgs[idx];
    if (arg === '--ro' || arg === '--read-only') {
      const next = cliArgs[idx + 1];
      if (!next || next.startsWith('--')) {
        process.stderr.write(`FATAL: Missing path argument after ${arg}\n`);
        process.exit(1);
      }
      roots.push({ path: path.resolve(next), access: 'read-only' });
      idx += 2;
      continue;
    } else if (arg === '--rw' || arg === '--read-write') {
      const next = cliArgs[idx + 1];
      if (!next || next.startsWith('--')) {
        process.stderr.write(`FATAL: Missing path argument after ${arg}\n`);
        process.exit(1);
      }
      roots.push({ path: path.resolve(next), access: 'read-write' });
      idx += 2;
      continue;
    } else if (arg.startsWith('--')) {
      process.stderr.write(`FATAL: Unknown option '${arg}'\n`);
      process.exit(1);
    } else if (arg && typeof arg === 'string') {
      roots.push({ path: path.resolve(arg), access: 'read-write' });
    }
    idx++;
  }

  const envRoots = process.env.LOCAL_ENGINEER_WORKSPACE_ROOTS || process.env.CODEX_WORKSPACE_ROOT;
  if (envRoots) {
    const delimiter = process.platform === 'win32' ? ';' : ':';
    for (const p of envRoots.split(delimiter)) {
      if (p.trim()) {
        roots.push({ path: path.resolve(p.trim()), access: 'read-write' });
      }
    }
  }

  if (roots.length === 0) {
    process.stderr.write(
      'FATAL: No workspace roots configured. Explicit existing directory roots are required via --ro, --rw, or environment variables.\n'
    );
    process.exit(1);
  }

  // Canonicalize and validate roots - fail closed if any root is missing or not a directory
  /** @type {WorkspaceRoot[]} */
  const resolved = [];
  for (const r of roots) {
    try {
      const stat = fs.statSync(r.path);
      if (!stat.isDirectory()) {
        process.stderr.write(`FATAL: Workspace root '${r.path}' is not a directory.\n`);
        process.exit(1);
      }
      const canonical = fs.realpathSync(r.path);
      const existing = resolved.find((entry) => canonicalKey(entry.path) === canonicalKey(canonical));
      if (!existing) {
        resolved.push({ path: canonical, access: r.access });
      } else if (r.access === 'read-only') {
        // Read-only wins for identical canonical roots regardless of ordering
        existing.access = 'read-only';
      }
    } catch (err) {
      process.stderr.write(`FATAL: Workspace root '${r.path}' could not be resolved: ${err.message}\n`);
      process.exit(1);
    }
  }

  if (resolved.length === 0) {
    process.stderr.write('FATAL: No valid workspace roots resolved.\n');
    process.exit(1);
  }

  return resolved;
}

function findWorkspaceRoot(targetPath) {
  const normTarget = canonicalKey(targetPath);
  let bestRoot = null;
  let bestLen = -1;
  for (const root of configuredRoots) {
    const normRoot = canonicalKey(root.path);
    const matches =
      normTarget === normRoot ||
      (normRoot === '' ? normTarget.startsWith('/') : normTarget.startsWith(normRoot + '/'));
    if (matches && normRoot.length > bestLen) {
      bestRoot = root;
      bestLen = normRoot.length;
    }
  }
  return bestRoot;
}

const RESERVED_DEVICE_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

function assertValidPathCharacters(requestedPath) {
  if (!requestedPath || typeof requestedPath !== 'string') {
    throw new Error('file_path is required and must be a string.');
  }

  if (requestedPath.length > 2048) {
    throw new Error('Path exceeds maximum length of 2048 characters.');
  }

  if (/[\0\r\n]/.test(requestedPath)) {
    throw new Error('Invalid path: contains illegal control characters.');
  }

  if (process.platform === 'win32') {
    const withoutDrive = requestedPath.replace(/^[a-zA-Z]:[\\/]/, '');
    if (withoutDrive.includes(':')) {
      throw new Error('Invalid path: Alternate Data Streams are forbidden.');
    }
  }

  const segments = requestedPath.split(/[\\/]/);
  for (const seg of segments) {
    const base = seg.split('.')[0].toLowerCase();
    if (RESERVED_DEVICE_NAMES.has(base)) {
      throw new Error(`Invalid path: Windows reserved device name '${seg}' is forbidden.`);
    }
  }
}

function assertNoReparsePointsOrSymlinks(targetPath, rootPath) {
  let current = path.resolve(targetPath);
  const canonicalRoot = canonicalKey(rootPath);
  while (current && canonicalKey(current).length >= canonicalRoot.length) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Access denied: symbolic link or junction detected at '${current}'.`);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function resolveSecureWorkspacePath(requestedPath, requireWritable = false, allowNonexistentLeaf = false) {
  assertValidPathCharacters(requestedPath);

  const primaryRoot = configuredRoots[0].path;
  const resolved = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(primaryRoot, requestedPath);

  const matchedRoot = findWorkspaceRoot(resolved);
  if (!matchedRoot) {
    throw new Error(
      `Access denied: Path '${requestedPath}' resolves outside the allowed workspace (${configuredRoots.map((r) => r.path).join(', ')}).`
    );
  }

  // Check every path component starting from root down to resolved
  const relFromRoot = path.relative(matchedRoot.path, resolved);
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
    throw new Error(`Access denied: Path '${requestedPath}' traverses outside the workspace.`);
  }

  const segments = relFromRoot ? relFromRoot.split(/[\\/]/) : [];
  let current = matchedRoot.path;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    current = path.join(current, seg);

    try {
      const lstat = fs.lstatSync(current);
      if (lstat.isSymbolicLink()) {
        throw new Error(`Access denied: symbolic link or junction detected at '${current}'.`);
      }
      const real = fs.realpathSync(current);
      if (!findWorkspaceRoot(real)) {
        throw new Error(`Access denied: Path component '${current}' resolves outside the allowed workspace.`);
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        if (!allowNonexistentLeaf) {
          throw new Error(`File not found: ${requestedPath}`);
        }
        // Non-existent ancestor or leaf during creation is allowed if remaining segments are inside workspace
        break;
      } else {
        throw err;
      }
    }
  }

  const relativeNormalized = relFromRoot.replaceAll('\\', '/');

  // Git metadata lockdown (.git and 8.3 git~1)
  if (/(?:^|[\\/])(?:\.git|git~\d+)(?:[\\/]|$)/i.test(relativeNormalized)) {
    throw new Error('Access denied: access to Git repository metadata (.git) is forbidden.');
  }

  if (requireWritable) {
    if (matchedRoot.access === 'read-only') {
      throw new Error(`Access denied: Path '${requestedPath}' is inside a read-only repository.`);
    }

    if (/(?:^|[\\/])(?:node_modules|\.local-engineer|local-engineer-dependencies)(?:[\\/]|$)/i.test(relativeNormalized)) {
      throw new Error('Access denied: modification of dependencies or internal directories is forbidden.');
    }
  }

  assertNoReparsePointsOrSymlinks(resolved, matchedRoot.path);

  return resolved;
}

// ============================================================================
// Per-Session Read State Tracking
// ============================================================================

/**
 * @typedef {Object} ObservedRange
 * @property {number} startChar
 * @property {number} endChar
 * @property {number} startLine
 * @property {number} endLine
 */

/**
 * @typedef {Object} FileReadState
 * @property {string} path - Canonical file path
 * @property {string} contentHash - SHA-256 digest of entire file
 * @property {number} fileSize - Size in bytes
 * @property {number} mtimeMs - Last modified timestamp in ms
 * @property {number} readTimestamp - When the file was read in ms
 * @property {boolean} isCompleteRead - True if the entire file was read
 * @property {ObservedRange[]} observedRanges - Character and line ranges observed
 */

const sessionReadState = new Map();

function hashContent(bufferOrString) {
  return crypto.createHash('sha256').update(bufferOrString).digest('hex');
}

function getFileDiskState(resolvedPath) {
  if (!fs.existsSync(resolvedPath)) return null;
  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) return null;
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(`File size (${stat.size} bytes) exceeds maximum supported size of ${MAX_FILE_SIZE} bytes.`);
  }
  const buffer = fs.readFileSync(resolvedPath);
  const contentHash = hashContent(buffer);
  return {
    stat,
    buffer,
    contentHash,
    fileSize: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function verifyFreshness(resolvedPath, requireCompleteRead = false, action = requireCompleteRead ? 'overwriting' : 'editing') {
  const key = canonicalKey(resolvedPath);
  const recorded = sessionReadState.get(key);
  if (!recorded) {
    return {
      ok: false,
      error: `File has not been read during this session. Read the file before ${action} it.`,
    };
  }

  if (requireCompleteRead && !recorded.isCompleteRead) {
    const requiredAction = action === 'deleting' ? 'deleting' : 'replacing';
    return {
      ok: false,
      error: `File was only partially read. A complete read is required before ${requiredAction} the entire file.`,
    };
  }

  const current = getFileDiskState(resolvedPath);
  if (!current) {
    return {
      ok: false,
      error: 'The file has changed or was deleted since it was last read. Read the file again.',
    };
  }

  if (
    current.contentHash !== recorded.contentHash ||
    current.fileSize !== recorded.fileSize ||
    current.mtimeMs !== recorded.mtimeMs
  ) {
    return {
      ok: false,
      error: `The file has changed since it was last read. Read it again before ${action}.`,
    };
  }

  return { ok: true, current, recorded };
}

// ============================================================================
// Atomic Write Helper with Backup & Rollback
// ============================================================================

function atomicWrite(resolvedPath, contentString) {
  const contentBytes = Buffer.byteLength(contentString, 'utf8');
  if (contentBytes > MAX_FILE_BYTES) {
    throw new Error(`File content size (${contentBytes} bytes) exceeds maximum supported size of ${MAX_FILE_BYTES} bytes.`);
  }

  const existingStat = fs.lstatSync(resolvedPath, { throwIfNoEntry: false });
  if (existingStat && (existingStat.isSymbolicLink() || !existingStat.isFile())) {
    throw new Error(`Refusing to write: target is not a regular file: ${resolvedPath}`);
  }

  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const base = path.basename(resolvedPath);
  const tempPath = path.join(dir, `.${base}.local-engineer-temp-${crypto.randomBytes(6).toString('hex')}.tmp`);
  const backupPath = path.join(dir, `.${base}.local-engineer-backup-${crypto.randomBytes(6).toString('hex')}.bak`);
  const targetExisted = Boolean(existingStat);
  // On POSIX platforms, preserve original regular file permission mode (including executable bits such as 0755).
  // On Windows platforms, files inherit directory ACLs without alteration; Windows ignores POSIX mode bits except read-only.
  const targetMode = targetExisted ? existingStat.mode & 0o777 : 0o666;

  try {
    fs.writeFileSync(tempPath, contentString, { encoding: 'utf8', mode: targetMode });
    if (targetExisted && process.platform !== 'win32') {
      try {
        fs.chmodSync(tempPath, targetMode);
      } catch {
        // ignore if chmod not supported
      }
    }

    if (targetExisted) {
      // Step 1: Backup existing target
      fs.renameSync(resolvedPath, backupPath);
      checkTestFailureHook('atomic_write_after_backup');

      // Step 2: Move temp to target
      try {
        fs.renameSync(tempPath, resolvedPath);
        if (process.platform !== 'win32') {
          try {
            fs.chmodSync(resolvedPath, targetMode);
          } catch {
            // ignore
          }
        }
        checkTestFailureHook('atomic_write_after_replacement');
      } catch (renameErr) {
        // Rollback from backup!
        try {
          if (fs.existsSync(resolvedPath)) {
            try {
              fs.unlinkSync(resolvedPath);
            } catch {
              // ignore
            }
          }
          if (fs.existsSync(backupPath)) {
            checkTestFailureHook('atomic_write_during_rollback');
            fs.renameSync(backupPath, resolvedPath);
          }
        } catch (rollbackErr) {
          throw new Error(
            `Rollback incomplete: failed to restore original file (${rollbackErr.message}). Original backup preserved at: ${backupPath}. Original error: ${renameErr.message}`
          );
        }
        throw renameErr;
      }

      // Step 3: Delete backup on success
      try {
        checkTestFailureHook('atomic_write_backup_cleanup');
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      } catch (cleanupErr) {
        throw new Error(
          `Backup cleanup incomplete: failed to remove backup file (${cleanupErr.message}). Target modified at: ${resolvedPath}. Backup preserved at: ${backupPath}. Recovery path: verify target file and remove backup at ${backupPath}.`
        );
      }
    } else {
      fs.renameSync(tempPath, resolvedPath);
      checkTestFailureHook('atomic_write_after_replacement');
    }
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // ignore
    }
    if (targetExisted && fs.existsSync(backupPath) && !fs.existsSync(resolvedPath)) {
      try {
        checkTestFailureHook('atomic_write_during_rollback');
        fs.renameSync(backupPath, resolvedPath);
      } catch (rollbackErr) {
        throw new Error(
          `Rollback incomplete: failed to restore original file (${rollbackErr.message}). Original backup preserved at: ${backupPath}. Original error: ${err.message}`
        );
      }
    } else if (!targetExisted && fs.existsSync(resolvedPath)) {
      try {
        checkTestFailureHook('atomic_write_during_rollback');
        fs.unlinkSync(resolvedPath);
      } catch (rollbackErr) {
        throw new Error(
          `Rollback incomplete: failed to remove newly created file (${rollbackErr.message}). File location: ${resolvedPath}. Original error: ${err.message}`
        );
      }
    }
    throw err;
  }

  const diskState = getFileDiskState(resolvedPath);
  if (diskState) {
    const totalLines = contentString.split(/\r?\n/).length;
    sessionReadState.set(canonicalKey(resolvedPath), {
      path: resolvedPath,
      contentHash: diskState.contentHash,
      fileSize: diskState.fileSize,
      mtimeMs: diskState.mtimeMs,
      readTimestamp: Date.now(),
      isCompleteRead: true,
      observedRanges: [{ startChar: 0, endChar: contentString.length, startLine: 1, endLine: totalLines }],
    });
  }
}

// ============================================================================
// Tool Implementations
// ============================================================================

function toolReadFile(args) {
  if (!args || typeof args !== 'object') {
    return { isError: true, text: 'Arguments object is required.' };
  }
  const resolvedPath = resolveSecureWorkspacePath(args.file_path, false, false);

  if (!fs.existsSync(resolvedPath)) {
    return { isError: true, text: `File not found: ${args.file_path}` };
  }

  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) {
    return { isError: true, text: `Path is not a regular file: ${args.file_path}` };
  }

  const diskState = getFileDiskState(resolvedPath);
  if (!diskState) {
    return { isError: true, text: `Failed to read file: ${args.file_path}` };
  }

  const fullText = diskState.buffer.toString('utf8');
  const rawLines = fullText.split(/\r?\n/);
  const totalLines = rawLines.length;

  const offsetValidation = validateOptionalInteger(args.offset, 'offset', { min: 1, defaultValue: 1 });
  if (!offsetValidation.ok) {
    return { isError: true, text: offsetValidation.error };
  }
  const offset = offsetValidation.value;

  const limitValidation = validateOptionalInteger(args.limit, 'limit', { min: 0, max: MAX_READ_LIMIT });
  if (!limitValidation.ok) {
    return { isError: true, text: limitValidation.error };
  }
  const limit = limitValidation.value;

  const startIdx = offset - 1;
  if (startIdx >= totalLines && totalLines > 0) {
    return { isError: true, text: `offset (${offset}) exceeds total line count (${totalLines}).` };
  }

  const endIdx = limit !== undefined ? Math.min(totalLines, startIdx + limit) : totalLines;
  const isCompleteRead = startIdx === 0 && endIdx >= totalLines;

  // Calculate character range in fullText for the slice
  let charStart = 0;
  for (let i = 0; i < startIdx; i++) {
    const nextNl = fullText.indexOf('\n', charStart);
    if (nextNl === -1) {
      charStart = fullText.length;
      break;
    }
    charStart = nextNl + 1;
  }

  let charEnd = charStart;
  for (let i = startIdx; i < endIdx; i++) {
    const nextNl = fullText.indexOf('\n', charEnd);
    if (nextNl === -1) {
      charEnd = fullText.length;
      break;
    }
    charEnd = nextNl + 1;
  }
  if (endIdx >= totalLines) {
    charEnd = fullText.length;
  }

  const rawSlice = fullText.slice(charStart, charEnd);

  const key = canonicalKey(resolvedPath);
  const existingState = sessionReadState.get(key);
  const sameHash = existingState && existingState.contentHash === diskState.contentHash;
  let observedRanges = [];
  if (sameHash) {
    observedRanges = [...existingState.observedRanges];
  }
  if (isCompleteRead) {
    observedRanges = [{ startChar: 0, endChar: fullText.length, startLine: 1, endLine: totalLines }];
  } else {
    observedRanges.push({ startChar: charStart, endChar: charEnd, startLine: startIdx + 1, endLine: endIdx });
  }

  // Preserve complete-read status if file was already completely read and content is unchanged
  let finalIsCompleteRead = isCompleteRead || Boolean(sameHash && existingState.isCompleteRead);

  if (finalIsCompleteRead) {
    observedRanges = [{ startChar: 0, endChar: fullText.length, startLine: 1, endLine: totalLines }];
  } else {
    observedRanges.sort((a, b) => a.startChar - b.startChar);
    const merged = [observedRanges[0]];
    for (let i = 1; i < observedRanges.length; i++) {
      const cur = observedRanges[i];
      const prev = merged[merged.length - 1];
      if (cur.startChar <= prev.endChar) {
        prev.endChar = Math.max(prev.endChar, cur.endChar);
        prev.startLine = Math.min(prev.startLine, cur.startLine);
        prev.endLine = Math.max(prev.endLine, cur.endLine);
      } else {
        merged.push({ ...cur });
      }
    }
    observedRanges = merged;
    if (
      observedRanges.length === 1 &&
      observedRanges[0].startChar === 0 &&
      observedRanges[0].endChar >= fullText.length
    ) {
      finalIsCompleteRead = true;
    }
  }

  sessionReadState.set(key, {
    path: resolvedPath,
    contentHash: diskState.contentHash,
    fileSize: diskState.fileSize,
    mtimeMs: diskState.mtimeMs,
    readTimestamp: Date.now(),
    isCompleteRead: finalIsCompleteRead,
    observedRanges,
  });

  return {
    text: rawSlice,
    structuredContent: {
      path: args.file_path,
      start_line: startIdx + 1,
      end_line: endIdx,
      total_lines: totalLines,
    },
  };
}

function detectDominantNewline(content) {
  const crlfCount = (content.match(/\r\n/g) || []).length;
  const totalLfCount = (content.match(/\n/g) || []).length;
  const loneLfCount = totalLfCount - crlfCount;
  if (crlfCount > loneLfCount) {
    return '\r\n';
  }
  if (loneLfCount > 0) {
    return '\n';
  }
  return null;
}

function normalizeNewlines(str, targetNewline) {
  if (!targetNewline || typeof str !== 'string') return str;
  return str.replace(/\r\n|\r|\n/g, targetNewline);
}

function toolEditFile(args) {
  if (!args || typeof args !== 'object') {
    return { isError: true, text: 'Arguments object is required.' };
  }
  if (typeof args.old_string !== 'string' || args.old_string.length === 0) {
    return { isError: true, text: 'old_string is required and cannot be empty.' };
  }
  if (typeof args.new_string !== 'string') {
    return { isError: true, text: 'new_string is required and must be a string.' };
  }
  const oldBytes = Buffer.byteLength(args.old_string, 'utf8');
  const newBytes = Buffer.byteLength(args.new_string, 'utf8');
  if (oldBytes > MAX_FILE_BYTES || newBytes > MAX_FILE_BYTES) {
    return {
      isError: true,
      text: `old_string (${oldBytes} bytes) or new_string (${newBytes} bytes) exceeds maximum allowed limit of ${MAX_FILE_BYTES} bytes.`,
    };
  }

  const resolvedPath = resolveSecureWorkspacePath(args.file_path, true, false);

  const freshness = verifyFreshness(resolvedPath, false);
  if (!freshness.ok) {
    return { isError: true, text: freshness.error };
  }

  const currentContent = freshness.current.buffer.toString('utf8');
  const dominantNewline = detectDominantNewline(currentContent);
  const oldString = args.old_string;
  const newString = args.new_string;
  const normalizedNewString = dominantNewline ? normalizeNewlines(newString, dominantNewline) : newString;

  const replaceAllValidation = validateOptionalBoolean(args.replace_all, 'replace_all');
  if (!replaceAllValidation.ok) {
    return { isError: true, text: replaceAllValidation.error };
  }
  const replaceAll = replaceAllValidation.value;

  // Re-verify symlinks / junctions right before mutation
  const matchedRoot = findWorkspaceRoot(resolvedPath);
  if (matchedRoot) {
    assertNoReparsePointsOrSymlinks(resolvedPath, matchedRoot.path);
  }

  // Find exact matches
  const matchIndices = [];
  let pos = 0;
  while ((pos = currentContent.indexOf(oldString, pos)) !== -1) {
    matchIndices.push(pos);
    pos += oldString.length;
  }

  let finalContent;
  let count = matchIndices.length;

  if (count > 0) {
    // Require each match to be wholly within an observed range unless complete read was performed
    if (!freshness.recorded.isCompleteRead) {
      for (const idx of matchIndices) {
        const matchEnd = idx + oldString.length;
        const inside = freshness.recorded.observedRanges.some(
          (r) => idx >= r.startChar && matchEnd <= r.endChar
        );
        if (!inside) {
          return {
            isError: true,
            text: 'File was only partially read and target edit region was not observed in this session. Read the relevant region before editing.',
          };
        }
      }
    }

    if (count > 1 && !replaceAll) {
      return {
        isError: true,
        text: `old_string matched ${count} locations.\nProvide more surrounding context so the match is unique, or use replace_all=true if every occurrence should be changed.`,
      };
    }

    if (replaceAll) {
      finalContent = currentContent.replaceAll(oldString, normalizedNewString);
    } else {
      const idx = matchIndices[0];
      finalContent = currentContent.slice(0, idx) + normalizedNewString + currentContent.slice(idx + oldString.length);
    }
  } else {
    // Check if normalized old_string matches directly (e.g. model gave LF old_string against CRLF file or vice-versa)
    const normalizedOldString = dominantNewline ? normalizeNewlines(oldString, dominantNewline) : oldString;
    const normMatches = [];
    if (normalizedOldString !== oldString) {
      let normPos = 0;
      while ((normPos = currentContent.indexOf(normalizedOldString, normPos)) !== -1) {
        normMatches.push(normPos);
        normPos += normalizedOldString.length;
      }
    }

    if (normMatches.length > 0) {
      if (!freshness.recorded.isCompleteRead) {
        for (const idx of normMatches) {
          const matchEnd = idx + normalizedOldString.length;
          const inside = freshness.recorded.observedRanges.some(
            (r) => idx >= r.startChar && matchEnd <= r.endChar
          );
          if (!inside) {
            return {
              isError: true,
              text: 'File was only partially read and target edit region was not observed in this session. Read the relevant region before editing.',
            };
          }
        }
      }

      if (normMatches.length > 1 && !replaceAll) {
        return {
          isError: true,
          text: `old_string matched ${normMatches.length} locations.\nProvide more surrounding context so the match is unique, or use replace_all=true if every occurrence should be changed.`,
        };
      }

      if (replaceAll) {
        finalContent = currentContent.replaceAll(normalizedOldString, normalizedNewString);
      } else {
        const idx = normMatches[0];
        finalContent = currentContent.slice(0, idx) + normalizedNewString + currentContent.slice(idx + normalizedOldString.length);
      }
      count = normMatches.length;
    } else {
      return {
        isError: true,
        text: 'old_string was not found in the current file.\nRead the relevant region again and construct a replacement using the exact current text.',
      };
    }
  }

  const finalContentBytes = Buffer.byteLength(finalContent, 'utf8');
  if (finalContentBytes > MAX_FILE_BYTES) {
    return {
      isError: true,
      text: `Resulting file size (${finalContentBytes} bytes) exceeds maximum allowed limit of ${MAX_FILE_BYTES} bytes.`,
    };
  }

  try {
    atomicWrite(resolvedPath, finalContent);
  } catch (err) {
    return { isError: true, text: `Failed to edit file: ${err.message}` };
  }

  return {
    text: JSON.stringify(
      {
        success: true,
        file_path: args.file_path,
        replacements: count,
      },
      null,
      2
    ),
  };
}

function toolWriteFile(args) {
  if (!args || typeof args !== 'object') {
    return { isError: true, text: 'Arguments object is required.' };
  }
  if (typeof args.content !== 'string') {
    return { isError: true, text: 'content is required and must be a string.' };
  }
  const contentBytes = Buffer.byteLength(args.content, 'utf8');
  if (contentBytes > MAX_FILE_BYTES) {
    return { isError: true, text: `content size (${contentBytes} bytes) exceeds maximum allowed limit of ${MAX_FILE_BYTES} bytes.` };
  }

  const resolvedPath = resolveSecureWorkspacePath(args.file_path, true, true);

  const fileExists = fs.existsSync(resolvedPath);
  if (fileExists) {
    const freshness = verifyFreshness(resolvedPath, true, 'overwriting');
    if (!freshness.ok) {
      return { isError: true, text: freshness.error };
    }
  }

  // Re-verify symlinks / junctions right before mutation
  const matchedRoot = findWorkspaceRoot(resolvedPath);
  if (matchedRoot) {
    assertNoReparsePointsOrSymlinks(resolvedPath, matchedRoot.path);
  }

  try {
    atomicWrite(resolvedPath, args.content);
  } catch (err) {
    return { isError: true, text: `Failed to write file: ${err.message}` };
  }

  return {
    text: JSON.stringify(
      {
        success: true,
        file_path: args.file_path,
        created: !fileExists,
      },
      null,
      2
    ),
  };
}

function toolDeleteFile(args) {
  if (!args || typeof args !== 'object') {
    return { isError: true, text: 'Arguments object is required.' };
  }
  if (typeof args.file_path !== 'string' || args.file_path.trim().length === 0) {
    return { isError: true, text: 'file_path is required and must be a non-empty string.' };
  }

  const resolvedPath = resolveSecureWorkspacePath(args.file_path, true, false);

  if (!fs.existsSync(resolvedPath)) {
    return { isError: true, text: `File not found: ${args.file_path}` };
  }

  const stat = fs.lstatSync(resolvedPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { isError: true, text: `Refusing to delete: path is not a regular file: ${args.file_path}` };
  }

  const matchedRoot = findWorkspaceRoot(resolvedPath);
  if (matchedRoot) {
    assertNoReparsePointsOrSymlinks(resolvedPath, matchedRoot.path);
  }

  const freshness = verifyFreshness(resolvedPath, true, 'deleting');
  if (!freshness.ok) {
    return { isError: true, text: freshness.error };
  }

  const dir = path.dirname(resolvedPath);
  const base = path.basename(resolvedPath);
  const backupPath = path.join(dir, `.${base}.local-engineer-backup-${crypto.randomBytes(6).toString('hex')}.bak`);

  let backedUp = false;
  try {
    fs.renameSync(resolvedPath, backupPath);
    backedUp = true;
    checkTestFailureHook('delete_file_after_backup');

    try {
      checkTestFailureHook('delete_file_unlink');
      fs.unlinkSync(backupPath);
    } catch (unlinkErr) {
      try {
        checkTestFailureHook('delete_file_during_rollback');
        if (fs.existsSync(backupPath) && !fs.existsSync(resolvedPath)) {
          fs.renameSync(backupPath, resolvedPath);
        }
      } catch (rollbackErr) {
        return {
          isError: true,
          text: `Rollback incomplete: failed to restore file after delete cleanup failure (${rollbackErr.message}). Backup preserved at: ${backupPath}. Original error: ${unlinkErr.message}`,
        };
      }
      return {
        isError: true,
        text: `Failed to delete file: backup removal failed (${unlinkErr.message}). Original file restored at: ${resolvedPath}.`,
      };
    }
  } catch (err) {
    if (backedUp && fs.existsSync(backupPath) && !fs.existsSync(resolvedPath)) {
      try {
        checkTestFailureHook('delete_file_during_rollback');
        fs.renameSync(backupPath, resolvedPath);
      } catch (rollbackErr) {
        return {
          isError: true,
          text: `Rollback incomplete: failed to restore deleted file (${rollbackErr.message}). Backup preserved at: ${backupPath}. Original error: ${err.message}`,
        };
      }
    }
    return { isError: true, text: `Failed to delete file: ${err.message}` };
  }

  sessionReadState.delete(canonicalKey(resolvedPath));

  return {
    text: JSON.stringify(
      {
        success: true,
        file_path: args.file_path,
        deleted: true,
      },
      null,
      2
    ),
  };
}

function toolMoveFile(args) {
  if (!args || typeof args !== 'object') {
    return { isError: true, text: 'Arguments object is required.' };
  }
  const source = resolveSecureWorkspacePath(args.source_path, true, false);
  const destination = resolveSecureWorkspacePath(args.destination_path, true, true);
  const overwriteValidation = validateOptionalBoolean(args.overwrite, 'overwrite');
  if (!overwriteValidation.ok) {
    return { isError: true, text: overwriteValidation.error };
  }
  const overwrite = overwriteValidation.value;

  if (!fs.existsSync(source)) {
    return { isError: true, text: `Source file does not exist: ${args.source_path}` };
  }

  const srcStat = fs.lstatSync(source);
  if (!srcStat.isFile() || srcStat.isSymbolicLink()) {
    return { isError: true, text: `Source is not a regular file: ${args.source_path}` };
  }

  const srcFreshness = verifyFreshness(source, false);
  if (!srcFreshness.ok) {
    return { isError: true, text: `Source: ${srcFreshness.error}` };
  }

  const destExists = fs.existsSync(destination);
  if (destExists) {
    const destStat = fs.lstatSync(destination);
    if (!destStat.isFile() || destStat.isSymbolicLink()) {
      return { isError: true, text: `Destination is not a regular file: ${args.destination_path}` };
    }
    if (!overwrite) {
      return {
        isError: true,
        text: `Destination file already exists: ${args.destination_path}. Set overwrite=true to overwrite it.`,
      };
    }
    const destFreshness = verifyFreshness(destination, false);
    if (!destFreshness.ok) {
      return { isError: true, text: `Destination: ${destFreshness.error}` };
    }
  }

  const destDir = path.dirname(destination);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const destBase = path.basename(destination);
  const backupPath = path.join(destDir, `.${destBase}.local-engineer-backup-${crypto.randomBytes(6).toString('hex')}.bak`);

  let destBackedUp = false;
  let sourceMoved = false;
  let isExdev = false;
  let sourceCopied = false;
  let sourceUnlinked = false;

  try {
    if (destExists) {
      fs.renameSync(destination, backupPath);
      destBackedUp = true;
      checkTestFailureHook('move_file_after_backup');
    }

    try {
      if (shouldFailHook('simulate_exdev')) {
        const ex = new Error('EXDEV: cross-device link not permitted');
        ex.code = 'EXDEV';
        throw ex;
      }
      fs.renameSync(source, destination);
      sourceMoved = true;
      checkTestFailureHook('move_file_after_replacement');
    } catch (err) {
      if (err.code === 'EXDEV') {
        isExdev = true;
        fs.copyFileSync(source, destination);
        sourceCopied = true;
        fs.unlinkSync(source);
        sourceUnlinked = true;
        checkTestFailureHook('move_file_after_replacement');
      } else {
        throw err;
      }
    }

    if (destBackedUp && fs.existsSync(backupPath)) {
      try {
        checkTestFailureHook('move_file_backup_cleanup');
        fs.unlinkSync(backupPath);
      } catch (cleanupErr) {
        return {
          isError: true,
          text: `Backup cleanup incomplete: failed to remove backup file (${cleanupErr.message}). Destination modified at: ${destination}. Backup preserved at: ${backupPath}. Recovery path: verify destination file and remove backup at ${backupPath}.`,
        };
      }
    }
  } catch (err) {
    try {
      checkTestFailureHook('move_file_during_rollback');
      if (sourceMoved) {
        if (fs.existsSync(destination)) {
          fs.renameSync(destination, source);
        }
      } else if (isExdev && sourceUnlinked) {
        if (fs.existsSync(destination)) {
          fs.copyFileSync(destination, source);
          fs.unlinkSync(destination);
        }
      } else if (isExdev && sourceCopied && !sourceUnlinked) {
        if (fs.existsSync(destination)) {
          fs.unlinkSync(destination);
        }
      }

      if (destBackedUp && fs.existsSync(backupPath)) {
        if (fs.existsSync(destination)) {
          fs.unlinkSync(destination);
        }
        fs.renameSync(backupPath, destination);
      }
    } catch (rollbackErr) {
      return {
        isError: true,
        text: `Rollback incomplete: failed to restore files (${rollbackErr.message}). Original failure: ${err.message}. Recovery status: source=${source} (${fs.existsSync(source) ? 'restored' : 'missing'}), destination=${destination} (${fs.existsSync(destination) ? 'present' : 'absent'}), dest_backup=${destBackedUp && fs.existsSync(backupPath) ? backupPath : 'none'}.`,
      };
    }
    return { isError: true, text: `Failed to move file: ${err.message}` };
  }

  const srcKey = canonicalKey(source);
  const destKey = canonicalKey(destination);
  const existingState = sessionReadState.get(srcKey);
  if (existingState) {
    sessionReadState.delete(srcKey);
    sessionReadState.set(destKey, { ...existingState, path: destination });
  }

  return {
    text: JSON.stringify(
      {
        success: true,
        source_path: args.source_path,
        destination_path: args.destination_path,
      },
      null,
      2
    ),
  };
}

function toolCopyFile(args) {
  if (!args || typeof args !== 'object') {
    return { isError: true, text: 'Arguments object is required.' };
  }
  const source = resolveSecureWorkspacePath(args.source_path, false, false);
  const destination = resolveSecureWorkspacePath(args.destination_path, true, true);
  const overwriteValidation = validateOptionalBoolean(args.overwrite, 'overwrite');
  if (!overwriteValidation.ok) {
    return { isError: true, text: overwriteValidation.error };
  }
  const overwrite = overwriteValidation.value;

  if (!fs.existsSync(source)) {
    return { isError: true, text: `Source file does not exist: ${args.source_path}` };
  }

  const srcStat = fs.lstatSync(source);
  if (!srcStat.isFile() || srcStat.isSymbolicLink()) {
    return { isError: true, text: `Source is not a regular file: ${args.source_path}` };
  }

  const srcFreshness = verifyFreshness(source, false);
  if (!srcFreshness.ok) {
    return { isError: true, text: `Source: ${srcFreshness.error}` };
  }

  const destExists = fs.existsSync(destination);
  if (destExists) {
    const destStat = fs.lstatSync(destination);
    if (!destStat.isFile() || destStat.isSymbolicLink()) {
      return { isError: true, text: `Destination is not a regular file: ${args.destination_path}` };
    }
    if (!overwrite) {
      return {
        isError: true,
        text: `Destination file already exists: ${args.destination_path}. Set overwrite=true to overwrite it.`,
      };
    }
    const destFreshness = verifyFreshness(destination, false);
    if (!destFreshness.ok) {
      return { isError: true, text: `Destination: ${destFreshness.error}` };
    }
  }

  const destDir = path.dirname(destination);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const destBase = path.basename(destination);
  const tempPath = path.join(destDir, `.${destBase}.local-engineer-temp-${crypto.randomBytes(6).toString('hex')}.tmp`);
  const backupPath = path.join(destDir, `.${destBase}.local-engineer-backup-${crypto.randomBytes(6).toString('hex')}.bak`);

  try {
    fs.copyFileSync(source, tempPath);

    if (destExists) {
      fs.renameSync(destination, backupPath);
      checkTestFailureHook('copy_file_after_backup');

      try {
        fs.renameSync(tempPath, destination);
        checkTestFailureHook('copy_file_after_replacement');
      } catch (err) {
        try {
          if (fs.existsSync(destination)) fs.unlinkSync(destination);
          if (fs.existsSync(backupPath)) {
            checkTestFailureHook('copy_file_during_rollback');
            fs.renameSync(backupPath, destination);
          }
        } catch (rollbackErr) {
          return {
            isError: true,
            text: `Rollback incomplete: failed to restore destination (${rollbackErr.message}). Backup preserved at: ${backupPath}. Original failure: ${err.message}`,
          };
        }
        throw err;
      }
      try {
        checkTestFailureHook('copy_file_backup_cleanup');
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      } catch (cleanupErr) {
        return {
          isError: true,
          text: `Backup cleanup incomplete: failed to remove backup file (${cleanupErr.message}). Destination modified at: ${destination}. Backup preserved at: ${backupPath}. Recovery path: verify destination file and remove backup at ${backupPath}.`,
        };
      }
    } else {
      fs.renameSync(tempPath, destination);
      checkTestFailureHook('copy_file_after_replacement');
    }
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // ignore
    }
    if (destExists && fs.existsSync(backupPath) && !fs.existsSync(destination)) {
      try {
        checkTestFailureHook('copy_file_during_rollback');
        fs.renameSync(backupPath, destination);
      } catch (rollbackErr) {
        return {
          isError: true,
          text: `Rollback incomplete: failed to restore destination (${rollbackErr.message}). Backup preserved at: ${backupPath}. Original failure: ${err.message}`,
        };
      }
    } else if (!destExists && fs.existsSync(destination)) {
      try {
        checkTestFailureHook('copy_file_during_rollback');
        fs.unlinkSync(destination);
      } catch (rollbackErr) {
        return {
          isError: true,
          text: `Rollback incomplete: failed to remove newly created file (${rollbackErr.message}). File location: ${destination}. Original failure: ${err.message}`,
        };
      }
    }
    return { isError: true, text: `Failed to copy file: ${err.message}` };
  }

  const diskState = getFileDiskState(destination);
  if (diskState && srcFreshness.recorded) {
    sessionReadState.set(canonicalKey(destination), {
      path: destination,
      contentHash: diskState.contentHash,
      fileSize: diskState.fileSize,
      mtimeMs: diskState.mtimeMs,
      readTimestamp: Date.now(),
      isCompleteRead: srcFreshness.recorded.isCompleteRead,
      observedRanges: srcFreshness.recorded.observedRanges.map((r) => ({ ...r })),
    });
  }

  return {
    text: JSON.stringify(
      {
        success: true,
        source_path: args.source_path,
        destination_path: args.destination_path,
      },
      null,
      2
    ),
  };
}

function toolGrepFiles(args) {
  if (!args || typeof args !== 'object') {
    return { isError: true, text: 'Arguments object is required.' };
  }
  if (!args.query || typeof args.query !== 'string') {
    return { isError: true, text: 'query is required and must be a non-empty string.' };
  }
  if (args.query.length > 1000) {
    return { isError: true, text: 'query exceeds maximum allowed length of 1000 characters.' };
  }

  const searchRoot = args.path
    ? resolveSecureWorkspacePath(args.path, false, false)
    : configuredRoots[0].path;

  const isRegexValidation = validateOptionalBoolean(args.is_regex, 'is_regex');
  if (!isRegexValidation.ok) {
    return { isError: true, text: isRegexValidation.error };
  }
  const isRegex = isRegexValidation.value;

  const caseSensitiveValidation = validateOptionalBoolean(args.case_sensitive, 'case_sensitive');
  if (!caseSensitiveValidation.ok) {
    return { isError: true, text: caseSensitiveValidation.error };
  }
  const caseSensitive = caseSensitiveValidation.value;

  const maxResultsValidation = validateOptionalInteger(args.max_results, 'max_results', {
    min: 1,
    max: MAX_GREP_RESULTS,
    defaultValue: 100,
  });
  if (!maxResultsValidation.ok) {
    return { isError: true, text: maxResultsValidation.error };
  }
  const maxResults = maxResultsValidation.value;

  const includePattern = typeof args.include_pattern === 'string' ? args.include_pattern.trim() : null;

  let testLine;
  if (!isRegex) {
    // Pure literal search: linear, immune to ReDoS
    const needle = caseSensitive ? args.query : args.query.toLowerCase();
    testLine = (line) => {
      const haystack = caseSensitive ? line : line.toLowerCase();
      return haystack.includes(needle);
    };
  } else {
    // Bounded safe regex execution using vm timeout
    let compiledRegex;
    try {
      compiledRegex = new RegExp(args.query, caseSensitive ? '' : 'i');
    } catch (err) {
      return { isError: true, text: `Invalid regex pattern: ${err.message}` };
    }

    const script = new vm.Script('regex.test(line)');
    const vmContext = vm.createContext({ regex: compiledRegex, line: '' });

    testLine = (line) => {
      vmContext.line = line;
      try {
        return script.runInContext(vmContext, { timeout: 200 });
      } catch (err) {
        throw new Error(`Pattern execution timed out: ${err.message}`);
      }
    };
  }

  const matches = [];
  let scannedFiles = 0;
  let scannedBytes = 0;

  const ignoredDirs = new Set([
    '.git',
    'node_modules',
    'bin',
    'obj',
    'target',
    'dist',
    '.local-engineer',
    'dependencies',
    'local-engineer-dependencies',
    '.venv',
    '__pycache__',
  ]);

  function walk(current) {
    if (matches.length >= maxResults || scannedFiles >= MAX_GREP_FILES || scannedBytes >= MAX_GREP_BYTES) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (matches.length >= maxResults || scannedFiles >= MAX_GREP_FILES || scannedBytes >= MAX_GREP_BYTES) break;
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        if (includePattern) {
          const extMatch = includePattern.startsWith('*.') && entry.name.endsWith(includePattern.slice(1));
          const exactMatch = entry.name === includePattern;
          if (!extMatch && !exactMatch) continue;
        }

        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > 2 * 1024 * 1024) continue; // Skip files > 2MB
          scannedFiles++;
          scannedBytes += stat.size;

          const content = fs.readFileSync(fullPath);
          if (content.includes(0)) continue; // Skip binary files

          const text = content.toString('utf8');
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= maxResults) break;
            const line = lines[i];
            if (testLine(line)) {
              matches.push({
                file: path.relative(searchRoot, fullPath).replaceAll('\\', '/'),
                line_number: i + 1,
                content: line.slice(0, 500),
              });
            }
          }
        } catch (err) {
          if (err.message && err.message.includes('timed out')) {
            throw err;
          }
        }
      }
    }
  }

  try {
    if (fs.existsSync(searchRoot)) {
      const rootStat = fs.statSync(searchRoot);
      if (rootStat.isFile()) {
        if (rootStat.size > MAX_FILE_SIZE) {
          return {
            isError: true,
            text: `File size (${rootStat.size} bytes) exceeds maximum supported size of ${MAX_FILE_SIZE} bytes.`,
          };
        }
        const content = fs.readFileSync(searchRoot);
        if (!content.includes(0)) {
          const text = content.toString('utf8');
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
            if (testLine(lines[i])) {
              matches.push({
                file: path.basename(searchRoot),
                line_number: i + 1,
                content: lines[i].slice(0, 500),
              });
            }
          }
        }
      } else {
        walk(searchRoot);
      }
    }
  } catch (err) {
    if (err.message && err.message.includes('timed out')) {
      return {
        isError: true,
        text: 'Search timed out: pattern execution exceeded safe time limit (possible catastrophic backtracking).',
      };
    }
    return { isError: true, text: `Grep failed: ${err.message}` };
  }

  const formattedOutput = matches
    .map((m) => `${m.file}:${m.line_number}:${m.content}`)
    .join('\n');

  return {
    text: formattedOutput || 'No matches found.',
  };
}

function toolListDir(args) {
  if (args && typeof args !== 'object') {
    return { isError: true, text: 'Arguments must be an object.' };
  }
  const targetDir = args?.path
    ? resolveSecureWorkspacePath(args.path, false, false)
    : configuredRoots[0].path;

  const recursiveValidation = validateOptionalBoolean(args?.recursive, 'recursive');
  if (!recursiveValidation.ok) {
    return { isError: true, text: recursiveValidation.error };
  }
  const recursive = recursiveValidation.value;

  const maxDepthValidation = validateOptionalInteger(args?.max_depth, 'max_depth', {
    min: 1,
    max: MAX_LIST_DEPTH,
    defaultValue: 2,
  });
  if (!maxDepthValidation.ok) {
    return { isError: true, text: maxDepthValidation.error };
  }
  const maxDepth = maxDepthValidation.value;

  if (!fs.existsSync(targetDir)) {
    return { isError: true, text: `Directory not found: ${args?.path || '.'}` };
  }

  const stat = fs.statSync(targetDir);
  if (!stat.isDirectory()) {
    return { isError: true, text: `Path is not a directory: ${args?.path || '.'}` };
  }

  const results = [];
  const ignoredDirs = new Set(['.git', 'node_modules', '.local-engineer', 'dependencies', 'local-engineer-dependencies', '.venv']);

  function scan(current, depth) {
    if (results.length >= MAX_LIST_ENTRIES) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= MAX_LIST_ENTRIES) break;
      if (ignoredDirs.has(entry.name)) continue;

      const fullPath = path.join(current, entry.name);
      let type = 'file';
      let size = 0;
      let mtime = '';

      try {
        const entryStat = fs.lstatSync(fullPath);
        if (entryStat.isDirectory()) type = 'directory';
        else if (entryStat.isSymbolicLink()) type = 'symlink';
        size = entryStat.size;
        mtime = entryStat.mtime.toISOString();
      } catch {
        // ignore
      }

      results.push({
        path: path.relative(targetDir, fullPath).replaceAll('\\', '/'),
        type,
        size,
        modified: mtime,
      });

      if (entry.isDirectory() && recursive && depth < maxDepth) {
        scan(fullPath, depth + 1);
      }
    }
  }

  scan(targetDir, 1);

  return {
    text: JSON.stringify(results, null, 2),
  };
}

// ============================================================================
// Tool Registry & MCP Protocol Handler
// ============================================================================

const TOOLS = [
  {
    name: 'read_file',
    description:
      'Reads a text file and returns its exact raw contents. Records freshness metadata and observed ranges required before editing or writing.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file to read (absolute or relative to workspace).',
        },
        offset: {
          type: 'integer',
          description: 'Optional 1-based line number to begin reading from (default: 1).',
        },
        limit: {
          type: 'integer',
          description: 'Optional maximum number of lines to return.',
        },
      },
      required: ['file_path'],
    },
    handler: toolReadFile,
  },
  {
    name: 'edit_file',
    description:
      'Performs an exact text replacement inside a previously read, fresh file. Preferred for all normal source code modifications.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file to edit (absolute or relative to workspace).',
        },
        old_string: {
          type: 'string',
          description: 'Exact text to find and replace. Must match uniquely unless replace_all=true.',
        },
        new_string: {
          type: 'string',
          description: 'Replacement text.',
        },
        replace_all: {
          type: 'boolean',
          description: 'If true, replaces all matching occurrences. Defaults to false.',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
    handler: toolEditFile,
  },
  {
    name: 'write_file',
    description:
      'Creates a new file or intentionally replaces the entire contents of an existing file. If the file exists, it must have been completely read first.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file to write (absolute or relative to workspace).',
        },
        content: {
          type: 'string',
          description: 'Complete text content to write into the file.',
        },
      },
      required: ['file_path', 'content'],
    },
    handler: toolWriteFile,
  },
  {
    name: 'delete_file',
    description:
      'Deletes a regular file from the workspace. Requires a prior complete fresh read of the exact file during this session. Does not support deleting directories.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the regular file to delete (absolute or relative to workspace).',
        },
      },
      required: ['file_path'],
    },
    handler: toolDeleteFile,
  },
  {
    name: 'move_file',
    description: 'Moves or renames a file within the workspace with rollback on failure.',
    inputSchema: {
      type: 'object',
      properties: {
        source_path: {
          type: 'string',
          description: 'Path to the source file to move.',
        },
        destination_path: {
          type: 'string',
          description: 'Path to the destination location.',
        },
        overwrite: {
          type: 'boolean',
          description: 'If true, overwrites destination if it already exists. Defaults to false.',
        },
      },
      required: ['source_path', 'destination_path'],
    },
    handler: toolMoveFile,
  },
  {
    name: 'copy_file',
    description: 'Copies a file within the workspace with rollback on failure.',
    inputSchema: {
      type: 'object',
      properties: {
        source_path: {
          type: 'string',
          description: 'Path to the source file to copy.',
        },
        destination_path: {
          type: 'string',
          description: 'Path to the destination location.',
        },
        overwrite: {
          type: 'boolean',
          description: 'If true, overwrites destination if it already exists. Defaults to false.',
        },
      },
      required: ['source_path', 'destination_path'],
    },
    handler: toolCopyFile,
  },
  {
    name: 'grep_files',
    description:
      'Bounded text and safe regex search across workspace files. Skips binary files, dependencies, and git metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text or regex pattern to search for.',
        },
        path: {
          type: 'string',
          description: 'Optional directory or file path to search within. Defaults to the workspace root.',
        },
        is_regex: {
          type: 'boolean',
          description: 'If true, treats query as a regex pattern. Defaults to false.',
        },
        case_sensitive: {
          type: 'boolean',
          description: 'If true, performs case-sensitive matching. Defaults to false.',
        },
        include_pattern: {
          type: 'string',
          description: "Optional file filter pattern, e.g. '*.cs' or '*.ts'.",
        },
        max_results: {
          type: 'integer',
          description: 'Maximum number of matching lines to return (default: 100, max: 500).',
        },
      },
      required: ['query'],
    },
    handler: toolGrepFiles,
  },
  {
    name: 'list_dir',
    description: 'Lists files and directories in the workspace with metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path to list. Defaults to the workspace root.',
        },
        recursive: {
          type: 'boolean',
          description: 'Whether to list subdirectories recursively. Defaults to false.',
        },
        max_depth: {
          type: 'integer',
          description: 'Maximum directory depth when recursive=true (default: 2, max: 10).',
        },
      },
    },
    handler: toolListDir,
  },
];

const toolMap = new Map(TOOLS.map((t) => [t.name, t]));

function sendResponse(id, result, error) {
  const payload = { jsonrpc: '2.0', id };
  if (error) {
    payload.error = error;
  } else {
    payload.result = result;
  }
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function handleMessage(message) {
  if (!message || typeof message !== 'object') return;

  const { id, method, params } = message;

  if (method === 'initialize') {
    const protocolVersion = params?.protocolVersion || '2024-11-05';
    sendResponse(id, {
      protocolVersion,
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'local-file-tools',
        version: '1.0.0',
      },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return;
  }

  if (method === 'ping') {
    sendResponse(id, {});
    return;
  }

  if (method === 'tools/list') {
    sendResponse(id, {
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
    return;
  }

  if (process.env.NODE_ENV === 'test' || process.env.FILE_TOOLS_TEST_HOOKS === '1' || testFailureHook !== null) {
    if (method === 'test/set_failure_hook') {
      testFailureHook = params?.hook || null;
      testFailureError = params?.error || 'Injected test failure';
      sendResponse(id, { success: true, hook: testFailureHook });
      return;
    }
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    const tool = toolMap.get(name);

    if (!tool) {
      sendResponse(id, null, {
        code: -32601,
        message: `Unknown tool: ${name}`,
      });
      return;
    }

    try {
      const outcome = tool.handler(args);
      if (outcome.isError) {
        sendResponse(id, {
          isError: true,
          content: [
            {
              type: 'text',
              text: outcome.text,
            },
          ],
        });
      } else {
        const responseResult = {
          content: [
            {
              type: 'text',
              text: outcome.text,
            },
          ],
        };
        if (outcome.structuredContent) {
          responseResult.structuredContent = outcome.structuredContent;
        }
        sendResponse(id, responseResult);
      }
    } catch (err) {
      sendResponse(id, {
        isError: true,
        content: [
          {
            type: 'text',
            text: err.message || 'An unexpected error occurred during tool execution.',
          },
        ],
      });
    }
    return;
  }

  if (id !== undefined) {
    sendResponse(id, null, {
      code: -32601,
      message: `Method not found: ${method}`,
    });
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
});

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const parsed = JSON.parse(trimmed);
    handleMessage(parsed);
  } catch (err) {
    process.stderr.write(`Malformed JSON-RPC message: ${err.message}\n`);
  }
});
