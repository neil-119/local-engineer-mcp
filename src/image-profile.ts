import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { Config } from './domain.js';
import { generatedProxyConfig } from './container-codex-config.js';
import { ContainerRuntime } from './container-runtime.js';

export interface ImagePlanInput {
  path: string;
  digest: string;
}

export interface ImagePlan {
  schema_version: 1;
  mode: 'plan';
  profile: string;
  working_directory: string;
  supported: boolean;
  source: 'generated';
  shared_base_image: string;
  image_tag: string;
  detected: {
    python?: { manager: 'requirements'; files: string[] };
    node?: { manager: 'npm' | 'pnpm' | 'yarn'; files: string[]; version?: string };
  };
  inputs: ImagePlanInput[];
  install_steps: string[];
  smoke_commands: string[];
  required_domains: string[];
  missing_read_only_domains: string[];
  plan_digest: string;
  build_requires_user_approval: true;
  build_network_policy: 'isolated_read_only_proxy';
  recommended_agents_md: string;
}

export interface ImageProfileRecord {
  schema_version: 1;
  profile: string;
  working_directory: string;
  plan_digest: string;
  image_tag: string;
  image_reference: string;
  inputs: ImagePlanInput[];
  created_at: string;
}

export class ImageProfileError extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
  }
}

export class ImageProfileManager {
  private readonly runtime: ContainerRuntime;

  constructor(
    private readonly config: Config,
    private readonly stateDirectory: string,
    runtime?: ContainerRuntime,
  ) {
    this.runtime = runtime ?? new ContainerRuntime(config.container.command);
  }

  plan(workingDirectory: string, profile: string, additionalDomains: string[] = []): ImagePlan {
    validateProfile(profile);
    for (const domain of additionalDomains) validateDomain(domain);
    const detected: ImagePlan['detected'] = {};
    const paths: string[] = [];
    const installSteps: string[] = [];
    const smokeCommands: string[] = [];
    const requiredDomains = new Set<string>();
    for (const domain of additionalDomains) requiredDomains.add(domain);

    const requirementFiles = readdirSync(workingDirectory)
      .filter((name) => /^requirements(?:[-_.][a-z0-9_.-]+)?\.txt$/i.test(name))
      .sort();
    if (requirementFiles.length) {
      detected.python = { manager: 'requirements', files: requirementFiles };
      paths.push(...requirementFiles);
      installSteps.push(
        'python3.12 -m venv /opt/local-engineer-profile/python',
        `/opt/local-engineer-profile/python/bin/pip install --no-cache-dir ${requirementFiles
          .map((name) => `-r /opt/local-engineer-profile/inputs/${name}`)
          .join(' ')}`,
      );
      smokeCommands.push('/opt/local-engineer-profile/python/bin/python --version');
      requiredDomains.add('pypi.org');
      requiredDomains.add('files.pythonhosted.org');
    }

    const packageJson = join(workingDirectory, 'package.json');
    if (existsSync(packageJson)) {
      const packageData = parsedJson(packageJson);
      const packageManager = typeof packageData.packageManager === 'string' ? packageData.packageManager : undefined;
      const pnpmLock = join(workingDirectory, 'pnpm-lock.yaml');
      const npmLock = join(workingDirectory, 'package-lock.json');
      const yarnLock = join(workingDirectory, 'yarn.lock');
      if (existsSync(pnpmLock)) {
        const version = packageManager?.match(/^pnpm@([^+\s]+)(?:\+.*)?$/)?.[1];
        detected.node = {
          manager: 'pnpm',
          files: ['package.json', 'pnpm-lock.yaml'],
          ...(version ? { version } : {}),
        };
        paths.push('package.json', 'pnpm-lock.yaml');
        installSteps.push(
          `npm install --global pnpm${version ? `@${version}` : ''}`,
          'pnpm install --dir /opt/local-engineer-profile/node --frozen-lockfile',
        );
      } else if (existsSync(npmLock)) {
        detected.node = { manager: 'npm', files: ['package.json', 'package-lock.json'] };
        paths.push('package.json', 'package-lock.json');
        installSteps.push('npm ci --prefix /opt/local-engineer-profile/node');
      } else if (existsSync(yarnLock)) {
        const version = packageManager?.match(/^yarn@([^+\s]+)(?:\+.*)?$/)?.[1];
        detected.node = { manager: 'yarn', files: ['package.json', 'yarn.lock'], ...(version ? { version } : {}) };
        paths.push('package.json', 'yarn.lock');
        installSteps.push(
          `npm install --global yarn${version ? `@${version}` : ''}`,
          'yarn --cwd /opt/local-engineer-profile/node install --frozen-lockfile',
        );
      }
      if (detected.node) {
        smokeCommands.push('node --version');
        requiredDomains.add('registry.npmjs.org');
      }
    }

    const inputs = [...new Set(paths)].sort().map((path) => ({
      path,
      digest: digestFile(safeProjectFile(workingDirectory, path, 'IMAGE_PLAN_INPUT_INVALID')),
    }));
    const supported = Object.keys(detected).length > 0;
    const planMaterial = {
      profile,
      working_directory: workingDirectory,
      source: 'generated',
      shared_base_image: this.config.container.image,
      detected,
      inputs,
      install_steps: installSteps,
      required_domains: [...requiredDomains].sort(),
      codex_version: this.config.container.codex_version,
    };
    const planDigest = sha256(JSON.stringify(planMaterial));
    const imageTag = `local-engineer/project-${profile}:${planDigest.slice('sha256:'.length, 18)}`;
    const missingDomains = [...requiredDomains]
      .filter((domain) => !this.config.container.network.read_only_domains.includes(domain))
      .sort();
    return {
      schema_version: 1,
      mode: 'plan',
      profile,
      working_directory: workingDirectory,
      supported,
      source: 'generated',
      shared_base_image: this.config.container.image,
      image_tag: imageTag,
      detected,
      inputs,
      install_steps: installSteps,
      smoke_commands: smokeCommands,
      required_domains: [...requiredDomains].sort(),
      missing_read_only_domains: missingDomains,
      plan_digest: planDigest,
      build_requires_user_approval: true,
      build_network_policy: 'isolated_read_only_proxy',
      recommended_agents_md: `For Local Engineer work in this repository, prefer the \`${profile}\` image profile. If it is unavailable or stale, ask the user before rebuilding it.`,
    };
  }

