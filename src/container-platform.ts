/**
 * Container Platform Layout & Path Helpers
 *
 * Defines platform-specific filesystem layouts, administrative users, keep-alive
 * commands, and cross-platform file manipulation helpers across Linux and Windows containers:
 * - Linux: POSIX `/workspace`, `/home/codex/.codex`, user `0` (root), `sleep infinity`.
 * - Windows: `C:/workspace`, `C:/local-engineer/codex-home`, user `ContainerAdministrator`,
 *   PowerShell sleep loops, and native `.ps1` network scripts.
 */

import { posix } from 'node:path';
import type { ContainerConfig, ContainerPlatform } from './domain.js';

export interface ContainerLayout {
  platform: ContainerPlatform;
  workspace: string;
  codexHome: string;
  proxyShared: string;
  dependencyRoot: string;
  caFile: string;
  proxySidecar: string;
  networkScript?: string;
  keepAliveCommand: string[];
  administratorUser: string;
  codexExecutable: string;
  gitExecutable: string;
  powershellExecutable: string;
  whoamiExecutable: string;
  icaclsExecutable: string;
  safeAdminWorkdir: string;
}

/**
 * Returns the platform-specific directory paths, user names, and daemon commands
 * for the configured container environment.
 */
export function containerLayout(config: ContainerConfig): ContainerLayout {
  if (config.platform === 'windows') {
    const proxyShared = 'C:/local-engineer/proxy-shared';
    return {
      platform: 'windows',
      workspace: config.workspace_path,
      codexHome: 'C:/local-engineer/codex-home',
      proxyShared,
      dependencyRoot: 'C:/local-engineer/dependencies',
      caFile: `${proxyShared}/ca.pem`,
      proxySidecar: 'C:/local-engineer/proxy-sidecar.mjs',
      networkScript: 'C:/local-engineer/configure-worker-network.ps1',
      keepAliveCommand: [
        'powershell.exe',
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'while ($true) { Start-Sleep -Seconds 3600 }',
      ],
      administratorUser: 'ContainerAdministrator',
      codexExecutable:
        'C:/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
      gitExecutable: 'C:/MinGit/cmd/git.exe',
      powershellExecutable: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
      whoamiExecutable: 'C:/Windows/System32/whoami.exe',
      icaclsExecutable: 'C:/Windows/System32/icacls.exe',
      safeAdminWorkdir: 'C:/Windows/System32',
    };
  }
  const proxyShared = '/proxy-shared';
  return {
    platform: 'linux',
    workspace: config.workspace_path,
    codexHome: '/home/codex/.codex',
    proxyShared,
    dependencyRoot: '/local-engineer-dependencies',
    caFile: `${proxyShared}/ca.pem`,
    proxySidecar: '/usr/local/lib/local-engineer/proxy-sidecar.mjs',
    keepAliveCommand: ['sleep', 'infinity'],
    administratorUser: '0',
    codexExecutable: '/usr/local/bin/codex',
    gitExecutable: 'git',
    powershellExecutable: 'powershell',
    whoamiExecutable: 'whoami',
    icaclsExecutable: 'icacls',
    safeAdminWorkdir: '/',
  };
}

/**
 * Joins path segments into a valid container path, normalizing backslashes to forward slashes
 * and preserving Windows drive letters (`C:/...`).
 */
export function joinContainerPath(platform: ContainerPlatform, ...parts: string[]): string {
  const joined = posix.join(...parts.map((part) => part.replaceAll('\\', '/')));
  return platform === 'windows' ? joined.replace(/^([A-Za-z]):\//, '$1:/') : joined;
}

/**
 * Resolves the container path for a repository based on the container platform and workspace mode:
 * - On Windows in `isolated-bind` mode, mirrors the parent repository path on C: drive so that
 *   package managers like pnpm create valid absolute junctions.
 * - In other configurations, places repositories under the configured `workspace_path`.
 */
export function resolveRepositoryContainerPath(
  container: ContainerConfig,
  parentPath: string,
  repositoryName: string,
): string {
  if (container.platform === 'windows' && container.windows_workspace_mode === 'isolated-bind') {
    const normalized = parentPath.replaceAll('\\', '/');
    if (!/^[cC]:\//.test(normalized)) {
      throw new Error(
        `CONTAINER_BIND_UNSUPPORTED_DRIVE: Windows isolated-bind mode requires repositories on C: drive, got ${parentPath}`,
      );
    }
    if (normalized.slice(2).includes(':')) {
      throw new Error(
        `CONTAINER_BIND_INVALID_PATH: alternate data stream not permitted in repository path: ${parentPath}`,
      );
    }
    const trimmed = normalized.length > 3 ? normalized.replace(/\/+$/, '') : normalized;
    return trimmed.charAt(0).toUpperCase() + ':' + trimmed.slice(2);
  }
  return joinContainerPath(container.platform, container.workspace_path, repositoryName);
}

/**
 * Validates whether a given path is absolute within the target container environment.
 */
export function isAbsoluteContainerPath(platform: ContainerPlatform, value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || /[\r\n\0]/.test(normalized)) return false;
  const segments = normalized.split('/');
  if (segments.includes('..')) return false;
  if (platform === 'windows') {
    const path = normalized.slice(3);
    return /^[A-Za-z]:\/.+/.test(normalized) && !/[<>:"|?*]/.test(path);
  }
  return /^\/.+/.test(normalized);
}

/**
 * Generates a cross-platform command to create directories recursively using the container's
 * Node.js runtime, avoiding differences between `mkdir -p` and `New-Item`.
 */
export function nodeMkdirCommand(...paths: string[]): string[] {
  return [
    'node',
    '--eval',
    "const fs=require('node:fs');for(const p of process.argv.slice(1))fs.mkdirSync(p,{recursive:true})",
    ...paths,
  ];
}

/**
 * Generates a cross-platform command to delete files or directories using the container's
 * Node.js runtime, avoiding differences between `rm -rf` and `Remove-Item`.
 */
export function nodeRemoveCommand(path: string, recursive = false): string[] {
  return [
    'node',
    '--eval',
    "require('node:fs').rmSync(process.argv[1],{recursive:process.argv[2]==='true',force:true})",
    path,
    String(recursive),
  ];
}
