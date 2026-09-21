import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createTarHeader, streamDirectoryToTar } from '../src/tar-stream.js';

describe('tar stream generator', () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates a valid 512-byte tar header with checksum and magic', () => {
    const header = createTarHeader('test.txt', 123, '0', 0o644, 1700000000);
    expect(header.length).toBe(512);
    expect(header.toString('ascii', 257, 262)).toBe('ustar');
    expect(header.toString('utf8', 0, 8)).toBe('test.txt');

    // Verify checksum calculation
    let sum = 0;
    for (let i = 0; i < 512; i++) {
      if (i >= 148 && i < 156) {
        sum += 0x20;
      } else {
        sum += header[i];
      }
    }
    const chksumStr = header.toString('ascii', 148, 156);
    expect(parseInt(chksumStr.trim(), 8)).toBe(sum);
  });

  it('streams directories and files recursively into tar format', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tar-test-'));
    temporaryRoots.push(root);

    mkdirSync(join(root, 'nested'), { recursive: true });
    writeFileSync(join(root, 'file1.txt'), 'hello world');
    writeFileSync(join(root, 'nested', 'file2.txt'), 'nested content');

    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(chunk));

    await streamDirectoryToTar(root, stream);

    const archive = Buffer.concat(chunks);
    expect(archive.length % 512).toBe(0);
    expect(archive.length).toBeGreaterThan(1024);

    // End of archive is at least 1024 zero bytes
    const tail = archive.subarray(archive.length - 1024);
    expect(tail.every((byte) => byte === 0)).toBe(true);
  });

  it('handles paths longer than 100 characters with GNU LongLink', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tar-long-'));
    temporaryRoots.push(root);

    const longDir = 'a'.repeat(60);
    const longSubDir = 'b'.repeat(60);
    const fullDir = join(root, longDir, longSubDir);
    mkdirSync(fullDir, { recursive: true });
    writeFileSync(join(fullDir, 'long-file.txt'), 'long path content');

    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(chunk));

    await streamDirectoryToTar(root, stream);

    const archive = Buffer.concat(chunks);
    expect(archive.length % 512).toBe(0);

    // Look for GNU LongLink header in archive
    const archiveStr = archive.toString('ascii');
    expect(archiveStr).toContain('././@LongLink');
  });

  it('fails closed when a symbolic link escapes the streamed directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tar-link-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'tar-link-outside-'));
    temporaryRoots.push(root, outside);
    writeFileSync(join(outside, 'secret.txt'), 'must not be copied');
    symlinkSync(outside, join(root, 'escape'), 'junction');

    const stream = new PassThrough();
    stream.resume();
    await expect(streamDirectoryToTar(root, stream)).rejects.toThrow('TAR_SYMLINK_ESCAPE');
  });
});