  async build(plan: ImagePlan, expectedPlanDigest: string): Promise<ImageProfileRecord> {
    if (!plan.supported)
      throw new ImageProfileError('IMAGE_PLAN_UNSUPPORTED', {
        error_code: 'IMAGE_PLAN_UNSUPPORTED',
        recommended_action: 'Use a reviewed external base image for this project toolchain.',
      });
    if (plan.plan_digest !== expectedPlanDigest) throw new Error('IMAGE_PLAN_DIGEST_MISMATCH');
    if (plan.missing_read_only_domains.length)
      throw new ImageProfileError('IMAGE_PLAN_DOMAINS_NOT_ALLOWED', {
        error_code: 'IMAGE_PLAN_DOMAINS_NOT_ALLOWED',
        missing_read_only_domains: plan.missing_read_only_domains,
        recommended_action: 'Ask the user to approve these domains before updating Local Engineer configuration.',
      });
    const buildDirectory = join(this.stateDirectory, 'image-profiles', 'builds', plan.plan_digest.slice(7));
    rmSync(buildDirectory, { recursive: true, force: true });
    mkdirSync(buildDirectory, { recursive: true });
    mkdirSync(join(buildDirectory, 'inputs'), { recursive: true });
    for (const input of plan.inputs)
      copyFileSync(
        safeProjectFile(plan.working_directory, input.path, 'IMAGE_PLAN_INPUT_INVALID'),
        join(buildDirectory, 'inputs', basename(input.path)),
      );
    try {
      await this.withBuildProxy(buildDirectory, plan, async (network, proxyContainer, sharedVolume) => {
        await this.buildGeneratedImage(buildDirectory, plan, network, proxyContainer, sharedVolume);
      });
      await this.runtime.run([
        'run',
        '--rm',
        '--read-only',
        '--tmpfs',
        '/tmp:rw,nosuid,nodev,size=64m',
        '--entrypoint',
        '/bin/sh',
        plan.image_tag,
        '-c',
        'test "$(id -u)" != "0" && command -v codex >/dev/null && command -v codex-network-proxy >/dev/null && command -v git >/dev/null',
      ]);
      const imageReference = (
        await this.runtime.run(['image', 'inspect', '--format', '{{.Id}}', plan.image_tag])
      ).stdout.trim();
      if (!/^sha256:[0-9a-f]{64}$/.test(imageReference)) throw new Error('IMAGE_PROFILE_REFERENCE_INVALID');
      const record: ImageProfileRecord = {
        schema_version: 1,
        profile: plan.profile,
        working_directory: plan.working_directory,
        plan_digest: plan.plan_digest,
        image_tag: plan.image_tag,
        image_reference: imageReference,
        inputs: plan.inputs,
        created_at: new Date().toISOString(),
      };
      this.writeRecord(record);
      return record;
    } finally {
      rmSync(buildDirectory, { recursive: true, force: true });
    }
  }

