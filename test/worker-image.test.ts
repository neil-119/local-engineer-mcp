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

  it('tells workers to use the provided helper, not an unavailable host tool', () => {
    expect(DEFAULT_WORKER_POLICY).toContain('`apply_patch` command');
    expect(DEFAULT_WORKER_POLICY).toContain('`*** Begin Patch`');
    expect(DEFAULT_WORKER_POLICY).toContain('`apply_patch --check`');
    expect(DEFAULT_WORKER_POLICY).toContain('manipulate headers');
    expect(DEFAULT_WORKER_POLICY).toContain('error-masking shell logic');
  });
});
