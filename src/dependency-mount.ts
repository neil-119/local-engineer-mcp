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
import type { WindowsDependencyMount } from './domain.js';

const APPROVED_DEPENDENCY_DIRECTORIES = ['node_modules'] as const;

export const DEPENDENCY_MANIFEST_FILES = [
  'pnpm-lock.yaml',
  'package.json',
  'pnpm-workspace.yaml',
  'package-lock.json',
  'yarn.lock',
] as const;

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
