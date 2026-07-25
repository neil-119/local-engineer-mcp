# Local Engineer MCP specification

## 1. Purpose

Local Engineer delegates bounded software-engineering work from a parent Codex
agent to locally hosted coding models. Every worker MUST run autonomously in a
disposable container. The parent remains responsible for task decomposition,
security-sensitive decisions, integration, independent review, and the final
user-facing answer.

The product MUST minimize parent-context consumption without treating worker
output as trusted.

## 2. Container-only execution

- Host-native workers MUST NOT be supported.
- Parent repositories MUST NOT be mounted into worker containers.
- Per-command parent or human approval MUST NOT be part of the worker lifecycle.
- Native Codex resume commands and native-session recovery MUST NOT be exposed.
- Codex app-server MAY be used only inside the disposable worker container.
- Unsupported container runtimes MUST fail closed; there is no host-execution
  fallback.

## 3. Runtime contract

The user MUST configure a Docker-compatible CLI command. Docker, Podman,
nerdctl, or another compatible CLI MAY be used when it passes the capability
probe.

The supported runtime operations are deliberately bounded to image build/commit and
inspection, container create/start/exec/log/stop/remove, volume
create/inspect/remove, and network create/connect/inspect/remove.

The capability probe MUST use uniquely named temporary resources and MUST
verify:

- runtime and daemon availability;
- configured image availability;
- container creation and removal;
- internal-network creation and connection; and
- exact cleanup of probe resources.

## 4. Agent isolation

Each agent MUST own:

- one worker container;
- one network-policy proxy sidecar;
- one internal network without direct egress;
- one egress-capable network connected only to the proxy;
- one ephemeral workspace volume;
- separate ephemeral worker and proxy configuration volumes; and
- locally persisted bounded lifecycle and review artifacts.

The worker MUST NOT receive:

- the container-runtime socket;
- host repository mounts;
- the host home directory;
- SSH-agent, browser-profile, or parent MCP credentials;
- a reusable host `CODEX_HOME`; or
- parent plugins, hooks, web search, or MCP server configuration.

Long-lived containers MUST use read-only root filesystems and drop all Linux
capabilities. A short-lived setup container MAY use only the capability needed
to seed ownership and MUST be removed before the worker starts.

## 5. Network policy

The worker MUST have no direct external route. HTTP, HTTPS, WebSocket, and
SOCKS traffic MUST be configured through the proxy sidecar.

The policy sidecar MUST:

- expose a fixed-target model relay that permits the model API's required
  methods but cannot target any other host;
- operate the dependency proxy in limited mode with TLS inspection;
- permit only `GET`, `HEAD`, and `OPTIONS` to exact dependency domains;
- reject all other methods and unlisted domains;
- reject global domain wildcards and overlap between model and dependency
  domains;
- disable unrestricted Unix sockets; and
- permit private/local model endpoints only through an explicit configuration
  option.

The proxy is defense in depth; environment proxy variables alone are not an
acceptable network boundary.

## 6. Repository snapshots

Every repository MUST:

- be explicitly selected by path or named workspace alias;
- be inside a configured allowed root;
- be a Git repository with a valid `HEAD`; and
- have a `read-only` or `read-write` access mode.

Local Engineer MUST copy the selected repository's complete worktree into the
private workspace, including:

- committed files;
- staged changes;
- unstaged changes; and
- all untracked and ignored files.

The parent repository's root `.git` metadata MUST be removed from the private
workspace and replaced with Local Engineer's private snapshot metadata before
the worker starts.

Ignored files MUST be available to the worker but MUST NOT be included in the
Git change set or promoted to the parent. Documentation MUST warn that all files
inside a selected worktree are readable by the untrusted worker and that full
copies increase startup time and temporary storage use.

Each worker MUST receive an agent-scoped writable dependency location outside
the selected repositories. Local Engineer MUST direct temporary virtual
environments and package/cache state there and MUST exclude its managed
repository dependency paths from Git capture and promotion as a defense in
depth measure.

If the copied state is dirty, Local Engineer MUST create an ephemeral commit
inside the private snapshot. That commit is the worker comparison baseline and
MUST NOT modify the parent repository.

Read-only snapshots MUST be owned by a privileged identity unavailable to the
worker and have filesystem write permission removed after private Git metadata
is normalized. The unprivileged worker MUST NOT be able to restore write
permission. Local Engineer MUST configure Git safe-directory entries only for
the selected read-only paths and MUST perform its authoritative integrity check
as the privileged repository owner. Any detected change to a read-only
repository MUST fail the run and prevent promotion.

## 7. Worker configuration

Every named worker MUST select:

- a model;
- a model provider or trusted container Codex config;
- concurrency and timeout limits; and
- optional repository-specific prompt policy.

Generated Codex configuration MUST use autonomous approval and sandbox settings
inside the container. The external container, network, and Git-promotion
boundaries are authoritative.

The bundled worker image MUST provide Node.js 24, Python 3.12, pip, and venv.
Projects MAY select a custom base image for additional toolchains or caches.
Project dependency downloads remain subject to the explicit read-only domain
list.

Local Engineer MUST support reusable project image profiles. Planning MUST be
read-only and deterministic over the selected repository, profile name, shared
base image, dependency inputs, installer steps, and required domains. A build
MUST require:

- the exact previously returned plan digest;
- explicit parent assertion that the user approved the build;
- every inferred or parent-supplied dependency domain to be present in the
  configured read-only domain list; and
- unchanged hashed inputs.

Generated plans MAY support a deliberately bounded set of package managers.
Unsupported toolchains MUST return a reviewed external-base-image
recommendation rather than guess. The hardened project-image builder MUST NOT
execute arbitrary project Dockerfiles. Local Engineer MUST NOT edit `AGENTS.md`;
it MAY return a suggested profile instruction.

