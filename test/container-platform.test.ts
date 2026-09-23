import { describe, expect, it } from 'vitest';
import {
  isAbsoluteContainerPath,
  joinContainerPath,
  resolveRepositoryContainerPath,
} from '../src/container-platform.js';
import type { ContainerConfig } from '../src/domain.js';

describe('Container Platform Path Helpers', () => {
  const baseConfig: ContainerConfig = {
    command: 'docker',
    platform: 'linux',
    context: 'default',
    image: 'local-engineer/worker:test',
    base_image: 'node:24-bookworm-slim',
    codex_version: '0.144.6',
    workspace_path: '/workspace',
    worker_user: 'codex',
    codex_command: 'codex',
    network: {
      model_domains: ['model-provider.example'],
      read_only_domains: [],
      allow_private_model_endpoint: false,
    },
  };

  const windowsConfig: ContainerConfig = {
    ...baseConfig,
    platform: 'windows',
    workspace_path: 'C:/workspace',
    worker_user: 'ContainerUser',
  };

  const windowsIsolatedBindConfig: ContainerConfig = {
    ...windowsConfig,
    windows_workspace_mode: 'isolated-bind',
  };

  describe('resolveRepositoryContainerPath', () => {
    it('mirrors C: drive paths on Windows in isolated-bind mode', () => {
      expect(resolveRepositoryContainerPath(windowsIsolatedBindConfig, 'C:\\repos\\my-project', 'primary')).toBe(
        'C:/repos/my-project',
      );

      expect(resolveRepositoryContainerPath(windowsIsolatedBindConfig, 'c:/repos/nested/app', 'app')).toBe(
        'C:/repos/nested/app',
      );

      expect(
        resolveRepositoryContainerPath(windowsIsolatedBindConfig, 'C:/repos/trailing-slash/', 'trailing-slash'),
      ).toBe('C:/repos/trailing-slash');
    });

    it('rejects non-C drive paths in isolated-bind mode', () => {
      expect(() =>
        resolveRepositoryContainerPath(windowsIsolatedBindConfig, 'D:\\repos\\my-project', 'primary'),
      ).toThrow(/CONTAINER_BIND_UNSUPPORTED_DRIVE/);

      expect(() => resolveRepositoryContainerPath(windowsIsolatedBindConfig, 'E:/repos/app', 'app')).toThrow(
        /CONTAINER_BIND_UNSUPPORTED_DRIVE/,
      );
    });

    it('rejects NTFS alternate data streams in repository path', () => {
      expect(() =>
        resolveRepositoryContainerPath(windowsIsolatedBindConfig, 'C:\\repos\\repo:stream', 'primary'),
      ).toThrow(/CONTAINER_BIND_INVALID_PATH/);
    });

    it('places repositories under workspace_path in volume-copy mode on Windows', () => {
      expect(resolveRepositoryContainerPath(windowsConfig, 'C:\\repos\\my-project', 'primary')).toBe(
        'C:/workspace/primary',
      );
    });

    it('places repositories under workspace_path on Linux', () => {
      expect(resolveRepositoryContainerPath(baseConfig, '/home/user/repos/my-project', 'primary')).toBe(
        '/workspace/primary',
      );
    });
  });

  describe('joinContainerPath', () => {
    it('normalizes backslashes to forward slashes', () => {
      expect(joinContainerPath('linux', 'foo', 'bar\\baz')).toBe('foo/bar/baz');
      expect(joinContainerPath('windows', 'C:\\workspace', 'sub\\repo')).toBe('C:/workspace/sub/repo');
    });
  });

  describe('isAbsoluteContainerPath', () => {
    it('validates Linux absolute paths', () => {
      expect(isAbsoluteContainerPath('linux', '/workspace/app')).toBe(true);
      expect(isAbsoluteContainerPath('linux', 'workspace/app')).toBe(false);
      expect(isAbsoluteContainerPath('linux', '/workspace/../app')).toBe(false);
    });

    it('validates Windows absolute paths', () => {
      expect(isAbsoluteContainerPath('windows', 'C:/workspace/app')).toBe(true);
      expect(isAbsoluteContainerPath('windows', 'c:\\workspace\\app')).toBe(true);
      expect(isAbsoluteContainerPath('windows', '/workspace/app')).toBe(false);
      expect(isAbsoluteContainerPath('windows', 'C:/workspace/../app')).toBe(false);
      expect(isAbsoluteContainerPath('windows', 'C:/workspace/app:stream')).toBe(false);
    });
  });
});