  resolve(workingDirectory: string, profile: string): ImageProfileRecord {
    validateProfile(profile);
    const path = this.recordPath(workingDirectory, profile);
    if (!existsSync(path))
      throw new ImageProfileError('IMAGE_PROFILE_NOT_FOUND', {
        error_code: 'IMAGE_PROFILE_NOT_FOUND',
        profile,
        recommended_action: {
          tool: 'local_engineer_build_image',
          mode: 'plan',
          working_directory: workingDirectory,
          profile,
        },
      });
    const record = JSON.parse(readFileSync(path, 'utf8')) as ImageProfileRecord;
    const stale = record.inputs.filter(
      (input) =>
        !existsSync(resolve(workingDirectory, input.path)) ||
        digestFile(safeProjectFile(workingDirectory, input.path, 'IMAGE_PLAN_INPUT_INVALID')) !== input.digest,
    );
    if (stale.length)
      throw new ImageProfileError('IMAGE_PROFILE_STALE', {
        error_code: 'IMAGE_PROFILE_STALE',
        profile,
        changed_inputs: stale.map((input) => input.path),
        recommended_action: {
          tool: 'local_engineer_build_image',
          mode: 'plan',
          working_directory: workingDirectory,
          profile,
        },
      });
    return record;
  }

  private writeRecord(record: ImageProfileRecord): void {
    const path = this.recordPath(record.working_directory, record.profile);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
  }