Dependency installation MUST run in a temporary root-owned container connected
only to a per-build internal network. Only the limited dependency proxy MAY
connect that network to egress. After installation, Local Engineer MAY use the
container runtime's image-commit operation to create the immutable profile.
Completed builds MUST pass a read-only worker-contract check
and be recorded by immutable image ID. Starting with a missing or stale profile
MUST fail closed with a structured rebuild recommendation.

Custom Codex configuration containing MCP servers, hooks, plugins, or web search
MUST be rejected.

Credential values MUST NOT appear in configuration samples, runtime command
arguments, MCP responses, or logs. Host credentials MAY be inherited only by
explicitly allowlisted environment-variable name.

## 8. One-way worker contract

Workers MUST NOT:

- ask the parent questions;
- invoke parent tools;
- access parent MCP servers; or
- stream command logs or whole-file writes into parent context.

The parent MAY send a follow-up only after the worker reaches
`ready_for_review`. A follow-up MUST continue the same private Codex session and
produce a new complete change-set revision. The prior run record MUST become
`superseded` so it cannot be mistaken for the agent's current review revision.

## 9. Lifecycle

The primary lifecycle is:

```text
queued -> starting -> running -> ready_for_review
ready_for_review -> superseded         (prior run when parent follows up)
new continuation -> queued             (same agent and private session)
ready_for_review -> promoted           (exact reviewed revision)
ready_for_review -> rejected           (delete/discard)
running -> cancel_requested -> cancelled
running -> failed | timed_out
```

Starting work MUST return opaque `run_id` and `agent_id` handles immediately.
Wait and status operations MUST return bounded projections. Parent ownership
MUST be scoped to the current MCP connection.

## 10. Review artifacts

After a turn, Local Engineer MUST independently stage the private repository
and capture:

```text
git diff --cached --binary --full-index --no-renames <baseline>
```

The captured revision MUST include:

- a monotonically increasing revision number;
- the preceding revision number;
- a content digest;
- per-repository changed paths;
- addition and deletion counts; and
- per-repository full and since-prior-revision patch digests.

Local Engineer MUST retain private review commits so it can produce an exact
patch between any retained review revisions. `local_engineer_get_diff` MUST
default to changes since the last completely delivered diff for that parent
connection. A truncated response MUST NOT advance this cursor. The parent MAY
request the full current patch explicitly.

The worker's self-reported changed files are advisory. Captured Git evidence is
authoritative.

MCP MUST expose only bounded:

- lifecycle status;
- structured final report;
- change metadata;
- requested repository diff excerpts; and
- requested text-file contents.

Raw events, full logs, private thread identifiers, credentials, and local
artifact paths MUST remain local.

## 11. Promotion

Promotion MUST require the exact reviewed revision and digest.

Before applying any patch, Local Engineer MUST verify:

- the revision and digest still match;
- every affected parent repository is still at the recorded `HEAD`;
- affected working-tree and index paths match the snapshot baseline;
- every changed path remains inside its repository; and
- every patch passes `git apply --check`.

Multi-repository promotion MUST validate all repositories before applying any
patch. A failure MUST apply nothing or roll back already applied patches.

Successful promotion MUST leave changes uncommitted and unstaged in the parent
checkout. The agent remains available until explicit deletion.

## 12. MCP tools

The server MUST expose:

- `local_engineer_start`
- `local_engineer_build_image`
- `local_engineer_wait_for_completion`
- `local_engineer_reply`
- `local_engineer_status`
- `local_engineer_cancel`
- `local_engineer_list`
- `local_engineer_get_changes`
- `local_engineer_get_diff`
- `local_engineer_get_file`
- `local_engineer_keep_changes`
- `local_engineer_delete_agent`

It MUST NOT expose command-approval or session-resume tools.

Agent deletion MUST be idempotent, including after a failed setup has already
removed the disposable runtime resources. It MUST return explicit cleanup
confirmation, terminalize stale review runs, and retain bounded terminal run
history for observability. Run listing MUST support filtering to active work
only.

## 13. Operator CLI

The CLI MUST support:

- configuration/runtime validation;
- shared worker-image builds; and
- bounded persisted run listings; and
- persisted token and review-payload statistics with time, agent, and run
  filters.

It MUST NOT support launching a host-native Codex resume session.

## 14. Observability

The local state directory SHOULD contain:

- SQLite lifecycle state;
- bounded rotating server logs;
- per-run request, result, events, stdout, stderr, and raw harness events; and
- per-agent snapshots, patches, generated configs, and resource metadata.

When Codex app-server emits worker token-usage events, Local Engineer SHOULD
persist exact worker input, cached-input, output, and reasoning counts.
Parent-visible structured review payloads SHOULD be counted in characters and
clearly labeled as token estimates. Exact savings MUST NOT be claimed without a
user-supplied controlled direct-versus-delegated parent-token comparison.

Server logs MUST rotate at a configurable maximum size. Sensitive values MUST
not be included in MCP projections or committed examples.

## 15. Concurrency

The scheduler MUST enforce global and per-worker concurrency limits across the
shared state directory. Continuations for one agent MUST execute serially.

Container agents MAY edit separate private snapshots concurrently. Promotion
MUST use exact affected-path checks and repository locks.

## 16. Portability and limitations

The implementation targets Windows, macOS, and Linux hosts with a
Docker-compatible runtime.

Version-one limitations MAY include:

- repositories without a valid `HEAD`;
- promotion of ignored files and non-Git state;
- host dependency trees that are incompatible with the worker container's
  operating system or architecture;
- submodules, Git LFS, unusual modes, and very large binaries;
- adoption after a parent MCP connection restart; and
- automatic reconciliation of crash-orphaned runtime resources.
