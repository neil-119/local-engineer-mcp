import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKER_POLICY } from '../src/prompt.js';

const readContainerFile = (name: string) => readFileSync(new URL(`../container/${name}`, import.meta.url), 'utf8');

describe('shared worker image contract', () => {
  it('provides a narrow structured apply_patch helper', () => {
    const helper = readContainerFile('apply_patch');
    const parser = readContainerFile('apply_patch.mjs');

    expect(helper).toContain('exec node /usr/local/lib/local-engineer/apply_patch.mjs');
    expect(parser).toContain("args[0] === '--check'");
    expect(parser).toContain("'git', ['rev-parse', '--show-toplevel']");
    expect(parser).toContain('*** Begin Patch');
    expect(parser).toContain('*** End Patch');
    expect(parser).toContain('do not mix Git unified diffs with structured apply_patch format');
    expect(parser).toContain("source.includes('\\r\\n') ? '\\r\\n' : '\\n'");
  });

  it('installs the helper and Rust/Tauri build prerequisites', () => {
    const dockerfile = readContainerFile('worker.Dockerfile');

    expect(dockerfile).toContain('FROM rust:bookworm AS rust-runtime');
    expect(dockerfile).toContain('COPY --from=rust-runtime /usr/local/cargo /usr/local/cargo');
    expect(dockerfile).toContain('rustup component add rustfmt clippy');
    expect(dockerfile).toContain('libwebkit2gtk-4.1-dev');
    expect(dockerfile).toContain('libayatana-appindicator3-dev');
    expect(dockerfile).toContain('pkg-config');
    expect(dockerfile).toContain('COPY apply_patch /usr/local/bin/apply_patch');
    expect(dockerfile).toContain('COPY apply_patch.mjs /usr/local/lib/local-engineer/apply_patch.mjs');
    expect(dockerfile).toContain('COPY rust-path.sh /etc/profile.d/local-engineer-rust.sh');
  });

  it('builds the Windows image from verified inputs and defaults to ContainerUser', () => {
    const dockerfile = readContainerFile('worker.windows.Dockerfile');

    expect(dockerfile).toContain('ARG BASE_IMAGE=mcr.microsoft.com/windows/servercore:ltsc2025');
    expect(dockerfile).toContain('ARG NODE_SHA256=');
    expect(dockerfile).toContain('ARG RUSTUP_SHA256=');
    expect(dockerfile).toContain('ARG RUST_TOOLCHAIN_VERSION=1.98.1');
    expect(dockerfile).toContain('ARG GIT_SHA256=');
    expect(dockerfile).toContain('ARG TERRAFORM_VERSION=1.12.2');
    expect(dockerfile).toContain(
      'ARG TERRAFORM_SHA256=0a1565ace9da37c2778868c2e97452d8fc25e40e530bafbbab97231e69b0a201',
    );
    expect(dockerfile).toContain('Terraform archive checksum mismatch');
    expect(dockerfile).toContain("'C:\\Terraform'");
    expect(dockerfile).toContain('ARG CODEX_SOURCE_SHA256=');
    expect(dockerfile).toContain('Codex source archive checksum mismatch');
    expect(dockerfile).toContain("$env:RUSTUP_TOOLCHAIN = 'stable'");
    expect(dockerfile).toContain('Get-AuthenticodeSignature C:\\vs_BuildTools.exe');
    expect(dockerfile).toContain('COPY configure-worker-network.ps1');
    expect(dockerfile).toContain(
      "& 'C:\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe' --version",
    );
    expect(dockerfile).toContain('USER ContainerUser');
    expect(dockerfile).not.toContain('node:24-windowsservercore');
  });

  it('makes Windows worker egress deny-by-default with only a proxy host route', () => {
    const network = readContainerFile('configure-worker-network.ps1');

    expect(network).toContain("'ADD', $ProxyAddress, 'MASK', '255.255.255.255'");
    expect(network).toContain("'DELETE', $subnet.Destination, 'MASK', $subnet.Mask");
    expect(network).toContain("'delete', 'route', '0.0.0.0/0'");
    expect(network).toContain("'delete', 'route', 'fe80::/64'");
    expect(network).toContain("'delete', 'route', 'ff00::/8'");
    expect(network).toContain("Write-Output 'LOCAL_ENGINEER_NETWORK_OK'");
  });

  it('tells workers to use the provided helper, not an unavailable host tool', () => {
    expect(DEFAULT_WORKER_POLICY).toContain('`apply_patch` command');
    expect(DEFAULT_WORKER_POLICY).toContain('`*** Begin Patch`');
    expect(DEFAULT_WORKER_POLICY).toContain('`apply_patch --check`');
    expect(DEFAULT_WORKER_POLICY).toContain('manipulate headers');
    expect(DEFAULT_WORKER_POLICY).toContain('error-masking shell logic');
    expect(DEFAULT_WORKER_POLICY).toContain('do not guess patch filenames');
    expect(DEFAULT_WORKER_POLICY).toContain('$patch | apply_patch --check');
  });

  it('ensures Windows apply_patch.ps1 accepts pipeline input and remaining arguments', () => {
    const ps1 = readContainerFile('apply_patch.ps1');
    expect(ps1).toContain('ValueFromPipeline = $true');
    expect(ps1).toContain('ValueFromRemainingArguments = $true');
  });
});
