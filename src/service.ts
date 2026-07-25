import { randomBytes } from 'node:crypto';
import type { Config, GroundingPacket, Result, Run, RunStats, RunStatus, Worker } from './domain.js';
import { emptyResult, RunStore } from './store.js';
import { buildPrompt } from './prompt.js';
import { canonicalWorkspace, defaultWorker } from './config.js';
import { CodexAppServer, type ContainerAppServerWorker } from './codex.js';
import { ContainerAgentManager } from './container-agent.js';
import type { RepositoryAccess, RunRepository } from './domain.js';
import { ImageProfileManager, type ImagePlan } from './image-profile.js';

const handle = (prefix: string) => `${prefix}_${randomBytes(12).toString('base64url')}`;
const now = () => new Date().toISOString();
export class LocalEngineer {
  private readonly adapters = new Map<string, CodexAppServer>();
  private readonly containerManager: ContainerAgentManager;
  private readonly imageProfileManager: ImageProfileManager;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly commandItemStartedAt = new Map<string, Map<string, string>>();
  private readonly completedCommandItems = new Map<string, Set<string>>();
  private readonly diffCheckpoints = new Map<string, number>();
  constructor(
    readonly config: Config,
    readonly store: RunStore,
    /** Internal identifier for the current MCP stdio connection. */
    readonly ownerId = handle('owner'),
  ) {
    this.containerManager = new ContainerAgentManager(config.container, config.server.state_dir);
    this.imageProfileManager = new ImageProfileManager(config, config.server.state_dir);
  }
  start(input: {
    title: string;
    task: string;
    grounding?: GroundingPacket;
    workingDirectory?: string;
    workspaceName?: string;
    repositoryAccess?: Record<string, RepositoryAccess>;
    workingRepository?: string;
    worker?: string;
    imageProfile?: string;
    timeoutSeconds?: number;
  }): SafeRun {
    this.validateTitle(input.title);
    const worker = this.worker(input.worker);
    const repositories = this.resolveRepositories(
      input.workingDirectory,
      input.workspaceName,
      input.repositoryAccess,
      input.workingRepository,
    );
    const primary = repositories.find((repository) => repository.name === input.workingRepository) ?? repositories[0]!;
    const directory = primary.parentPath;
    const imageProfile = input.imageProfile
      ? this.imageProfileManager.resolve(directory, input.imageProfile)
      : undefined;
    const timeout = this.timeout(input.timeoutSeconds, worker);
    const agentId = handle('agt');
    const run: Run = {
      runId: handle('run'),
      agentId,
      ownerId: this.ownerId,
      title: input.title,
      task: input.task,
      grounding: input.grounding,
      workingDirectory: directory,
      workspaceName: input.workspaceName,
      repositories,
      containerWorkingDirectory: primary.containerPath,
      ...(imageProfile ? { imageProfile: imageProfile.profile, imageReference: imageProfile.image_reference } : {}),
      worker: worker.name,
      status: 'queued',
      continuationIndex: 0,
      createdAt: now(),
      diagnostics: activity('queued'),
      requiresUserAction: false,
    };
    this.store.add(run);
    this.queue(run.runId, timeout);
    return safe(run);
  }
  reply(input: {
    agentId: string;
    title: string;
    message: string;
    grounding?: GroundingPacket;
    timeoutSeconds?: number;
  }): SafeRun {
    this.validateTitle(input.title);
    const prior = this.store
      .getByAgent(input.agentId)
      .filter((run) => this.owns(run))
      .at(-1);
    if (!prior?.workerThreadId) throw new Error('AGENT_UNAVAILABLE');
    const worker = this.worker(prior.worker);
    if (prior.status !== 'ready_for_review') throw new Error('AGENT_BUSY');
    const run: Run = {
      runId: handle('run'),
      agentId: prior.agentId,
      ownerId: this.ownerId,
      title: input.title,
      task: input.message,
      grounding: input.grounding,
      workingDirectory: prior.workingDirectory,
      workspaceName: prior.workspaceName,
      repositories: prior.repositories,
      containerWorkingDirectory: prior.containerWorkingDirectory,
      imageProfile: prior.imageProfile,
      imageReference: prior.imageReference,
      worker: worker.name,
      status: 'queued',
      continuationIndex: prior.continuationIndex + 1,
      continuationOfRunId: prior.runId,
      createdAt: now(),
      workerThreadId: prior.workerThreadId,
      diagnostics: activity('queued'),
      requiresUserAction: false,
    };
    this.store.add(run);
    this.store.setStatus(prior.runId, 'superseded', {
      completedAt: now(),
      diagnostics: activity('superseded', prior.diagnostics, { exit_reason: 'continued_by_parent' }),
    });
    this.queue(run.runId, this.timeout(input.timeoutSeconds, worker));
    return safe(run);
  }
  status(runIds?: string[], agentIds?: string[]): SafeRun[] {
    if (!!runIds === !!agentIds) throw new Error('STATUS_REQUIRES_EXACTLY_ONE_HANDLE_TYPE');
    return runIds
      ? runIds.map((id) => this.requireOwned(id)).map((run) => this.project(run))
      : agentIds!
          .map((id) =>
            this.store
              .getByAgent(id)
              .filter((run) => this.owns(run))
              .at(-1),
          )
          .filter((r): r is Run => !!r)
          .map((run) => this.project(run));
  }
  list(filter: {
    status?: RunStatus;
    worker?: string;
    title?: string;
    activeOnly?: boolean;
    limit?: number;
  }): SafeRun[] {
    return this.store
      .list()
      .filter((run) => this.owns(run))
      .filter((r) => !filter.status || r.status === filter.status)
      .filter(
        (r) =>
          !filter.activeOnly ||
          ['queued', 'starting', 'running', 'cancel_requested', 'ready_for_review', 'recovery_required'].includes(
            r.status,
          ),
      )
      .filter((r) => !filter.worker || r.worker === filter.worker)
      .filter((r) => !filter.title || r.title.toLocaleLowerCase().includes(filter.title.toLocaleLowerCase()))
      .slice(0, Math.min(filter.limit ?? 20, 100))
      .map(safe);
  }
  async cancel(runId: string): Promise<SafeRun> {
    const run = this.requireOwned(runId);
    if (['failed', 'cancelled', 'timed_out', 'promoted', 'rejected', 'superseded'].includes(run.status))
      return safe(run);
    this.store.setStatus(runId, 'cancel_requested');
    if (run.workerThreadId && run.workerTurnId)
      await this.adapters
        .get(run.agentId)
        ?.interrupt(run.workerThreadId, run.workerTurnId)
        .catch(() => undefined);
    const current = this.requireOwned(runId);
    this.commandItemStartedAt.delete(runId);
    this.completedCommandItems.delete(runId);
    return safe(
      this.store.setStatus(runId, 'cancelled', {
        completedAt: now(),
        requiresUserAction: false,
        result: emptyResult(),
        diagnostics: activity('cancelled', current.diagnostics, {
          commands_active_count: 0,
          exit_reason: 'parent_cancelled',
        }),
      }),
    );
  }
  planImage(workingDirectory: string, profile: string, additionalDomains: string[] = []): ImagePlan {
    return this.imageProfileManager.plan(canonicalWorkspace(workingDirectory, this.config), profile, additionalDomains);
  }
  async buildImage(
    workingDirectory: string,
    profile: string,
    expectedPlanDigest: string,
    additionalDomains: string[] = [],
  ) {
    const plan = this.planImage(workingDirectory, profile, additionalDomains);
    return {
      mode: 'build' as const,
      ...(await this.imageProfileManager.build(plan, expectedPlanDigest)),
      recommended_agents_md: plan.recommended_agents_md,
    };
  }
  async wait(
    runIds: string[],
    waitFor: 'all' | 'any',
    seconds?: number,
  ): Promise<{ timedOut: boolean; settled: SafeRun[]; pending: SafeRun[] }> {
    if (!runIds.length || runIds.length > this.config.server.max_wait_ids || new Set(runIds).size !== runIds.length)
      throw new Error('WAIT_RUN_IDS_INVALID');
    const timeout = waitDurationSeconds(
      seconds ?? this.config.server.default_wait_timeout_seconds,
      this.config.server.max_wait_timeout_seconds,
      this.config.server.wait_response_reserve_seconds,
    );
    const settled = () => runIds.map((id) => this.requireOwned(id)).filter((r) => isSettled(r.status));
    const done = () => (waitFor === 'all' ? settled().length === runIds.length : settled().length > 0);
    if (!done())
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeout * 1000);
        const handler = () => {
          if (done()) {
            clearTimeout(timer);
            this.store.off('change', handler);
            resolve();
          }
        };
        this.store.on('change', handler);
      });
    const all = runIds.map((id) => this.requireOwned(id));
    return {
      timedOut: !done(),
      settled: all.filter((r) => isSettled(r.status)).map((run) => this.project(run)),
      pending: all.filter((r) => !isSettled(r.status)).map((run) => this.project(run)),
    };
  }
  getChanges(agentId: string): {
    schema_version: 1;
    agent_id: string;
    run_id: string;
    status: RunStatus;
    change_set: NonNullable<Run['changeSet']>;
  } {
    const run = this.requireOwnedAgent(agentId);
    if (run.status !== 'ready_for_review' || !run.changeSet) throw new Error('AGENT_NOT_READY_FOR_REVIEW');
    const response = {
      schema_version: 1 as const,
      agent_id: agentId,
      run_id: run.runId,
      status: run.status,
      change_set: run.changeSet,
    };
    this.recordParentDelivery(run.runId, 'changes', response);
    return response;
  }
  async getDiff(
    agentId: string,
    repository: string,
    mode: 'since_last_check' | 'full' = 'since_last_check',
    maximumCharacters = 20000,
  ): Promise<{
    schema_version: 1;
    agent_id: string;
    repository: string;
    mode: 'since_last_check' | 'full';
    from_revision: number;
    to_revision: number;
    patch: string;
    truncated: boolean;
    check_cursor_advanced: boolean;
  }> {
    const run = this.requireOwnedAgent(agentId);
    if (run.status !== 'ready_for_review' || !run.changeSet) throw new Error('AGENT_NOT_READY_FOR_REVIEW');
    const checkpointKey = `${agentId}\0${repository}`;
    const toRevision = run.changeSet.revision;
    const fromRevision = mode === 'full' ? 0 : (this.diffCheckpoints.get(checkpointKey) ?? 0);
    const patch =
      fromRevision === toRevision
        ? ''
        : await this.containerManager.getPatchBetween(agentId, repository, fromRevision, toRevision);
    const truncated = patch.length > maximumCharacters;
    if (!truncated) this.diffCheckpoints.set(checkpointKey, toRevision);
    const response = {
      schema_version: 1 as const,
      agent_id: agentId,
      repository,
      mode,
      from_revision: fromRevision,
      to_revision: toRevision,
      patch: patch.slice(0, maximumCharacters),
      truncated,
      check_cursor_advanced: !truncated,
    };
    this.recordParentDelivery(run.runId, 'diff', response);
    return response;
  }
  async getFile(agentId: string, repository: string, path: string, maximumBytes = 20000) {
    const run = this.requireOwnedAgent(agentId);
    if (run.status !== 'ready_for_review') throw new Error('AGENT_NOT_READY_FOR_REVIEW');
    const response = {
      schema_version: 1,
      agent_id: agentId,
      repository,
      path,
      contents: await this.containerManager.getFile(agentId, repository, path, maximumBytes),
    };
    this.recordParentDelivery(run.runId, 'file', response);
    return response;
  }
  async keepChanges(agentId: string, revision: number, digest: string): Promise<SafeRun> {
    const run = this.requireOwnedAgent(agentId);
    if (run.status !== 'ready_for_review' || !run.changeSet) throw new Error('AGENT_NOT_READY_FOR_REVIEW');
    await this.containerManager.promote(agentId, revision, digest);
    return safe(
      this.store.setStatus(run.runId, 'promoted', {
        diagnostics: activity('promoted', run.diagnostics),
      }),
    );
  }
  async deleteAgent(agentId: string): Promise<{
    schema_version: 1;
    agent_id: string;
    deleted: true;
    resources_removed: true;
    discarded_run_ids: string[];
    retained_history_run_ids: string[];
    history_retained: true;
  }> {
    const run = this.requireOwnedAgent(agentId);
    if (['queued', 'starting', 'running', 'cancel_requested'].includes(run.status)) await this.cancel(run.runId);
    await this.containerManager.delete(agentId);
    this.adapters.delete(agentId);
    for (const key of this.diffCheckpoints.keys()) if (key.startsWith(`${agentId}\0`)) this.diffCheckpoints.delete(key);
    const deletedAt = now();
    const discardedRunIds: string[] = [];
    const retainedHistoryRunIds: string[] = [];
    for (const candidate of this.store.getByAgent(agentId).filter((item) => this.owns(item))) {
      if (candidate.status === 'ready_for_review') {
        this.store.setStatus(candidate.runId, 'rejected', {
          completedAt: candidate.completedAt ?? deletedAt,
          diagnostics: activity('deleted', candidate.diagnostics, {
            exit_reason: 'agent_deleted',
            resources_deleted_at: deletedAt,
          }),
        });
        discardedRunIds.push(candidate.runId);
        continue;
      }
      this.store.update(
        candidate.runId,
        {
          diagnostics: {
            ...(candidate.diagnostics ?? activity(candidate.status)),
            resources_deleted_at: deletedAt,
          },
        },
        'run.resources_deleted',
      );
      retainedHistoryRunIds.push(candidate.runId);
    }
    return {
      schema_version: 1,
      agent_id: agentId,
      deleted: true,
      resources_removed: true,
      discarded_run_ids: discardedRunIds,
      retained_history_run_ids: retainedHistoryRunIds,
      history_retained: true,
    };
  }
  private queue(runId: string, timeoutSeconds: number): void {
    const run = this.requireOwned(runId);
    const previous = this.queues.get(run.agentId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(() => this.execute(runId, timeoutSeconds));
    this.queues.set(run.agentId, task);
    void task.catch(() => undefined);
  }
  private async execute(runId: string, timeoutSeconds: number): Promise<void> {
    let run = this.requireOwned(runId);
    if (run.status !== 'queued') return;
    const worker = this.worker(run.worker);
    const claimed = this.store.tryStart(runId, this.config.server.max_concurrency, worker.max_concurrency, {
      startedAt: now(),
      diagnostics: activity('starting', run.diagnostics),
    });
    if (!claimed) {
      setTimeout(() => this.queue(runId, timeoutSeconds), 250);
      return;
    }
    run = claimed;
    try {
      if (this.requireOwned(runId).status !== 'starting') return;
      const imageReference = run.imageReference ?? this.config.container.image;
      const probe = await this.containerManager.probe(imageReference);
      if (!probe.supported) throw new Error(`CONTAINER_RUNTIME_UNSUPPORTED:${probe.errorCode ?? 'unknown'}`);
      const profileRepository = run.imageProfile
        ? (run.repositories ?? []).find((repository) => repository.containerPath === run.containerWorkingDirectory)
            ?.name
        : undefined;
      const containerResources = await this.containerManager.prepare(
        run.agentId,
        worker,
        run.repositories ?? [],
        imageReference,
        profileRepository,
      );
      run = this.store.update(
        runId,
        { repositories: [...containerResources.repositories.values()].map((value) => value.runRepository) },
        'run.container_prepared',
      );
      const adapter = this.adapter(
        run.agentId,
        this.containerManager.appServerWorker(worker, containerResources),
        worker.name,
      );
      const basePrompt = buildPrompt(
        run.title,
        run.runId,
        run.task,
        run.grounding,
        worker.worker_prompt ?? this.config.server.default_worker_prompt,
      );
      const prompt = `${basePrompt}\n\nContainer workspace:\n${(run.repositories ?? [])
        .map((repository) => `- ${repository.name}: ${repository.containerPath} (${repository.access})`)
        .join(
          '\n',
        )}\nThis worker is one-way: do not ask the parent questions or attempt to access parent tools. Complete the bounded task with available context, report unresolved ambiguity in the final JSON, and stop.`;
      const workingDirectory = run.containerWorkingDirectory!;
      const started = run.workerThreadId
        ? {
            threadId: run.workerThreadId,
            turnId: await adapter.continue(run.workerThreadId, workingDirectory, prompt),
          }
        : await adapter.createAndStart(workingDirectory, prompt);
      if (this.requireOwned(runId).status !== 'starting') return;
      run = this.store.setStatus(runId, 'running', {
        workerThreadId: started.threadId,
        workerTurnId: started.turnId,
        diagnostics: activity('turn_started', run.diagnostics),
      });
      const outcome = await this.waitForOutcome(adapter, runId, started, timeoutSeconds, worker.idle_timeout_seconds);
      if (this.requireOwned(runId).status !== 'running') return;
      const result = normalize(outcome, this.config.server.final_result_max_characters_per_run);
      const changeSet = await this.containerManager.capture(run.agentId);
      this.store.setStatus(runId, 'ready_for_review', {
        completedAt: now(),
        result,
        changeSet,
        diagnostics: activity('ready_for_review', this.requireOwned(runId).diagnostics),
      });
    } catch (error) {
      this.store.appendRaw(
        runId,
        'stderr',
        `${new Date().toISOString()} ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      const current = this.requireOwned(runId);
      if (current.status === 'cancelled') return;
      const timedOut = error instanceof Error && error.message === 'RUN_TIMEOUT';
      const idleTimedOut = error instanceof Error && error.message === 'RUN_IDLE_TIMEOUT';
      const appServerExit = error instanceof Error && /^CODEX_APP_SERVER_(EXIT|ERROR)/.test(error.message);
      this.store.setStatus(runId, timedOut ? 'timed_out' : 'failed', {
        completedAt: now(),
        errorCode: timedOut
          ? 'RUN_TIMEOUT'
          : idleTimedOut
            ? 'RUN_IDLE_TIMEOUT'
            : appServerExit
              ? 'CODEX_APP_SERVER_EXIT'
              : 'HARNESS_FAILURE',
        diagnostics: activity(
          appServerExit ? 'app_server_exited' : timedOut ? 'timed_out' : idleTimedOut ? 'idle_timed_out' : 'failed',
          current.diagnostics,
          {
            ...(appServerExit || idleTimedOut
              ? { exit_reason: error instanceof Error ? error.message : String(error) }
              : {}),
          },
        ),
        result: emptyResult(),
      });
    }
  }
  private adapter(agentId: string, launchWorker: ContainerAppServerWorker, workerName: string): CodexAppServer {
    let adapter = this.adapters.get(agentId);
    if (!adapter) {
      adapter = new CodexAppServer(launchWorker, (event) => this.onEvent(workerName, event));
      this.adapters.set(agentId, adapter);
    }
    return adapter;
  }
  private waitForOutcome(
    adapter: CodexAppServer,
    runId: string,
    started: { threadId: string; turnId: string },
    timeoutSeconds: number,
    idleTimeoutSeconds: number,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(idleCheck);
        callback();
      };
      const timeout = setTimeout(() => finish(() => reject(new Error('RUN_TIMEOUT'))), timeoutSeconds * 1000);
      const idleCheck = setInterval(
        () => {
          const current = this.requireOwned(runId);
          if (current.status !== 'running') return;
          const activityAt = Date.parse(
            current.diagnostics?.last_activity_at ?? current.startedAt ?? current.createdAt,
          );
          if (Number.isFinite(activityAt) && Date.now() - activityAt >= idleTimeoutSeconds * 1000) {
            void adapter.interrupt(started.threadId, started.turnId).catch(() => undefined);
            finish(() => reject(new Error('RUN_IDLE_TIMEOUT')));
          }
        },
        Math.min(30_000, Math.max(1_000, idleTimeoutSeconds * 1000)),
      );
      adapter.wait(started.turnId).then(
        (outcome) => finish(() => resolve(outcome)),
        (cause) => finish(() => reject(cause)),
      );
    });
  }
  private onEvent(worker: string, event: { method?: string; params?: Record<string, unknown> }): void {
    const raw = JSON.stringify(event);
    for (const run of this.store.list().filter((r) => this.owns(r) && eventMatchesRun(r, worker, event))) {
      this.store.appendRaw(run.runId, 'raw-events', raw + '\n');
      const tokenUsage = tokenUsageFromEvent(event);
      if (tokenUsage) this.recordWorkerTokens(run, tokenUsage);
      const commandTracking = this.trackCommandItem(run, event);
      if (shouldPersistActivity(run, event))
        this.store.update(run.runId, { diagnostics: eventActivity(run, event, commandTracking) }, 'run.activity');
      if (/turn\/(completed|failed)|turn\/complete/i.test(event.method ?? '')) {
        this.commandItemStartedAt.delete(run.runId);
        this.completedCommandItems.delete(run.runId);
      }
    }
  }
  private trackCommandItem(
    run: Run,
    event: { method?: string; params?: Record<string, unknown> },
  ): CommandItemTracking | undefined {
    const item = asRecord(event.params?.item);
    if (item?.type !== 'commandExecution' || typeof item.id !== 'string') return undefined;
    if (/item\/started/i.test(event.method ?? '')) {
      const starts = this.commandItemStartedAt.get(run.runId) ?? new Map<string, string>();
      const existing = starts.get(item.id);
      const startedAt = existing ?? now();
      if (!existing) starts.set(item.id, startedAt);
      this.commandItemStartedAt.set(run.runId, starts);
      return { startedAt, countStarted: !existing };
    }
    if (/item\/completed/i.test(event.method ?? '')) {
      const starts = this.commandItemStartedAt.get(run.runId);
      const startedAt = starts?.get(item.id);
      const completed = this.completedCommandItems.get(run.runId) ?? new Set<string>();
      const countCompleted = !completed.has(item.id);
      completed.add(item.id);
      this.completedCommandItems.set(run.runId, completed);
      return { startedAt, countCompleted };
    }
    return undefined;
  }
  private recordWorkerTokens(
    run: Run,
    usage: { total: number; input: number; cachedInput: number; output: number; reasoningOutput: number },
  ): void {
    const current = run.stats ?? emptyStats();
    const worker = current.worker_tokens ?? {
      total: 0,
      input: 0,
      cached_input: 0,
      output: 0,
      reasoning_output: 0,
      source: 'app_server' as const,
    };
    this.store.update(
      run.runId,
      {
        stats: {
          ...current,
          worker_tokens: {
            total: worker.total + usage.total,
            input: worker.input + usage.input,
            cached_input: worker.cached_input + usage.cachedInput,
            output: worker.output + usage.output,
            reasoning_output: worker.reasoning_output + usage.reasoningOutput,
            source: 'app_server',
          },
        },
      },
      'run.token_usage',
    );
  }
  private recordParentDelivery(
    runId: string,
    category: 'changes' | 'diff' | 'file' | 'lifecycle',
    payload: unknown,
  ): void {
    const run = this.requireOwned(runId);
    const current = run.stats ?? emptyStats();
    const characters = JSON.stringify(payload).length;
    const parent = current.parent_visible;
    const reviews = current.review_requests;
    this.store.update(
      runId,
      {
        stats: {
          ...current,
          parent_visible: {
            characters: parent.characters + characters,
            estimated_tokens: Math.ceil((parent.characters + characters) / 4),
            changes_characters: parent.changes_characters + (category === 'changes' ? characters : 0),
            diff_characters: parent.diff_characters + (category === 'diff' ? characters : 0),
            file_characters: parent.file_characters + (category === 'file' ? characters : 0),
            lifecycle_characters: parent.lifecycle_characters + (category === 'lifecycle' ? characters : 0),
          },
          review_requests: {
            changes: reviews.changes + (category === 'changes' ? 1 : 0),
            diffs: reviews.diffs + (category === 'diff' ? 1 : 0),
            files: reviews.files + (category === 'file' ? 1 : 0),
          },
        },
      },
      'run.parent_delivery',
    );
  }
  private resolveRepositories(
    workingDirectory?: string,
    workspaceName?: string,
    accessOverrides: Record<string, RepositoryAccess> = {},
    workingRepository?: string,
  ): RunRepository[] {
    if (!workspaceName) {
      if (!workingDirectory) throw new Error('WORKING_DIRECTORY_REQUIRED');
      const parentPath = canonicalWorkspace(workingDirectory, this.config);
      const name = workingRepository ?? 'primary';
      if (!/^[a-z0-9-]+$/.test(name)) throw new Error('WORKING_REPOSITORY_NAME_INVALID');
      if (Object.keys(accessOverrides).some((repository) => repository !== name))
        throw new Error('WORKSPACE_REPOSITORY_NOT_FOUND');
      return [
        {
          name,
          parentPath,
          containerPath: `${this.config.container.workspace_path}/${name}`,
          access: accessOverrides[name] ?? 'read-write',
        },
      ];
    }
    const workspace = this.config.workspaces?.find((candidate) => candidate.name === workspaceName);
    if (!workspace) throw new Error('WORKSPACE_NOT_FOUND');
    for (const name of Object.keys(accessOverrides))
      if (!workspace.repositories.some((repository) => repository.name === name))
        throw new Error('WORKSPACE_REPOSITORY_NOT_FOUND');
    if (workingRepository && !workspace.repositories.some((repository) => repository.name === workingRepository))
      throw new Error('WORKING_REPOSITORY_NOT_FOUND');
    return workspace.repositories.map((repository) => ({
      name: repository.name,
      parentPath: canonicalWorkspace(repository.path, this.config),
      containerPath: `${this.config.container.workspace_path}/${repository.name}`,
      access: accessOverrides[repository.name] ?? repository.default_access,
    }));
  }
  private requireOwnedAgent(agentId: string): Run {
    const run = this.store
      .getByAgent(agentId)
      .filter((candidate) => this.owns(candidate))
      .at(-1);
    if (!run) throw new Error('AGENT_UNAVAILABLE');
    return run;
  }
  private worker(name?: string): Worker {
    const worker = name ? this.config.workers.find((w) => w.name === name && w.enabled) : defaultWorker(this.config);
    if (!worker) throw new Error('WORKER_NOT_FOUND_OR_DISABLED');
    return worker;
  }
  private project(run: Run): SafeRun {
    return safe(run);
  }
  private owns(run: Run): boolean {
    return run.ownerId === this.ownerId;
  }
  private requireOwned(id: string): Run {
    const run = this.store.get(id);
    if (!run || !this.owns(run)) throw new Error('RUN_NOT_FOUND');
    return run;
  }
  private timeout(requested: number | undefined, worker: Worker): number {
    const value = requested ?? worker.timeout_seconds ?? this.config.server.default_timeout_seconds;
    if (value > this.config.server.max_timeout_seconds || value <= 0) throw new Error('TIMEOUT_OUT_OF_BOUNDS');
    return Math.min(value, worker.timeout_seconds);
  }
  private validateTitle(title: string): void {
    if (!title.trim() || [...title].length > 120 || /[\r\n]/.test(title)) throw new Error('TITLE_INVALID');
  }
}
function emptyStats(): RunStats {
  return {
    parent_visible: {
      characters: 0,
      estimated_tokens: 0,
      changes_characters: 0,
      diff_characters: 0,
      file_characters: 0,
      lifecycle_characters: 0,
    },
    review_requests: { changes: 0, diffs: 0, files: 0 },
  };
}
function tokenUsageFromEvent(event: {
  method?: string;
  params?: Record<string, unknown>;
}): { total: number; input: number; cachedInput: number; output: number; reasoningOutput: number } | undefined {
  if (event.method !== 'thread/tokenUsage/updated') return undefined;
  const usage = asRecord(asRecord(event.params?.tokenUsage)?.last);
  const total = nonnegativeNumber(usage?.totalTokens);
  const input = nonnegativeNumber(usage?.inputTokens);
  const cachedInput = nonnegativeNumber(usage?.cachedInputTokens);
  const output = nonnegativeNumber(usage?.outputTokens);
  const reasoningOutput = nonnegativeNumber(usage?.reasoningOutputTokens);
  if ([total, input, cachedInput, output, reasoningOutput].some((value) => value === undefined)) return undefined;
  return {
    total: total!,
    input: input!,
    cachedInput: cachedInput!,
    output: output!,
    reasoningOutput: reasoningOutput!,
  };
}
function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function isSettled(status: RunStatus): boolean {
  return ['ready_for_review', 'promoted', 'rejected', 'superseded', 'failed', 'timed_out', 'cancelled'].includes(
    status,
  );
}
export function eventMatchesRun(
  run: Run,
  worker: string,
  event: { method?: string; params?: Record<string, unknown> },
): boolean {
  const threadId = event.params?.threadId;
  const turnId = event.params?.turnId ?? (event.params?.turn as Record<string, unknown> | undefined)?.id;
  return (
    run.worker === worker &&
    typeof threadId === 'string' &&
    typeof turnId === 'string' &&
    run.workerThreadId === threadId &&
    run.workerTurnId === turnId
  );
}
/** Return before the MCP client's outer deadline while preserving at least one second of wait time. */
export function waitDurationSeconds(requested: number, maximum: number, responseReserve: number): number {
  const bounded = Math.min(requested, maximum);
  const reserve = Math.min(responseReserve, Math.max(0, bounded - 1));
  return bounded - reserve;
}
function activity(
  phase: string,
  prior?: Run['diagnostics'],
  extras: Partial<NonNullable<Run['diagnostics']>> = {},
): NonNullable<Run['diagnostics']> {
  return { ...prior, last_phase: phase, last_activity_at: now(), ...extras };
}
function eventActivity(
  run: Run,
  event: { method?: string; params?: Record<string, unknown> },
  commandTracking?: CommandItemTracking,
): NonNullable<Run['diagnostics']> {
  const method = event.method ?? 'event';
  if (/turn\/completed/i.test(method)) return activity('turn_completed', run.diagnostics, { turn_completed_at: now() });
  const item = asRecord(event.params?.item);
  const itemType = typeof item?.type === 'string' ? item.type : undefined;
  if (/item\/started/i.test(method) && item && itemType === 'commandExecution')
    return activity('command_running', run.diagnostics, {
      command_started_at: commandTracking?.startedAt ?? now(),
      command_completed_at: undefined,
      commands_started_count:
        (run.diagnostics?.commands_started_count ?? 0) + (commandTracking?.countStarted === false ? 0 : 1),
      commands_active_count:
        (run.diagnostics?.commands_active_count ?? 0) + (commandTracking?.countStarted === false ? 0 : 1),
      last_command_status: 'running',
      last_command_exit_code: undefined,
      last_command_error_excerpt: undefined,
    });
  if (/commandExecution\/outputDelta/i.test(method))
    return activity('command_running', run.diagnostics, {
      command_started_at: run.diagnostics?.command_started_at ?? now(),
      last_command_status: 'running',
    });
  if (/item\/completed/i.test(method) && item && itemType === 'commandExecution') {
    const rawStatus = typeof item.status === 'string' ? item.status.toLowerCase() : '';
    const exitCode = typeof item.exitCode === 'number' ? item.exitCode : undefined;
    const commandStatus =
      rawStatus === 'declined' || rawStatus === 'cancelled'
        ? 'declined'
        : rawStatus === 'completed' && (exitCode === undefined || exitCode === 0)
          ? 'succeeded'
          : 'failed';
    const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.trim() : '';
    const completedIncrement = commandTracking?.countCompleted === false ? 0 : 1;
    return activity(`command_${commandStatus}`, run.diagnostics, {
      command_started_at: commandTracking?.startedAt ?? run.diagnostics?.command_started_at,
      command_completed_at: now(),
      commands_completed_count: (run.diagnostics?.commands_completed_count ?? 0) + completedIncrement,
      commands_active_count: Math.max(0, (run.diagnostics?.commands_active_count ?? 0) - completedIncrement),
      last_command_status: commandStatus,
      last_command_exit_code: exitCode,
      last_command_error_excerpt:
        commandStatus === 'failed' || commandStatus === 'declined' ? output.slice(0, 1000) || undefined : undefined,
    });
  }
  if (/item\/completed/i.test(method)) return activity(`item_completed_${itemType ?? 'unknown'}`, run.diagnostics);
  return activity(method.replace(/[^a-z0-9]+/gi, '_').toLowerCase(), run.diagnostics);
}
interface CommandItemTracking {
  startedAt?: string;
  countStarted?: boolean;
  countCompleted?: boolean;
}
function shouldPersistActivity(run: Run, event: { method?: string; params?: Record<string, unknown> }): boolean {
  if (!/outputDelta|agentMessage\/delta/i.test(event.method ?? '')) return true;
  const lastActivity = Date.parse(run.diagnostics?.last_activity_at ?? '');
  return !Number.isFinite(lastActivity) || Date.now() - lastActivity >= 1000;
}
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
export function normalize(outcome: Record<string, unknown>, maxCharacters: number): Result {
  const raw = typeof outcome.final_message === 'string' ? outcome.final_message.trim() : '';
  if (!raw)
    return {
      ...emptyResult(),
      reportStatus: 'missing',
      summary: 'Worker turn completed without a final report.',
    };
  const candidate = parseJsonObject(raw);
  if (!candidate)
    return {
      ...emptyResult(),
      reportStatus: 'invalid',
      summary: 'Worker turn completed with an invalid final report.',
      reportExcerpt: raw.slice(0, Math.min(maxCharacters, 2000)),
    };
  const verification = Array.isArray(candidate.verification)
    ? candidate.verification
        .filter(
          (item): item is { name: string; status: 'passed' | 'failed' | 'not_run' } =>
            !!item &&
            typeof item === 'object' &&
            typeof (item as Record<string, unknown>).name === 'string' &&
            ['passed', 'failed', 'not_run'].includes((item as Record<string, unknown>).status as string),
        )
        .slice(0, 100)
    : [];
  const summary = typeof candidate.summary === 'string' ? candidate.summary.slice(0, maxCharacters) : '';
  if (!summary)
    return {
      ...emptyResult(),
      reportStatus: 'invalid',
      summary: 'Worker turn completed with an invalid final report.',
      reportExcerpt: raw.slice(0, Math.min(maxCharacters, 2000)),
    };
  return {
    reportStatus: 'valid',
    summary,
    filesChanged: stringArray(candidate.files_changed, 100),
    verification,
    unresolvedRisks: stringArray(candidate.unresolved_risks, 100),
    requiresUserAction: candidate.requires_user_action === true,
    identityVerified: false,
    ...(typeof candidate.recommended_parent_verification === 'string'
      ? { reportExcerpt: candidate.recommended_parent_verification.slice(0, 1000) }
      : {}),
  };
}
function parseJsonObject(text: string): Record<string, unknown> | undefined {
  // Some local models narrate their work despite the final-report instruction.
  // Accept only the final explicitly fenced JSON object, never an arbitrary JSON
  // fragment from that narration.
  const fenced = [...text.matchAll(/```json\s*([\s\S]*?)\s*```/gi)].at(-1)?.[1];
  if (fenced) return parsedObject(fenced.trim());
  const exact = parsedObject(text.trim());
  if (exact) return exact;
  // Local models sometimes narrate before an otherwise valid plain JSON report.
  // Accept only an object that parses as the complete final suffix.
  for (let index = text.lastIndexOf('{'); index >= 0; index = text.lastIndexOf('{', index - 1)) {
    const candidate = parsedObject(text.slice(index).trim());
    if (candidate) return candidate;
  }
  return undefined;
}
function parsedObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
function stringArray(value: unknown, max: number): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, max) : [];
}
export interface SafeRun {
  schema_version: 1;
  run_id: string;
  agent_id: string;
  status: RunStatus;
  title: string;
  worker: string;
  continuation_index: number;
  continuation_of_run_id?: string;
  image_profile?: string;
  requires_user_action: boolean;
  diagnostics?: Run['diagnostics'];
  result?: Result;
  change_set?: Run['changeSet'];
  delegation_impact?: {
    local_worker_tokens: NonNullable<RunStats['worker_tokens']>;
    parent_visible_review_tokens_estimate: number;
    savings_status: 'unmeasured';
    human_summary: string;
  };
}
export function safe(run: Run): SafeRun {
  const delegationImpact = delegationImpactFor(run.stats);
  return {
    schema_version: 1,
    run_id: run.runId,
    agent_id: run.agentId,
    status: run.status,
    title: run.title,
    worker: run.worker,
    continuation_index: run.continuationIndex,
    ...(run.continuationOfRunId ? { continuation_of_run_id: run.continuationOfRunId } : {}),
    ...(run.imageProfile ? { image_profile: run.imageProfile } : {}),
    requires_user_action: run.requiresUserAction,
    ...(run.diagnostics ? { diagnostics: run.diagnostics } : {}),
    ...(run.result ? { result: run.result } : {}),
    ...(run.changeSet ? { change_set: run.changeSet } : {}),
    ...(delegationImpact ? { delegation_impact: delegationImpact } : {}),
  };
}

function delegationImpactFor(stats?: RunStats): SafeRun['delegation_impact'] | undefined {
  const worker = stats?.worker_tokens;
  if (!worker) return undefined;
  const reviewEstimate = stats?.parent_visible.estimated_tokens ?? 0;
  return {
    local_worker_tokens: worker,
    parent_visible_review_tokens_estimate: reviewEstimate,
    savings_status: 'unmeasured',
    human_summary:
      `Local Engineer processed ${worker.total.toLocaleString('en-US')} tokens locally ` +
      `(${worker.output.toLocaleString('en-US')} output; ${worker.reasoning_output.toLocaleString('en-US')} reasoning) ` +
      `and exposed about ${reviewEstimate.toLocaleString('en-US')} review tokens to the parent. ` +
      'This is offloaded local work, not a measured parent-token saving.',
  };
}
