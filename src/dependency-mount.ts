/**
 * Windows Dependency Mount Discovery & Validation
 *
 * Implements strict dependency discovery and junction/reparse-point security:
 * - Scopes dependency mounts strictly to an allowlist (initially `node_modules`).
 * - Validates that all nested symbolic links and NTFS junctions resolve within
 *   the approved dependency root.
 * - Fails closed with CONTAINER_DEPENDENCY_MOUNT_UNSAFE if any link escapes,
 *   targets a UNC/device path, targets a missing path, or touches a .git directory.
 * - Computes deterministic dependency fingerprints to track manifest modifications.
 */

import { createHash } from 'node:crypto';
import fs, { existsSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';
import type { PrivateInstallTarget, RunRepository, WindowsDependencyMount } from './domain.js';

const APPROVED_DEPENDENCY_DIRECTORIES = ['node_modules'] as const;

export const DEPENDENCY_MANIFEST_FILES = [
  'pnpm-lock.yaml',
  'package.json',
  'pnpm-workspace.yaml',
  'package-lock.json',
  'yarn.lock',
] as const;

export const MANAGED_DEPENDENCY_DIR_NAMES = [
  '.local-engineer-dependencies',
  '.local-pkgs',
  '.pnpm-store',
  '.venv',
  'node_modules',
  '__pypackages__',
] as const;

export const MANAGED_DEPENDENCY_EXCLUDE_PATTERNS = MANAGED_DEPENDENCY_DIR_NAMES.flatMap((dir) => [
  `/${dir}/`,
  `${dir}/`,
  `**/${dir}/`,
  `**/${dir}/**`,
  `${dir}`,
  `**/${dir}`,
]);

export const MANAGED_DEPENDENCY_8DOT3_PATTERNS = [
  /^\.?node_m[a-z0-9_-]*~[0-9]+/i,
  /^\.?pnpm[a-z0-9_-]*~[0-9]+/i,
  /^\.?venv[a-z0-9_-]*~[0-9]+/i,
  /^\.?local[a-z0-9_-]*~[0-9]+/i,
  /^_?_?pypa[a-z0-9_-]*~[0-9]+/i,
] as const;

/**
 * Checks whether any relative path segment contains an NTFS 8.3 short-name alias pattern (~[0-9]+).
 */
export function hasNtfsShortNameAlias(path: string): boolean {
  if (!path) return false;
  const segments = path.split(/[\\/]+/);
  return segments.some((segment) => {
    const s = segment.trim();
    return /~[0-9]+/i.test(s);
  });
}

/**
 * Checks whether any relative path segment at any directory depth matches a managed dependency directory.
 * Case-insensitive on Windows and matches NTFS 8.3 short-name aliases.
 */
export function isManagedDependencyPath(
  relativePath: string,
  platform: 'windows' | 'linux' = process.platform === 'win32' ? 'windows' : 'linux',
): boolean {
  if (!relativePath) return false;
  const segments = relativePath.split(/[\\/]+/);
  const isWin = platform === 'windows' || process.platform === 'win32';
  return segments.some((segment) => {
    const s = segment.trim();
    if (!s) return false;
    if (isWin) {
      const lower = s.toLowerCase();
      if ((MANAGED_DEPENDENCY_DIR_NAMES as readonly string[]).some((dir) => dir.toLowerCase() === lower)) {
        return true;
      }
      return MANAGED_DEPENDENCY_8DOT3_PATTERNS.some((pattern) => pattern.test(s));
    }
    return (MANAGED_DEPENDENCY_DIR_NAMES as readonly string[]).includes(s);
  });
}

/**
 * Throws CONTAINER_PATCH_INVALID if any path is within a managed dependency directory at any depth.
 */
export function assertNoManagedDependencyPaths(
  paths: string[],
  platform: 'windows' | 'linux' = process.platform === 'win32' ? 'windows' : 'linux',
): void {
  for (const path of paths) {
    if (isManagedDependencyPath(path, platform)) {
      throw new Error(`CONTAINER_PATCH_INVALID:managed_dependency_path_not_permitted:${path}`);
    }
  }
}

/**
 * Validates a single dependency directory and all its nested junctions / symlinks.
 * Throws CONTAINER_DEPENDENCY_MOUNT_UNSAFE if any security invariant is violated.
 */
export function validateDependencyDirectory(hostDependencyPath: string): void {
  let rootStat;
  try {
    rootStat = fs.lstatSync(hostDependencyPath);
  } catch (cause) {
    throw new Error(
      `CONTAINER_DEPENDENCY_MOUNT_UNSAFE:unreadable:${hostDependencyPath}:${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  if (rootStat.isSymbolicLink()) {
    throw new Error(`CONTAINER_DEPENDENCY_MOUNT_UNSAFE:root_is_symlink:${hostDependencyPath}`);
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync.native(hostDependencyPath);
  } catch (cause) {
    throw new Error(
      `CONTAINER_DEPENDENCY_MOUNT_UNSAFE:unresolvable_root:${hostDependencyPath}:${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const normalizedRoot = normalize(canonicalRoot).replace(/\\/g, '/');

  if (!/^[cC]:[\\/]/.test(normalizedRoot)) {
    throw new Error('CONTAINER_DEPENDENCY_MOUNT_UNSAFE:unsupported_drive');
  }
  if (normalizedRoot.includes(':') && normalizedRoot.slice(2).includes(':')) {
    throw new Error('CONTAINER_DEPENDENCY_MOUNT_UNSAFE:alternate_data_stream');
  }

  function walk(currentDir: string): void {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (cause) {
      throw new Error(
        `CONTAINER_DEPENDENCY_MOUNT_UNSAFE:unreadable_directory:${currentDir}:${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.name.includes(':')) {
        throw new Error(`CONTAINER_DEPENDENCY_MOUNT_UNSAFE:alternate_data_stream:${entry.name}`);
      }
      if (entry.name === '.git') {
        throw new Error(`CONTAINER_DEPENDENCY_MOUNT_UNSAFE:nested_git_directory:${fullPath}`);
      }

      let stat;
      try {
        stat = fs.lstatSync(fullPath);
      } catch (cause) {
        throw new Error(
          `CONTAINER_DEPENDENCY_MOUNT_UNSAFE:unreadable:${fullPath}:${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }

      if (stat.isSymbolicLink()) {
        let rawTarget: string;
        try {
          rawTarget = readlinkSync(fullPath);
        } catch {
          throw new Error(`CONTAINER_DEPENDENCY_MOUNT_UNSAFE:unreadable_link:${fullPath}`);
        }

        if (/^(?:\\\\|\/\/)/.test(rawTarget) || /^[\\/]{2,}\.?[\\/]/.test(rawTarget)) {
          throw new Error(`CONTAINER_DEPENDENCY_MOUNT_UNSAFE:unc_or_device_link:${fullPath}`);
        }

        const lexicalTarget = isAbsolute(rawTarget) ? resolve(rawTarget) : resolve(currentDir, rawTarget);
        if (!existsSync(lexicalTarget)) {
          throw new Error(`CONTAINER_DEPENDENCY_MOUNT_UNSAFE:missing_target:${fullPath}->${lexicalTarget}`);
        }

        let canonicalTarget: string;
        try {
          canonicalTarget = realpathSync.native(lexicalTarget);
        } catch {
          throw new Error(`CONTAINER_DEPENDENCY_MOUNT_UNSAFE:unresolvable_target:${fullPath}`);
        }

        const normTarget = normalize(canonicalTarget).replace(/\\/g, '/');
        if (normTarget.includes(':') && normTarget.slice(2).includes(':')) {
          throw new Error(`CONTAINER_DEPENDENCY_MOUNT_UNSAFE:alternate_data_stream:${normTarget}`);
        }
        if (normTarget.split('/').includes('.git')) {
          throw new Error(`CONTAINER_DEPENDENCY_MOUNT_UNSAFE:nested_git_directory:${normTarget}`);
        }

        const rel = relative(canonicalRoot, canonicalTarget);
        const escapes = rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel);
        if (escapes) {
          throw new Error(`CONTAINER_DEPENDENCY_MOUNT_UNSAFE:target_escapes_root:${fullPath}->${canonicalTarget}`);
        }
      } else if (stat.isDirectory()) {
        walk(fullPath);
      }
    }
  }

  walk(canonicalRoot);
}

/**
 * Computes a deterministic fingerprint of repository dependency manifests and directory state.
 */
export function computeDependencyFingerprint(repositoryPath: string, relativePath: string): string {
  const hash = createHash('sha256');
  // 1. Root manifests
  for (const manifest of DEPENDENCY_MANIFEST_FILES) {
    const manifestPath = join(repositoryPath, manifest);
    if (existsSync(manifestPath)) {
      hash.update(`${manifest}:${readFileSync(manifestPath, 'utf8')}\0`);
    }
  }

  // 2. Package-level manifests if relativePath is in a subdirectory
  const normalizedRel = relativePath.replace(/\\/g, '/');
  const pkgDirRel = normalizedRel.includes('/') ? normalizedRel.slice(0, normalizedRel.lastIndexOf('/')) : '';
  if (pkgDirRel) {
    const pkgDir = join(repositoryPath, pkgDirRel);
    for (const manifest of DEPENDENCY_MANIFEST_FILES) {
      const manifestPath = join(pkgDir, manifest);
      if (existsSync(manifestPath)) {
        hash.update(`${pkgDirRel}/${manifest}:${readFileSync(manifestPath, 'utf8')}\0`);
      }
    }
  }

  const depDir = join(repositoryPath, relativePath);
  if (existsSync(depDir)) {
    try {
      const stat = statSync(depDir);
      hash.update(`mtime:${stat.mtimeMs}:size:${stat.size}\0`);
    } catch {
      // Ignored if stat fails
    }
  }

  return `sha256:${hash.digest('hex')}`;
}

/**
 * Discovers approved dependency directories (initially `node_modules`) inside a repository,
 * walks and validates all links, and returns structured WindowsDependencyMount descriptors
 * sorted ascending by containerPath length (shallower directories mount before deeper ones).
 */
export function discoverDependencyMounts(
  repositoryPath: string,
  containerRepoPath: string,
  maxDepth = 10,
): WindowsDependencyMount[] {
  const mounts: WindowsDependencyMount[] = [];
  let repoStat;
  try {
    repoStat = fs.lstatSync(repositoryPath);
  } catch (cause) {
    throw new Error(
      `CONTAINER_DEPENDENCY_MOUNT_UNSAFE:unreadable:${repositoryPath}:${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (repoStat.isSymbolicLink()) {
    throw new Error(`CONTAINER_DEPENDENCY_MOUNT_UNSAFE:root_is_symlink:${repositoryPath}`);
  }

  let canonicalRepo: string;
  try {
    canonicalRepo = fs.realpathSync.native(repositoryPath);
  } catch (cause) {
    throw new Error(
      `CONTAINER_DEPENDENCY_MOUNT_UNSAFE:unresolvable_root:${repositoryPath}:${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  function walk(currentDir: string, currentDepth: number): void {
    if (currentDepth > maxDepth) return;

    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (cause) {
      throw new Error(
        `CONTAINER_DEPENDENCY_MOUNT_UNSAFE:unreadable_directory:${currentDir}:${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    for (const entry of entries) {
      if (entry.name === '.git') continue;
      if (entry.name.includes(':')) {
        throw new Error(`CONTAINER_DEPENDENCY_MOUNT_UNSAFE:alternate_data_stream:${entry.name}`);
      }

      const fullPath = join(currentDir, entry.name);
      let stat;
      try {
        stat = fs.lstatSync(fullPath);
      } catch (cause) {
        throw new Error(
          `CONTAINER_DEPENDENCY_MOUNT_UNSAFE:unreadable:${fullPath}:${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }

      // Do not follow symbolic links or junctions outside during directory walk
      if (stat.isSymbolicLink()) {
        continue;
      }

      if (stat.isDirectory()) {
        if ((APPROVED_DEPENDENCY_DIRECTORIES as readonly string[]).includes(entry.name)) {
          // Validate junctions and reparse points inside the dependency tree
          validateDependencyDirectory(fullPath);

          const relPath = relative(canonicalRepo, fullPath).replace(/\\/g, '/');
          const containerDepPath = join(containerRepoPath, relPath).replace(/\\/g, '/');
          const fingerprint = computeDependencyFingerprint(canonicalRepo, relPath);

          mounts.push({
            relativePath: relPath,
            hostPath: normalize(fullPath).replace(/\\/g, '/'),
            containerPath: containerDepPath,
            fingerprint,
          });
          // Do not recurse into node_modules
          continue;
        }

        walk(fullPath, currentDepth + 1);
      }
    }
  }

  walk(canonicalRepo, 0);

  mounts.sort((a, b) => a.containerPath.length - b.containerPath.length);

  return mounts;
}

/**
 * Checks whether any modified path is a dependency manifest or lockfile.
 */
export function isDependencyManifestChanged(changedPaths: string[]): boolean {
  return changedPaths.some((path) => {
    const base = path.replace(/\\/g, '/').split('/').pop();
    return base !== undefined && (DEPENDENCY_MANIFEST_FILES as readonly string[]).includes(base);
  });
}

export function sanitizeVolumeSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32);
}

/**
 * Derives a deterministic, collision-resistant Docker volume name for a private install target.
 * Incorporates the complete repository name and normalized target relative path with SHA-256 hashing.
 */
export function privateInstallVolumeName(volumePrefix: string, repositoryName: string, relativePath: string): string {
  const normalizedRel = relativePath.replace(/\\/g, '/').toLowerCase().trim();
  const repoNormalized = repositoryName.toLowerCase().trim();
  const identity = `${repoNormalized}:${normalizedRel}`;
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 12);
  const repoSlug = repositoryName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const targetSlug = normalizedRel
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const slugParts = [repoSlug, targetSlug].filter(Boolean).join('-');
  return `${volumePrefix}-dep-${slugParts ? `${slugParts}-` : ''}${hash}`;
}

/**
 * Discovers authorized dependency targets for private-install mode.
 * Targets are strictly derived from package.json or node_modules locations
 * within the authorized repository root, rejecting path traversal, ADS, and overlapping targets.
 */
export function discoverPrivateInstallTargets(
  repositoryName: string,
  repositoryPath: string,
  containerRepoPath: string,
  volumePrefix: string,
  maxDepth = 10,
): PrivateInstallTarget[] {
  let repoStat;
  try {
    repoStat = fs.lstatSync(repositoryPath);
  } catch (cause) {
    throw new Error(
      `CONTAINER_DEPENDENCY_MOUNT_UNSAFE:unreadable:${repositoryPath}:${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (repoStat.isSymbolicLink()) {
    throw new Error(`CONTAINER_DEPENDENCY_MOUNT_UNSAFE:root_is_symlink:${repositoryPath}`);
  }

  let canonicalRepo: string;
  try {
    canonicalRepo = fs.realpathSync.native(repositoryPath);
  } catch (cause) {
    throw new Error(
      `CONTAINER_DEPENDENCY_MOUNT_UNSAFE:unresolvable_root:${repositoryPath}:${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const rawTargets: Array<{ relativePath: string; containerPath: string }> = [];

  // Check repository root
  const rootPkg = join(canonicalRepo, 'package.json');
  const rootNm = join(canonicalRepo, 'node_modules');
  if (existsSync(rootPkg) || existsSync(rootNm)) {
    rawTargets.push({
      relativePath: 'node_modules',
      containerPath: join(containerRepoPath, 'node_modules').replace(/\\/g, '/'),
    });
  }

  function walk(currentDir: string, currentDepth: number): void {
    if (currentDepth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      if (entry.name.includes(':')) {
        throw new Error(`CONTAINER_DEPENDENCY_MOUNT_UNSAFE:alternate_data_stream:${entry.name}`);
      }

      const fullPath = join(currentDir, entry.name);
      let stat;
      try {
        stat = fs.lstatSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isSymbolicLink()) continue;

      if (stat.isDirectory()) {
        const hasPkg = existsSync(join(fullPath, 'package.json'));
        const hasNm = existsSync(join(fullPath, 'node_modules'));
        if (hasPkg || hasNm) {
          const relDir = relative(canonicalRepo, fullPath).replace(/\\/g, '/');
          if (relDir && !relDir.startsWith('..') && !isAbsolute(relDir)) {
            const relNm = `${relDir}/node_modules`;
            const containerNm = join(containerRepoPath, relNm).replace(/\\/g, '/');
            rawTargets.push({
              relativePath: relNm,
              containerPath: containerNm,
            });
          }
        }
        walk(fullPath, currentDepth + 1);
      }
    }
  }

  walk(canonicalRepo, 0);

  // De-duplicate targets by containerPath
  const seen = new Set<string>();
  const uniqueTargets: Array<{ relativePath: string; containerPath: string }> = [];
  for (const t of rawTargets) {
    if (!seen.has(t.containerPath)) {
      seen.add(t.containerPath);
      uniqueTargets.push(t);
    }
  }

  // Sort ascending by containerPath length, then by relativePath
  uniqueTargets.sort((a, b) => {
    if (a.containerPath.length !== b.containerPath.length) {
      return a.containerPath.length - b.containerPath.length;
    }
    return a.relativePath.localeCompare(b.relativePath);
  });

  // Check for invalid overlapping targets
  for (let i = 0; i < uniqueTargets.length; i++) {
    for (let j = i + 1; j < uniqueTargets.length; j++) {
      const shorter = uniqueTargets[i]!.containerPath;
      const longer = uniqueTargets[j]!.containerPath;
      if (longer.startsWith(shorter + '/')) {
        throw new Error(`CONTAINER_DEPENDENCY_MOUNT_OVERLAP:${shorter}:${longer}`);
      }
    }
  }

  const seenVolumes = new Set<string>();
  return uniqueTargets.map((t) => {
    const volume = privateInstallVolumeName(volumePrefix, repositoryName, t.relativePath);
    if (seenVolumes.has(volume)) {
      throw new Error(`CONTAINER_DEPENDENCY_MOUNT_COLLISION:${volume}`);
    }
    seenVolumes.add(volume);
    return {
      repository: repositoryName,
      relativePath: t.relativePath,
      containerPath: t.containerPath,
      volume,
    };
  });
}

/**
 * Resolves the primary private-install target for configuring tool stores (such as the pnpm store directory on Windows).
 * Deterministically resolves against the active working directory / repository, selecting the closest
 * ancestor or child node_modules target within the selected repository. Never falls back to an unrelated repository.
 */
export function resolvePrimaryInstallTarget(
  targets: readonly PrivateInstallTarget[] | undefined,
  repositories: readonly RunRepository[],
  workingDirectory?: string,
): PrivateInstallTarget | undefined {
  if (!targets || targets.length === 0) return undefined;

  const normalizePath = (p: string) => p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');

  let activeRepoName: string | undefined;
  let normalizedWorkDir: string | undefined;

  if (workingDirectory) {
    normalizedWorkDir = normalizePath(workingDirectory);
    // Find repository with containerPath equal to or ancestor of workingDirectory (longest prefix match)
    const matchingRepos = repositories
      .filter((r) => {
        const repoPath = normalizePath(r.containerPath);
        return normalizedWorkDir === repoPath || normalizedWorkDir!.startsWith(repoPath + '/');
      })
      .sort((a, b) => b.containerPath.length - a.containerPath.length);

    activeRepoName = matchingRepos[0]?.name;
  }

  if (!workingDirectory && repositories.length === 1) {
    activeRepoName = repositories[0]?.name;
  }

  // Filter targets strictly to the active repository
  const repoTargets = activeRepoName ? targets.filter((t) => t.repository === activeRepoName) : [];

  if (repoTargets.length === 0) return undefined;

  if (normalizedWorkDir) {
    // 1. Direct child match: workingDirectory/node_modules
    const exactChild = repoTargets.find((t) => normalizePath(t.containerPath) === `${normalizedWorkDir}/node_modules`);
    if (exactChild) return exactChild;

    // 2. Nearest ancestor target whose directory contains workingDirectory
    const ancestorTargets = repoTargets
      .filter((t) => {
        const targetDir = normalizePath(t.containerPath).replace(/\/node_modules$/, '');
        return normalizedWorkDir === targetDir || normalizedWorkDir!.startsWith(targetDir + '/');
      })
      .sort((a, b) => b.containerPath.length - a.containerPath.length);

    if (ancestorTargets[0]) return ancestorTargets[0];
  }

  // 3. Fallback within the active repository: root node_modules
  return repoTargets.find((t) => t.relativePath === 'node_modules');
}
