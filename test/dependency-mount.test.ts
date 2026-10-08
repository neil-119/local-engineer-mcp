import fs, { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertNoManagedDependencyPaths,
  discoverDependencyMounts,
  discoverPrivateInstallTargets,
  hasNtfsShortNameAlias,
  isDependencyManifestChanged,
  isManagedDependencyPath,
  privateInstallVolumeName,
  resolvePrimaryInstallTarget,
  sanitizeVolumeSegment,
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

  describe('sanitizeVolumeSegment', () => {
    it('sanitizes special characters and limits length', () => {
      expect(sanitizeVolumeSegment('my-repo/app@v1')).toBe('my-repo-app-v1');
      expect(sanitizeVolumeSegment('a'.repeat(50))).toHaveLength(32);
    });
  });

  describe('privateInstallVolumeName', () => {
    it('generates distinct, collision-resistant volumes for long repository names sharing prefixes', () => {
      const prefix = 'le-review';
      const baseName = 'a'.repeat(32);
      const repoOne = `${baseName}-one`;
      const repoTwo = `${baseName}-two`;

      const volOne = privateInstallVolumeName(prefix, repoOne, 'node_modules');
      const volTwo = privateInstallVolumeName(prefix, repoTwo, 'node_modules');

      expect(volOne).not.toBe(volTwo);
      expect(volOne.startsWith('le-review-dep-')).toBe(true);
      expect(volTwo.startsWith('le-review-dep-')).toBe(true);
    });

    it('generates distinct volumes for distinct relative paths in the same repo', () => {
      const volRoot = privateInstallVolumeName('le-prefix', 'my-repo', 'node_modules');
      const volPkg = privateInstallVolumeName('le-prefix', 'my-repo', 'packages/pkg/node_modules');

      expect(volRoot).not.toBe(volPkg);
    });

    it('is case-insensitive and slash-agnostic in identity computation', () => {
      const vol1 = privateInstallVolumeName('le-prefix', 'MyRepo', 'packages/pkg/node_modules');
      const vol2 = privateInstallVolumeName('le-prefix', 'myrepo', 'packages\\pkg\\node_modules');

      expect(vol1).toBe(vol2);
    });
  });

  describe('isManagedDependencyPath and assertNoManagedDependencyPaths', () => {
    it('identifies managed dependency directories at root and arbitrary depth', () => {
      expect(isManagedDependencyPath('node_modules')).toBe(true);
      expect(isManagedDependencyPath('node_modules/foo/bar.js')).toBe(true);
      expect(isManagedDependencyPath('packages/new/node_modules')).toBe(true);
      expect(isManagedDependencyPath('packages/new/node_modules/dep/index.js')).toBe(true);
      expect(isManagedDependencyPath('packages/pkg/.pnpm-store')).toBe(true);
      expect(isManagedDependencyPath('packages/pkg/.pnpm-store/v10/files/abc')).toBe(true);
      expect(isManagedDependencyPath('nested/.venv/bin/activate')).toBe(true);
      expect(isManagedDependencyPath('deep/dir/.local-pkgs/lib')).toBe(true);
      expect(isManagedDependencyPath('.local-engineer-dependencies/cache')).toBe(true);
      expect(isManagedDependencyPath('sub/__pypackages__/3.10/lib')).toBe(true);
    });

    it('handles Windows case-insensitivity correctly', () => {
      expect(isManagedDependencyPath('packages/pkg/NODE_MODULES/foo.js', 'windows')).toBe(true);
      expect(isManagedDependencyPath('packages/pkg/.Pnpm-Store/foo', 'windows')).toBe(true);
      expect(isManagedDependencyPath('.VENV/bin', 'windows')).toBe(true);
    });

    it('identifies Windows 8.3 short-name aliases of managed dependency directories', () => {
      expect(isManagedDependencyPath('NODE_M~1', 'windows')).toBe(true);
      expect(isManagedDependencyPath('NODE_M~1/review-only-8dot3-proof.txt', 'windows')).toBe(true);
      expect(isManagedDependencyPath('packages/pkg/NODE_M~2/dep.js', 'windows')).toBe(true);
      expect(isManagedDependencyPath('PNPM_S~1/store', 'windows')).toBe(true);
      expect(isManagedDependencyPath('PNPM-S~1', 'windows')).toBe(true);
      expect(isManagedDependencyPath('.PNPM-~1', 'windows')).toBe(true);
      expect(isManagedDependencyPath('VENV~1/bin', 'windows')).toBe(true);
      expect(isManagedDependencyPath('.VENV~1', 'windows')).toBe(true);
      expect(isManagedDependencyPath('LOCALP~1/lib', 'windows')).toBe(true);
      expect(isManagedDependencyPath('LOCAL~1', 'windows')).toBe(true);
      expect(isManagedDependencyPath('_PYPAC~1/lib', 'windows')).toBe(true);
      expect(isManagedDependencyPath('__PYPA~1/lib', 'windows')).toBe(true);
      if (process.platform === 'win32') {
        expect(isManagedDependencyPath('NODE_M~1')).toBe(true);
        expect(isManagedDependencyPath('packages/pkg/NODE_M~1/foo.js')).toBe(true);
      }
    });

    it('identifies NTFS short-name alias patterns via hasNtfsShortNameAlias', () => {
      expect(hasNtfsShortNameAlias('NODE_M~1')).toBe(true);
      expect(hasNtfsShortNameAlias('NODE_M~1/review-only-8dot3-proof.txt')).toBe(true);
      expect(hasNtfsShortNameAlias('C:/repos/RAOS-F~1/NODE_M~1')).toBe(true);
      expect(hasNtfsShortNameAlias('src/FILE~1.TXT')).toBe(true);
      expect(hasNtfsShortNameAlias('normal_file.txt')).toBe(false);
      expect(hasNtfsShortNameAlias('src/index.ts')).toBe(false);
      expect(hasNtfsShortNameAlias('~tilde-prefix.txt')).toBe(false);
      expect(hasNtfsShortNameAlias('tilde~suffix.txt')).toBe(false);
    });

    it('does not classify legitimate project source or manifests as managed dependencies', () => {
      expect(isManagedDependencyPath('package.json')).toBe(false);
      expect(isManagedDependencyPath('packages/pkg/package.json')).toBe(false);
      expect(isManagedDependencyPath('pnpm-lock.yaml')).toBe(false);
      expect(isManagedDependencyPath('packages/pkg/pnpm-lock.yaml')).toBe(false);
      expect(isManagedDependencyPath('src/node_modules_helper.ts')).toBe(false);
      expect(isManagedDependencyPath('src/pnpm-store-config.ts')).toBe(false);
      expect(isManagedDependencyPath('README.md')).toBe(false);
    });

    it('assertNoManagedDependencyPaths throws CONTAINER_PATCH_INVALID', () => {
      expect(() => assertNoManagedDependencyPaths(['src/index.ts', 'packages/pkg/node_modules/bad.js'])).toThrow(
        /CONTAINER_PATCH_INVALID:managed_dependency_path_not_permitted:packages\/pkg\/node_modules\/bad\.js/,
      );
      expect(() => assertNoManagedDependencyPaths(['src/index.ts', 'package.json'])).not.toThrow();
    });
  });

  describe('discoverPrivateInstallTargets', () => {
    it('discovers root and subpackage node_modules targets with deterministic collision-resistant volumes', () => {
      const repo = createRepoDir();
      writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'root' }));
      const pkgA = join(repo, 'packages', 'pkg-a');
      mkdirSync(pkgA, { recursive: true });
      writeFileSync(join(pkgA, 'package.json'), JSON.stringify({ name: 'pkg-a' }));

      const targets = discoverPrivateInstallTargets('test-repo', repo, 'C:/repos/test-repo', 'le-testvol');
      expect(targets).toHaveLength(2);
      expect(targets[0]).toEqual({
        repository: 'test-repo',
        relativePath: 'node_modules',
        containerPath: 'C:/repos/test-repo/node_modules',
        volume: privateInstallVolumeName('le-testvol', 'test-repo', 'node_modules'),
      });
      expect(targets[1]).toEqual({
        repository: 'test-repo',
        relativePath: 'packages/pkg-a/node_modules',
        containerPath: 'C:/repos/test-repo/packages/pkg-a/node_modules',
        volume: privateInstallVolumeName('le-testvol', 'test-repo', 'packages/pkg-a/node_modules'),
      });
    });

    it('sorts targets stably regardless of discovery order', () => {
      const repo = createRepoDir();
      writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'root' }));
      const pkgZ = join(repo, 'packages', 'z-pkg');
      const pkgA = join(repo, 'packages', 'a-pkg');
      mkdirSync(pkgZ, { recursive: true });
      mkdirSync(pkgA, { recursive: true });
      writeFileSync(join(pkgZ, 'package.json'), JSON.stringify({ name: 'z' }));
      writeFileSync(join(pkgA, 'package.json'), JSON.stringify({ name: 'a' }));

      const targets = discoverPrivateInstallTargets('test-repo', repo, 'C:/repos/test-repo', 'le-testvol');
      expect(targets).toHaveLength(3);
      expect(targets[0]?.relativePath).toBe('node_modules');
      expect(targets[1]?.relativePath).toBe('packages/a-pkg/node_modules');
      expect(targets[2]?.relativePath).toBe('packages/z-pkg/node_modules');
    });

    it('rejects symlink repository root', () => {
      const outside = createRepoDir();
      const tempDir = createRepoDir();
      const symlinkRepo = join(tempDir, 'repo-symlink');
      symlinkSync(outside, symlinkRepo, 'junction');

      expect(() => discoverPrivateInstallTargets('repo', symlinkRepo, 'C:/repos/repo', 'le-vol')).toThrow(
        /CONTAINER_DEPENDENCY_MOUNT_UNSAFE:root_is_symlink/,
      );
    });
  });

  describe('resolvePrimaryInstallTarget', () => {
    const repos = [
      {
        name: 'repo-1',
        parentPath: 'C:/repos/repo-1',
        containerPath: 'C:/repos/repo-1',
        access: 'read-write' as const,
      },
      {
        name: 'repo-2',
        parentPath: 'C:/repos/repo-2',
        containerPath: 'C:/repos/repo-2',
        access: 'read-write' as const,
      },
      {
        name: 'repo-ro',
        parentPath: 'C:/repos/repo-ro',
        containerPath: 'C:/repos/repo-ro',
        access: 'read-only' as const,
      },
    ];

    const targets = [
      {
        repository: 'repo-1',
        relativePath: 'node_modules',
        containerPath: 'C:/repos/repo-1/node_modules',
        volume: 'vol-repo1-root',
      },
      {
        repository: 'repo-1',
        relativePath: 'packages/pkg-a/node_modules',
        containerPath: 'C:/repos/repo-1/packages/pkg-a/node_modules',
        volume: 'vol-repo1-pkga',
      },
      {
        repository: 'repo-2',
        relativePath: 'node_modules',
        containerPath: 'C:/repos/repo-2/node_modules',
        volume: 'vol-repo2-root',
      },
    ];

    it('selects non-first working repository deterministically from workingDirectory', () => {
      const selected = resolvePrimaryInstallTarget(targets, repos, 'C:/repos/repo-2');
      expect(selected).toBeDefined();
      expect(selected?.repository).toBe('repo-2');
      expect(selected?.containerPath).toBe('C:/repos/repo-2/node_modules');
    });

    it('selects nested package target when workingDirectory matches subpackage', () => {
      const selected = resolvePrimaryInstallTarget(targets, repos, 'C:/repos/repo-1/packages/pkg-a');
      expect(selected).toBeDefined();
      expect(selected?.repository).toBe('repo-1');
      expect(selected?.containerPath).toBe('C:/repos/repo-1/packages/pkg-a/node_modules');
    });

    it('falls back to root target in working repo when workingDirectory is a non-target subdirectory', () => {
      const selected = resolvePrimaryInstallTarget(targets, repos, 'C:/repos/repo-1/src');
      expect(selected).toBeDefined();
      expect(selected?.repository).toBe('repo-1');
      expect(selected?.containerPath).toBe('C:/repos/repo-1/node_modules');
    });

    it('returns undefined and never falls back across repositories when working repository is read-only', () => {
      const selected = resolvePrimaryInstallTarget(targets, repos, 'C:/repos/repo-ro');
      expect(selected).toBeUndefined();
    });

    it('returns undefined when targets array is empty or undefined', () => {
      expect(resolvePrimaryInstallTarget([], repos, 'C:/repos/repo-1')).toBeUndefined();
      expect(resolvePrimaryInstallTarget(undefined, repos, 'C:/repos/repo-1')).toBeUndefined();
    });

    it('resolves root target for single repository even without explicit workingDirectory', () => {
      const singleRepo = [repos[1]!];
      const selected = resolvePrimaryInstallTarget(targets, singleRepo);
      expect(selected).toBeDefined();
      expect(selected?.repository).toBe('repo-2');
      expect(selected?.containerPath).toBe('C:/repos/repo-2/node_modules');
    });

    it('returns undefined when explicit workingDirectory is outside every repository even with a single repo', () => {
      const singleRepo = [repos[1]!];
      const selected = resolvePrimaryInstallTarget(targets, singleRepo, 'C:/outside/custom/path');
      expect(selected).toBeUndefined();
    });
  });
});
