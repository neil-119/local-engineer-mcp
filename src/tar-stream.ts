/**
 * In-Memory Streaming USTAR Tar Generator
 *
 * Implements a lightweight, zero-dependency streaming POSIX USTAR tar archive writer:
 * - Generates standard 512-byte header blocks with octal fields and checksums.
 * - Supports GNU `@LongLink` extension blocks for pathnames exceeding 100 characters.
 * - Streams directories and files recursively directly to a Writable stream (such as `tar.exe` stdin)
 *   with proper stream backpressure handling, avoiding buffer bloat on large snapshots.
 */

import { createReadStream, existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Writable } from 'node:stream';

/**
 * Creates a standard 512-byte POSIX ustar tar header block.
 */
export function createTarHeader(
  name: string,
  size: number,
  type: '0' | '2' | '5' | 'K' | 'L' = '0',
  mode = 0o644,
  mtime = Math.floor(Date.now() / 1000),
  linkName = '',
): Buffer {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('TAR_ENTRY_SIZE_INVALID');
  const buf = Buffer.alloc(512);
  Buffer.from(name, 'utf8').copy(buf, 0, 0, 100);
  buf.write(mode.toString(8).padStart(6, '0') + ' \0', 100, 8, 'ascii');
  buf.write('0000000\0', 108, 8, 'ascii');
  buf.write('0000000\0', 116, 8, 'ascii');
  buf.write(size.toString(8).padStart(11, '0') + ' ', 124, 12, 'ascii');
  buf.write(mtime.toString(8).padStart(11, '0') + ' ', 136, 12, 'ascii');
  buf.fill(0x20, 148, 156);
  buf.write(type, 156, 1, 'ascii');
  Buffer.from(linkName, 'utf8').copy(buf, 157, 0, 100);
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i]!;
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return buf;
}

function writeToStream(out: Writable, chunk: Buffer): Promise<void> {
  if (out.destroyed || out.closed) return Promise.reject(new Error('TAR_OUTPUT_CLOSED'));
  if (out.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('TAR_OUTPUT_CLOSED'));
    };
    const cleanup = () => {
      out.off('drain', onDrain);
      out.off('error', onError);
      out.off('close', onClose);
    };
    out.once('drain', onDrain);
    out.once('error', onError);
    out.once('close', onClose);
  });
}

async function streamFile(filePath: string, size: number, out: Writable): Promise<void> {
  let written = 0;
  for await (const chunk of createReadStream(filePath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    written += buffer.length;
    if (written > size) throw new Error(`TAR_SOURCE_CHANGED:${filePath}`);
    await writeToStream(out, buffer);
  }
  if (written !== size) throw new Error(`TAR_SOURCE_CHANGED:${filePath}`);
  const pad = (512 - (size % 512)) % 512;
  if (pad > 0) await writeToStream(out, Buffer.alloc(pad));
}

async function writeLongValue(out: Writable, value: Buffer, type: 'K' | 'L'): Promise<void> {
  const data = Buffer.concat([value, Buffer.from([0])]);
  await writeToStream(out, createTarHeader('././@LongLink', data.length, type, 0, 0));
  await writeToStream(out, data);
  const pad = (512 - (data.length % 512)) % 512;
  if (pad > 0) await writeToStream(out, Buffer.alloc(pad));
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return (
    child === '' ||
    (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
  );
}

/**
 * Recursively walks a directory on the host filesystem and streams its structure
 * and contents as a compliant USTAR archive to the provided writable stream.
 */
export async function streamDirectoryToTar(sourceDir: string, out: Writable): Promise<void> {
  out.setMaxListeners?.(0);
  const sourceRoot = realpathSync.native(sourceDir);
  const entries = await readdir(sourceRoot, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (out.destroyed || out.closed) break;
    const parent = entry.parentPath ?? (entry as unknown as { path?: string }).path ?? sourceRoot;
    const fullPath = join(parent, entry.name);
    let stat;
    try {
      stat = lstatSync(fullPath);
    } catch (cause) {
      throw new Error(`TAR_SOURCE_UNREADABLE:${fullPath}:${cause instanceof Error ? cause.message : String(cause)}`);
    }
    const relPath = relative(sourceRoot, fullPath).replace(/\\/g, '/');
    if (!relPath || relPath === '.') continue;
    if (isAbsolute(relPath) || relPath === '..' || relPath.startsWith('../'))
      throw new Error(`TAR_PATH_ESCAPE:${relPath}`);
    if (stat.isSymbolicLink()) {
      const originalTarget = readlinkSync(fullPath);
      const lexicalTarget = resolve(dirname(fullPath), originalTarget);
      const resolvedTarget = existsSync(lexicalTarget) ? realpathSync.native(lexicalTarget) : lexicalTarget;
      if (!isWithin(sourceRoot, resolvedTarget)) throw new Error(`TAR_SYMLINK_ESCAPE:${relPath}`);
      const archiveTarget = isAbsolute(originalTarget)
        ? relative(dirname(fullPath), resolvedTarget).replace(/\\/g, '/')
        : originalTarget.replace(/\\/g, '/');
      const nameBuffer = Buffer.from(relPath, 'utf8');
      const targetBuffer = Buffer.from(archiveTarget, 'utf8');
      if (nameBuffer.length > 100) await writeLongValue(out, nameBuffer, 'L');
      if (targetBuffer.length > 100) await writeLongValue(out, targetBuffer, 'K');
      await writeToStream(
        out,
        createTarHeader(relPath, 0, '2', stat.mode & 0o777 || 0o777, Math.floor(stat.mtimeMs / 1000), archiveTarget),
      );
      continue;
    }
    const resolvedPath = realpathSync.native(fullPath);
    if (!isWithin(sourceRoot, resolvedPath)) throw new Error(`TAR_PATH_ESCAPE:${relPath}`);
    const isDir = stat.isDirectory();
    if (!isDir && !stat.isFile()) throw new Error(`TAR_ENTRY_TYPE_UNSUPPORTED:${relPath}`);
    const tarPath = isDir ? (relPath.endsWith('/') ? relPath : `${relPath}/`) : relPath;
    const nameBuf = Buffer.from(tarPath, 'utf8');
    if (nameBuf.length > 100) await writeLongValue(out, nameBuf, 'L');
    const mode = isDir ? 0o755 : stat.mode & 0o777 || 0o644;
    const mtime = Math.floor(stat.mtimeMs / 1000);
    const size = isDir ? 0 : stat.size;
    await writeToStream(out, createTarHeader(nameBuf.toString('utf8'), size, isDir ? '5' : '0', mode, mtime));
    if (!isDir && size > 0) {
      await streamFile(fullPath, size, out);
    }
  }
  if (!out.destroyed && !out.closed) {
    await writeToStream(out, Buffer.alloc(1024));
    out.end();
  }
}
