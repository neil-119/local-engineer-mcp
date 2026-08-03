# Local Engineer implementation plan

## Completed

- Removed the legacy host worker backend; every configured worker now runs in a
  disposable container.
- Removed per-command parent approval, human resume, and host-session recovery
  from configuration, MCP tools, CLI commands, projections, and tests.
- Updated documentation and samples for the container-only lifecycle.
- Scanned tracked and packageable files for credentials, personal usernames,
  machine-specific repository paths, and private network addresses.
- Passed formatting, lint, build, tests, package inspection, and documentation
  validation.
- Implemented explicit single- and multi-repository Git snapshots.
- Added dirty-worktree baselines using private ephemeral commits.
- Added complete worktree seeding, including ignored dependency and build
  state, while replacing parent Git metadata with the private baseline before
  worker startup.
- Added Docker-compatible runtime capability probing and image builds.
- Added isolated worker/proxy containers, internal and egress networks, and
  ephemeral configuration/workspace volumes.
- Added network domain allowlisting and environment-variable-name credential
  injection.
- Added bounded status, wait, list, cancellation, and structured final reports.
- Added independently captured change-set revisions, focused diff/file review,
  guarded multi-repository promotion, and explicit agent deletion.
- Added Windows, macOS, and Linux CI plus GitHub Release artifacts.
- Enforced read-only repository snapshots through root ownership plus removed
  write bits after Git normalization, without granting the worker extra
  capabilities.
- Added path-scoped Git safe-directory configuration for read-only workers and
  privileged post-run integrity checks to avoid false dubious-ownership
  failures.
- Made agent deletion idempotent when failed setup has already removed runtime
  resources.
- Added explicit deletion confirmation, `superseded` continuation history, and
  active-only run listing so historical revisions cannot look like live work.
- Added Python 3.12, pip, and venv to the bundled Node.js worker image and
  strengthened the blocked-run JSON final-report contract.
- Added deterministic project-image planning and explicitly approved builds,
  immutable profile registration, stale-input detection, and profile-aware
  worker starts.
- Added private review-commit chains and connection-scoped
  `since_last_check` diffs so follow-up review does not resend previously
  reviewed patches.
- Added persisted exact worker-token counters, bounded review-payload
  estimates, filtered CLI statistics, and optional controlled A/B savings.
- Added parent-to-worker assignment/follow-up payload accounting: exact
  character counts and clearly labeled token estimates, separate from the
  parent model's unknown full conversational usage.
- Expanded CI compatibility coverage to Node.js 22 and 24, matching the
  built-in `node:sqlite` requirement.
- Live-validated the restarted MCP schemas, deterministic image planning,
  missing-profile failure, read-only container lifecycle, structured report,
  empty review capture, incremental diff cursor, token statistics, and exact
  resource cleanup.
- Split network policy into exact model domains served by a fixed-target relay
  and exact dependency domains restricted to GET, HEAD, and OPTIONS.
- Routed generated project-image dependency installation through an isolated
  internal network and limited proxy, then committed the resulting disposable
  installer filesystem into the immutable profile image.
- Live-validated allowed dependency HEAD (200), denied dependency POST (403),
  denied unlisted-domain CONNECT (403), full-method model relay delivery, and a
  real pnpm project-image build through the isolated proxy.
- Post-restart direct worker smoke completed `ready_for_review` with a valid
  structured report, a successful read-only command, no changed files, and
  explicit disposal of the worker resources.
- Added a read-only localhost monitor with server-side cursor pagination for
  persisted runs and bounded, on-demand pages of completed worker messages.
- Added SQLite-backed message deduplication, truncation, newest-message
  retention, private sequence cursors, and tests proving Codex item IDs do not
  enter monitor responses.

## Pending

- Automatic cleanup and state reconciliation after host, MCP server, or
  container-runtime crashes.
- Equivalent live end-to-end validation for Podman and nerdctl.
- npm publication after the package and release process are ready.

## Notes

- Workers are deliberately one-way and cannot invoke parent tools or ask the
  parent questions.
- Parent repositories are never mounted into worker containers.
- Promotion is Git-only and leaves parent changes uncommitted.
- Ignored files are copied for worker execution but remain outside the
  promotion contract.
- Full worktree copies increase per-agent startup time and temporary disk use.
