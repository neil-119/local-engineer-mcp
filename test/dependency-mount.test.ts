import fs, { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  discoverDependencyMounts,
  isDependencyManifestChanged,
  validateDependencyDirectory,
} from '../src/dependency-mount.js';

describe('Windows dependency mounts', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    while (temporaryDirectories.length > 0) {
      const dir = temporaryDirectories.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createRepoDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dep-mount-test-'));
    temporaryDirectories.push(dir);
    return dir;
  }

  it('discovers valid node_modules and returns structured mounts with fingerprints', () => {
    const repo = createRepoDir();
    const nodeModules = join(repo, 'node_modules');
    const pkg = join(nodeModules, 'pkg-a');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'test-repo' }));
    writeFileSync(join(pkg, 'index.js'), 'module.exports = 1;');

    const mounts = discoverDependencyMounts(repo, 'C:/repos/test-repo');
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatchObject({
      relativePath: 'node_modules',
      containerPath: 'C:/repos/test-repo/node_modules',
    });
    expect(mounts[0]?.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('allows valid in-tree junctions inside node_modules', () => {
    const repo = createRepoDir();
    const nodeModules = join(repo, 'node_modules');
    const pnpmPkg = join(nodeModules, '.pnpm', 'pkg-a@1.0.0', 'node_modules', 'pkg-a');
    const directPkg = join(nodeModules, 'pkg-a');
    mkdirSync(pnpmPkg, { recursive: true });
    writeFileSync(join(pnpmPkg, 'index.js'), 'module.exports = 2;');
    symlinkSync(pnpmPkg, directPkg, 'junction');

    expect(() => validateDependencyDirectory(nodeModules)).not.toThrow();
  });

  it('rejects junctions escaping the dependency root', () => {
    const repo = createRepoDir();
    const outside = createRepoDir();
    writeFileSync(join(outside, 'secret.env'), 'SECRET=true');

    const nodeModules = join(repo, 'node_modules');
    const directPkg = join(nodeModules, 'escaped-pkg');
    mkdirSync(nodeModules, { recursive: true });
    symlinkSync(outside, directPkg, 'junction');

    expect(() => validateDependencyDirectory(nodeModules)).toThrow(
      /CONTAINER_DEPENDENCY_MOUNT_UNSAFE:target_escapes_root/,
    );
  });

  it('rejects junctions pointing to a .git directory', () => {
    const repo = createRepoDir();
    const gitDir = join(repo, '.git');
    mkdirSync(gitDir, { recursive: true });

    const nodeModules = join(repo, 'node_modules');
    const directPkg = join(nodeModules, 'git-link');
    mkdirSync(nodeModules, { recursive: true });
    symlinkSync(gitDir, directPkg, 'junction');

    // Escapes node_modules root
    expect(() => validateDependencyDirectory(nodeModules)).toThrow(/CONTAINER_DEPENDENCY_MOUNT_UNSAFE/);
  });

  it('detects dependency manifest changes', () => {
    expect(isDependencyManifestChanged(['src/index.ts', 'package.json'])).toBe(true);
    expect(isDependencyManifestChanged(['pnpm-lock.yaml'])).toBe(true);
    expect(isDependencyManifestChanged(['pnpm-workspace.yaml'])).toBe(true);
    expect(isDependencyManifestChanged(['packages/ui/package.json'])).toBe(true);
    expect(isDependencyManifestChanged(['src/index.ts', 'src/util.ts'])).toBe(false);
  });

  it('discovers nested monorepo node_modules and sorts by containerPath length ascending', () => {
    const repo = createRepoDir();
    // Root node_modules
    const rootNodeModules = join(repo, 'node_modules', 'root-pkg');
    mkdirSync(rootNodeModules, { recursive: true });
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'monorepo-root' }));

    // Nested package node_modules
    const pkgNodeModules = join(repo, 'packages', 'ui', 'node_modules', 'ui-pkg');
    mkdirSync(pkgNodeModules, { recursive: true });
    writeFileSync(join(repo, 'packages', 'ui', 'package.json'), JSON.stringify({ name: '@monorepo/ui' }));

    const mounts = discoverDependencyMounts(repo, 'C:/repos/monorepo');
    expect(mounts).toHaveLength(2);
    expect(mounts[0]?.relativePath).toBe('node_modules');
    expect(mounts[0]?.containerPath).toBe('C:/repos/monorepo/node_modules');
    expect(mounts[1]?.relativePath).toBe('packages/ui/node_modules');
    expect(mounts[1]?.containerPath).toBe('C:/repos/monorepo/packages/ui/node_modules');
    // Ensure parent length <= child length
    expect(mounts[0]!.containerPath.length).toBeLessThan(mounts[1]!.containerPath.length);
  });

  it('updates computeDependencyFingerprint when package-level manifest changes', () => {
    const repo = createRepoDir();
    const pkgDir = join(repo, 'packages', 'ui');
    const pkgNodeModules = join(pkgDir, 'node_modules');
    mkdirSync(pkgNodeModules, { recursive: true });
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'root' }));
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'ui', version: '1.0.0' }));

    const initialFp = discoverDependencyMounts(repo, 'C:/repos/repo')[0]?.fingerprint;

    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'ui', version: '2.0.0' }));
    const updatedFp = discoverDependencyMounts(repo, 'C:/repos/repo')[0]?.fingerprint;

    expect(initialFp).toBeDefined();
    expect(updatedFp).toBeDefined();
    expect(initialFp).not.toBe(updatedFp);
  });

  it('does not follow symlinks outside repository during discovery', () => {
    const repo = createRepoDir();
    const outside = createRepoDir();
    const outsideNodeModules = join(outside, 'node_modules');
    mkdirSync(outsideNodeModules, { recursive: true });
    writeFileSync(join(outsideNodeModules, 'test.js'), '1');

    // Create symlink inside repo pointing to outside dir
    const symlinkDir = join(repo, 'linked-ext');
    symlinkSync(outside, symlinkDir, 'junction');

    const mounts = discoverDependencyMounts(repo, 'C:/repos/repo');
    expect(mounts).toHaveLength(0);
  });

  it('skips .git directories during discovery', () => {
    const repo = createRepoDir();
    const gitNodeModules = join(repo, '.git', 'node_modules');
    mkdirSync(gitNodeModules, { recursive: true });

    const mounts = discoverDependencyMounts(repo, 'C:/repos/repo');
    expect(mounts).toHaveLength(0);
  });

  it('validateDependencyDirectory rejects symlink or junction root', () => {
    const repo = createRepoDir();
    const outside = createRepoDir();
    const outsideDep = join(outside, 'node_modules');
    mkdirSync(outsideDep, { recursive: true });
    const symlinkRoot = join(repo, 'node_modules');
    symlinkSync(outsideDep, symlinkRoot, 'junction');

    expect(() => validateDependencyDirectory(symlinkRoot)).toThrow(/CONTAINER_DEPENDENCY_MOUNT_UNSAFE:root_is_symlink/);
  });

  it('validateDependencyDirectory fails closed on unreadable directory in walk', () => {
    const repo = createRepoDir();
    const nodeModules = join(repo, 'node_modules');
    const subDir = join(nodeModules, 'pkg-a');
    mkdirSync(subDir, { recursive: true });

    const readdirSpy = vi.spyOn(fs, 'readdirSync');
    // First call for nodeModules returns subDir, second call for subDir throws
    let callCount = 0;
    readdirSpy.mockImplementation((() => {
      callCount++;
      if (callCount > 1) {
        throw new Error('EACCES: permission denied');
      }
      return [
        {
          name: 'pkg-a',
          isDirectory: () => true,
          isSymbolicLink: () => false,
          isFile: () => false,
        },
      ] as unknown as fs.Dirent[];
    }) as unknown as typeof fs.readdirSync);

    expect(() => validateDependencyDirectory(nodeModules)).toThrow(
      /CONTAINER_DEPENDENCY_MOUNT_UNSAFE:unreadable_directory/,
    );
    readdirSpy.mockRestore();
  });

  it('discoverDependencyMounts rejects symlink repository root', () => {
    const outside = createRepoDir();
    const tempDir = createRepoDir();
    const symlinkRepo = join(tempDir, 'repo-link');
    symlinkSync(outside, symlinkRepo, 'junction');

    expect(() => discoverDependencyMounts(symlinkRepo, 'C:/repos/repo')).toThrow(
      /CONTAINER_DEPENDENCY_MOUNT_UNSAFE:root_is_symlink/,
    );
  });

  it('discoverDependencyMounts fails closed on unreadable directory', () => {
    const repo = createRepoDir();
    const readdirSpy = vi.spyOn(fs, 'readdirSync');
    readdirSpy.mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied');
    });

    expect(() => discoverDependencyMounts(repo, 'C:/repos/repo')).toThrow(
      /CONTAINER_DEPENDENCY_MOUNT_UNSAFE:unreadable_directory/,
    );
    readdirSpy.mockRestore();
  });
});