  private async withBuildProxy(
    buildDirectory: string,
    plan: ImagePlan,
    build: (network: string, proxyContainer: string, sharedVolume: string) => Promise<void>,
  ): Promise<void> {
    const suffix = plan.plan_digest.slice(7, 23);
    const prefix = `le-build-${suffix}`;
    const internalNetwork = `${prefix}-internal`;
    const egressNetwork = `${prefix}-egress`;
    const configVolume = `${prefix}-config`;
    const sharedVolume = `${prefix}-shared`;
    const seedContainer = `${prefix}-seed`;
    const proxyContainer = `${prefix}-proxy`;
    const labels = {
      'local-engineer.agent-id': `image-${suffix}`,
      'local-engineer.managed': 'true',
    };
    const proxyConfigPath = join(buildDirectory, 'proxy-config.toml');
    writeFileSync(proxyConfigPath, generatedProxyConfig(this.config.container), {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      await this.runtime.createNetwork(internalNetwork, true, labels);
      await this.runtime.createNetwork(egressNetwork, false, labels);
      await this.runtime.createVolume(configVolume, labels);
      await this.runtime.createVolume(sharedVolume, labels);
      await this.runtime.createContainer({
        name: seedContainer,
        image: this.config.container.image,
        network: internalNetwork,
        user: '0',
        labels,
        readOnlyRoot: false,
        mounts: [`type=volume,src=${configVolume},dst=/home/codex/.codex`],
        command: ['true'],
      });
      await this.runtime.copyToContainer(proxyConfigPath, seedContainer, '/home/codex/.codex/config.toml');
      await this.runtime.removeContainer(seedContainer, true);
      const modelUpstream = this.config.workers.find((worker) => worker.enabled)!.container_model_provider!.base_url;
      await this.runtime.createContainer({
        name: proxyContainer,
        image: this.config.container.image,
        network: internalNetwork,
        networkAliases: ['local-engineer-build-proxy'],
        labels,
        mounts: [
          `type=volume,src=${configVolume},dst=/home/codex/.codex`,
          `type=volume,src=${sharedVolume},dst=/proxy-shared`,
        ],
        environment: {
          CODEX_HOME: '/home/codex/.codex',
          LOCAL_ENGINEER_MODEL_UPSTREAM: modelUpstream,
          LOCAL_ENGINEER_MODEL_RELAY_ENABLED: 'false',
        },
        command: ['node', '/usr/local/lib/local-engineer/proxy-sidecar.mjs'],
      });
      await this.runtime.connectNetwork(egressNetwork, proxyContainer);
      await this.runtime.startContainer(proxyContainer);
      await this.runtime.execContainer(proxyContainer, [
        'node',
        '--eval',
        [
          "const fs=require('node:fs');",
          'let attempts=0;',
          "const ready=()=>fs.existsSync('/proxy-shared/ready')&&fs.statSync('/proxy-shared/ca.pem').size>0;",
          'const check=()=>{if(ready())process.exit(0);if(++attempts>=120)process.exit(1);setTimeout(check,100)};',
          'check();',
        ].join(''),
      ]);
      await build(internalNetwork, proxyContainer, sharedVolume);
    } finally {
      await this.runtime.removeContainer(seedContainer, true).catch(() => undefined);
      await this.runtime.removeContainer(proxyContainer, true).catch(() => undefined);
      await this.runtime.removeNetwork(internalNetwork).catch(() => undefined);
      await this.runtime.removeNetwork(egressNetwork).catch(() => undefined);
      await this.runtime.removeVolume(configVolume).catch(() => undefined);
      await this.runtime.removeVolume(sharedVolume).catch(() => undefined);
    }
  }

  private async buildGeneratedImage(
    buildDirectory: string,
    plan: ImagePlan,
    network: string,
    proxyContainer: string,
    sharedVolume: string,
  ): Promise<void> {
    const container = `le-profile-${plan.plan_digest.slice(7, 23)}`;
    const labels = {
      'local-engineer.agent-id': `image-${plan.plan_digest.slice(7, 23)}`,
      'local-engineer.managed': 'true',
    };
    const caPath = '/proxy-shared/ca.pem';
    try {
      await this.runtime.createContainer({
        name: container,
        image: this.config.container.image,
        network,
        user: '0',
        labels,
        readOnlyRoot: false,
        mounts: [`type=volume,src=${sharedVolume},dst=/proxy-shared,readonly`],
        environment: {
          HTTP_PROXY: `http://${proxyContainer}:3128`,
          HTTPS_PROXY: `http://${proxyContainer}:3128`,
          ALL_PROXY: `socks5h://${proxyContainer}:8081`,
          NO_PROXY: '',
          SSL_CERT_FILE: caPath,
          REQUESTS_CA_BUNDLE: caPath,
          CURL_CA_BUNDLE: caPath,
          NODE_EXTRA_CA_CERTS: caPath,
          GIT_SSL_CAINFO: caPath,
          PIP_CERT: caPath,
          npm_config_cafile: caPath,
        },
        command: ['sleep', 'infinity'],
      });
      await this.runtime.startContainer(container);
      await this.runtime.execContainer(
        container,
        [
          'node',
          '--eval',
          [
            "const net=require('node:net');",
            'const socket=net.connect(Number(process.argv[1]),process.argv[2],()=>{socket.destroy();process.exit(1)});',
            'socket.on("error",()=>process.exit(0));',
            'socket.setTimeout(2000,()=>{socket.destroy();process.exit(0)});',
          ].join(''),
          '8090',
          proxyContainer,
        ],
        { user: '0' },
      );
      await this.runtime.execContainer(
        container,
        [
          'node',
          '--eval',
          [
            "const net=require('node:net');",
            "const socket=net.connect(443,'1.1.1.1',()=>{socket.destroy();process.exit(1)});",
            'socket.on("error",()=>process.exit(0));',
            'socket.setTimeout(2000,()=>{socket.destroy();process.exit(0)});',
          ].join(''),
        ],
        { user: '0' },
      );
      await this.runtime.execContainer(container, ['mkdir', '-p', '/opt/local-engineer-profile/inputs'], {
        user: '0',
      });
      for (const input of plan.inputs)
        await this.runtime.copyToContainer(
          join(buildDirectory, 'inputs', basename(input.path)),
          container,
          `/opt/local-engineer-profile/inputs/${basename(input.path)}`,
        );
      if (plan.detected.python) {
        await this.runtime.execContainer(
          container,
          ['python3.12', '-m', 'venv', '/opt/local-engineer-profile/python'],
          { user: '0' },
        );
        await this.runtime.execContainer(
          container,
          [
            '/opt/local-engineer-profile/python/bin/pip',
            'install',
            '--no-cache-dir',
            ...plan.detected.python.files.flatMap((name) => [
              '-r',
              `/opt/local-engineer-profile/inputs/${basename(name)}`,
            ]),
          ],
          { user: '0' },
        );
      }
      if (plan.detected.node) {
        const nodeRoot = '/opt/local-engineer-profile/node';
        await this.runtime.execContainer(container, ['mkdir', '-p', nodeRoot], { user: '0' });
        await this.runtime.execContainer(
          container,
          ['cp', '/opt/local-engineer-profile/inputs/package.json', `${nodeRoot}/package.json`],
          { user: '0' },
        );
        const manager = plan.detected.node;
        if (manager.manager === 'npm') {
          await this.runtime.execContainer(
            container,
            ['cp', '/opt/local-engineer-profile/inputs/package-lock.json', `${nodeRoot}/package-lock.json`],
            { user: '0' },
          );
          await this.runtime.execContainer(container, ['npm', 'ci', '--prefix', nodeRoot], { user: '0' });
        } else {
          const executable = manager.manager;
          await this.runtime.execContainer(
            container,
            ['npm', 'install', '--global', `${executable}${manager.version ? `@${manager.version}` : ''}`],
            { user: '0' },
          );
          const lockfile = manager.manager === 'pnpm' ? 'pnpm-lock.yaml' : 'yarn.lock';
          await this.runtime.execContainer(
            container,
            ['cp', `/opt/local-engineer-profile/inputs/${lockfile}`, `${nodeRoot}/${lockfile}`],
            { user: '0' },
          );
          await this.runtime.execContainer(
            container,
            manager.manager === 'pnpm'
              ? ['pnpm', 'install', '--dir', nodeRoot, '--frozen-lockfile']
              : ['yarn', '--cwd', nodeRoot, 'install', '--frozen-lockfile'],
            { user: '0' },
          );
        }
      }
      const path = [
        ...(plan.detected.python ? ['/opt/local-engineer-profile/python/bin'] : []),
        ...(plan.detected.node ? ['/opt/local-engineer-profile/node/node_modules/.bin'] : []),
        '/usr/local/sbin',
        '/usr/local/bin',
        '/usr/sbin',
        '/usr/bin',
        '/sbin',
        '/bin',
      ].join(':');
      await this.runtime.commitContainer(container, plan.image_tag, [
        'USER codex',
        `ENV PATH=${path}`,
        ...(plan.detected.node ? ['ENV NODE_PATH=/opt/local-engineer-profile/node/node_modules'] : []),
        'ENV HTTP_PROXY= HTTPS_PROXY= ALL_PROXY= NO_PROXY=',
        'ENV SSL_CERT_FILE= REQUESTS_CA_BUNDLE= CURL_CA_BUNDLE= NODE_EXTRA_CA_CERTS=',
        'ENV GIT_SSL_CAINFO= PIP_CERT= npm_config_cafile=',
      ]);
    } finally {
      await this.runtime.removeContainer(container, true).catch(() => undefined);
    }
  }

  private recordPath(workingDirectory: string, profile: string): string {
    const project = createHash('sha256').update(workingDirectory.toLowerCase()).digest('hex');
    return join(this.stateDirectory, 'image-profiles', 'registry', project, `${profile}.json`);
  }
}

function parsedJson(path: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    throw new Error('IMAGE_PACKAGE_JSON_INVALID');
  }
}

function safeProjectFile(root: string, path: string, errorCode: string): string {
  if (!path || path.includes('\0')) throw new Error(errorCode);
  const destination = resolve(root, path);
  const relativePathValue = relative(resolve(root), destination);
  if (
    !relativePathValue ||
    relativePathValue === '..' ||
    relativePathValue.startsWith(`..${sep}`) ||
    !existsSync(destination)
  )
    throw new Error(errorCode);
  return destination;
}

function validateProfile(profile: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(profile)) throw new Error('IMAGE_PROFILE_NAME_INVALID');
}

function validateDomain(domain: string): void {
  if (
    domain === '*' ||
    domain.includes('/') ||
    domain.includes(':') ||
    !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(domain)
  )
    throw new Error('IMAGE_PROFILE_DOMAIN_INVALID');
}

function digestFile(path: string): string {
  return sha256(readFileSync(path));
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
