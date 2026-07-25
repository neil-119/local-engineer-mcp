import { spawn } from 'node:child_process';
import { copyFile, mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';

const relayEnabled = process.env.LOCAL_ENGINEER_MODEL_RELAY_ENABLED !== 'false';
const upstream = relayEnabled ? new URL(requiredEnvironment('LOCAL_ENGINEER_MODEL_UPSTREAM')) : undefined;
const proxyHome = process.env.CODEX_HOME ?? '/home/codex/.codex';
const sharedDirectory = '/proxy-shared';
const relayPort = 8090;

const proxy = spawn('/usr/local/bin/codex-network-proxy', [], {
  env: process.env,
  stdio: 'inherit',
});

proxy.once('exit', (code, signal) => {
  process.stderr.write(`network proxy exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})\n`);
  process.exit(code ?? 1);
});

const relay = relayEnabled
  ? http.createServer((request, response) => {
      const target = relayTarget(request.url ?? '/');
      const headers = { ...request.headers, host: target.host };
      delete headers.connection;
      delete headers['proxy-connection'];
      delete headers['proxy-authorization'];

      const transport = target.protocol === 'https:' ? https : http;
      const forwarded = transport.request(
        target,
        {
          method: request.method,
          headers,
        },
        (upstreamResponse) => {
          const responseHeaders = { ...upstreamResponse.headers };
          delete responseHeaders.connection;
          delete responseHeaders['proxy-authenticate'];
          response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
          upstreamResponse.pipe(response);
        },
      );
      forwarded.setTimeout(30 * 60 * 1000, () => forwarded.destroy(new Error('model upstream timeout')));
      forwarded.on('error', (error) => {
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(`model relay error: ${error.message}`);
      });
      request.pipe(forwarded);
    })
  : undefined;

if (relay)
  relay.listen(relayPort, '0.0.0.0', () => {
    process.stdout.write(`model relay listening on 0.0.0.0:${relayPort}; target=${upstream.origin}\n`);
  });

publishManagedCa().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  proxy.kill('SIGTERM');
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    relay?.close();
    proxy.kill(signal);
  });
}

function relayTarget(requestPath) {
  const target = new URL(upstream);
  const incoming = new URL(requestPath, 'http://relay.invalid');
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  target.hash = '';
  return target;
}

async function publishManagedCa() {
  const proxyDirectory = join(proxyHome, 'proxy');
  await mkdir(sharedDirectory, { recursive: true });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const candidates = await readdir(proxyDirectory).catch(() => []);
    const bundles = candidates.filter((name) => /^ca-(?!bundle-).*\.pem$/.test(name));
    for (const bundle of bundles) {
      const source = join(proxyDirectory, bundle);
      const metadata = await stat(source).catch(() => undefined);
      if (!metadata?.size) continue;
      const temporary = join(sharedDirectory, `ca.pem.${process.pid}.tmp`);
      await copyFile(source, temporary);
      await rename(temporary, join(sharedDirectory, 'ca.pem'));
      await writeFile(join(sharedDirectory, 'ready'), 'ready\n', { encoding: 'utf8' });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('managed proxy CA was not published');
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
