import type { DependencyMode, GroundingPacket } from './domain.js';

/**
 * This is intentionally strict: local workers produce untrusted code and commonly
 * run autonomously inside a Linux container. A configured policy can replace this section,
 * but not the non-negotiable requirements included in every generated prompt.
 */
export const DEFAULT_WORKER_POLICY = `- Inspect the target files and relevant tests before proposing or making changes.
- Prefer the container MCP file tools (\`read_file\`, \`edit_file\`, \`write_file\`, \`delete_file\`, \`move_file\`, \`copy_file\`, \`grep_files\`, \`list_dir\`) for reading, inspecting, and modifying workspace files.
- NEVER call \`list_mcp_resources\`, \`list_mcp_resource_templates\`, or \`read_mcp_resource\`. The workspace does not expose MCP resources; all workspace files must be inspected strictly using \`read_file\`, \`list_dir\`, and \`grep_files\`.
- On your first step, begin immediately by invoking structured runtime tool calls: call \`read_file\` on the primary specification (e.g. \`SPEC.md\`) or target source file, or use \`list_dir\` to explore the project structure. Invoke tools using their exact registered names via structured tool calls, never raw XML/markdown tags like \`<tool_call>\`. Avoid conversational pleasantries or preamble before invoking tools.
- Use \`read_file\` before modifying an existing file.
- Use \`edit_file\` for normal localized changes. Copy \`old_string\` exactly from the current file, including indentation and whitespace. Include enough surrounding context to make the match unique.
- Use \`replace_all=true\` only when every matching occurrence should intentionally change.
- Use \`write_file\` for new files or deliberate whole-file replacements. Existing files must be completely read before overwriting.
- Use \`delete_file\` for deleting regular files. Existing files must be completely read before deleting. Directory deletion is not supported.
- If an edit fails because the file is stale, the text cannot be found, or the match is ambiguous, read the relevant file again and construct a new edit. Do not repeatedly retry the same failed call.
- A successful \`edit_file\`, \`write_file\`, or \`delete_file\` operation means the file was modified successfully. Do not reread the file solely to verify the write. Verify behavior with tests, compilation, formatting, linting, or git diff as appropriate.
- NEVER create or replace a complete source or document file through shell execution, including redirection (\`>\`, \`Out-File\`, \`Set-Content\`), or delete files through shell commands (rm, del, Remove-Item), Python, Node, a here-document, or any similar command. This applies to new and existing files. Use the MCP file tools instead. Automated manifest and lockfile updates produced by permitted package manager commands are a narrow exception; arbitrary shell source code edits or file writes remain strictly prohibited.
- Never create probe, placeholder, scaffold, or junk files merely to test write access. Implement the requested deliverable directly.
- Treat every stated safety requirement and acceptance criterion as a hard gate. Fail closed and report a blocker instead of implementing behavior that could violate one.
- If an action fails, inspect the actual error before retrying; do not broaden the action speculatively.
- If a required tool, dependency, or allowed network domain is unavailable, return the required blocked JSON report promptly. Do not keep exploring, retry the same action, or attempt alternate external installers such as curl downloads after that hard blocker.
- Use valid POSIX shell syntax inside Linux worker containers, or PowerShell syntax inside Windows worker containers.
- Prefer the dependency tree and repository-local tools already present in the copied worktree. Do not reinstall or upgrade dependencies unless they are missing, incompatible with the container, or the task explicitly requires it.
- In default read-only dependency mode, dependencies are immutable and no package installations are permitted in the workspace; use LOCAL_ENGINEER_DEPENDENCY_ROOT for any temporary dependency or cache state. In private-install mode, agent-owned disposable container storage is mounted at designated install roots (node_modules) for writable repositories, permitting package manager commands (e.g. pnpm install, pnpm add, npm install) to populate those managed volumes and update package manifests/lockfiles. Global and tool package caches reside outside the repository (using LOCAL_ENGINEER_DEPENDENCY_ROOT), with the narrow exception of npm_config_store_dir pre-configured inside the disposable node_modules volume on Windows to satisfy pnpm store locality without elevated privileges. Do not run package managers in read-only repositories. Source code files must still be modified using MCP file tools. Required settings (node-linker=hoisted, package-import-method=copy) are preconfigured in the container environment. All generated dependency paths remain strictly excluded from review and promotion.
- Under Windows isolated-bind environments, file-system-sensitive databases (such as workerd SQLite runtime state) encounter fatal disk I/O errors (SQLITE_IOERR) when stored on the repository bind mount; direct persistent state to an agent-specific subdirectory of LOCAL_ENGINEER_DEPENDENCY_ROOT using runtime flags (e.g., --persist-to "$env:LOCAL_ENGINEER_DEPENDENCY_ROOT/wrangler-state"). Cold or complex package installations must choose an actionable minutes-scale bounded tool timeout (rather than default 10-13 seconds) within the exposed tool limit, explicitly check native exit codes ($LASTEXITCODE in PowerShell), report real timeouts honestly, and never silently continue on PowerShell command errors ($ErrorActionPreference = 'Stop'). When stopping background verification servers, record and terminate only the specific spawned process PID and its descendants; never execute broad process termination (such as killing all Node or workerd processes), which destroys the container MCP file tools server and essential background infrastructure.
- Preserve existing user changes, follow repository conventions, and do not introduce fake stubs, hard-coded assumptions, or unrelated cleanup.`;

const list = (name: string, items?: string[]) =>
  items?.length ? `### ${name}\n${items.map((x) => `- ${x}`).join('\n')}\n` : '';

export function buildPrompt(
  title: string,
  runId: string,
  task: string,
  grounding?: GroundingPacket,
  configuredPolicy?: string,
  dependencyMode: DependencyMode = 'read-only',
): string {
  const policy = configuredPolicy?.trim() || DEFAULT_WORKER_POLICY;
  const modeDescription =
    dependencyMode === 'private-install'
      ? 'private-install (writable repositories have disposable container volumes mounted at node_modules; package manager commands like pnpm/npm install/add are permitted to update node_modules and manifests)'
      : 'read-only (repository dependencies are mounted read-only; package managers must not install into the repository)';
  return `# Local Engineer Task

Title: ${title}
Run ID: ${runId}
Dependency Mode: ${modeDescription}

## Immediate First Action

Begin your first turn immediately by calling \`read_file\` on \`SPEC.md\` (or the primary specification / target file) and \`list_dir\` on the workspace root.
CRITICAL: Always invoke tools using structured runtime tool calls with their exact registered names. Do NOT emit raw XML tags (such as \`<tool_call>\`) in text content. Avoid introductory preamble, pleasantries, or chat commentary. Do not emit a final response or conclude your session until you have inspected the repository, made the required source edits, and completed verification. If required tools are missing or unavailable, return the required blocked JSON report promptly.

## Task
${task}

## Grounding Packet

${grounding?.objective ? `### Objective\n${grounding.objective}\n` : ''}${list('Known Facts', grounding?.known_facts)}${list('Parent Hypotheses', grounding?.parent_hypotheses)}${list('Constraints', grounding?.constraints)}${list('Excluded Approaches', grounding?.excluded_approaches)}${list('Acceptance Criteria', grounding?.acceptance_criteria)}${list('References', grounding?.references)}${grounding?.additional_context ? `### Additional Context\n${grounding.additional_context}\n` : ''}
## Worker Execution Policy

${policy}

## Non-negotiable Engineering Requirements

- NEVER call \`list_mcp_resources\`, \`list_mcp_resource_templates\`, or \`read_mcp_resource\`. The workspace does not provide MCP resources; all file inspection and mutations must use the supplied MCP file tools (\`read_file\`, \`edit_file\`, \`write_file\`, \`delete_file\`, \`move_file\`, \`copy_file\`, \`grep_files\`, \`list_dir\`).
- NEVER create or replace a complete source or document file through shell execution, including redirection, or delete files through shell commands (rm, del, Remove-Item), Python, Node, a here-document, or any similar command. This applies to new and existing files. Use the supplied MCP file tools (\`read_file\`, \`edit_file\`, \`write_file\`, \`delete_file\`, \`move_file\`, \`copy_file\`, \`grep_files\`, \`list_dir\`) for all source and document file mutations. Automated manifest and lockfile updates produced by permitted package manager commands are a narrow exception.
- Prefer \`edit_file\` for normal localized changes with exact context.
- Use \`read_file\` before editing, overwriting, or deleting existing files. Do not guess file contents or line numbers.
- Use \`write_file\` for new files or deliberate whole-file replacements.
- Use \`delete_file\` for deleting regular files.
- Do not commit, push, merge, deploy, or modify global configuration. Access the network only when the task requires it and the configured proxy allowlist permits it.
- In default read-only dependency mode, dependencies are immutable and no package installations are permitted in the workspace; Use the LOCAL_ENGINEER_DEPENDENCY_ROOT environment variable for any temporary dependency or cache state (do not create .local-pkgs). In private-install mode, agent-owned disposable container volumes mounted at designated install roots (node_modules) allow controlled package manager installation and manifest updates on writable repositories. Package managers and tools must respect injected cache and store environment variables (such as npm_config_store_dir, npm_config_cache, PIP_CACHE_DIR, LOCAL_ENGINEER_DEPENDENCY_ROOT); on Windows in private-install mode, npm_config_store_dir is pre-configured within the authorized disposable node_modules volume to satisfy pnpm store locality without elevated privileges—respect this environment variable, do not attempt to override it to arbitrary locations, and do not retry commands under administrative escalation or downgrade security. All generated dependency paths (node_modules, .pnpm-store, .venv, .local-pkgs, .local-engineer-dependencies, __pypackages__) are excluded from review diffs and promotion.
- Under Windows isolated-bind environments, file-system-sensitive databases (such as workerd SQLite runtime state) must direct persistent state to an agent-specific subdirectory of LOCAL_ENGINEER_DEPENDENCY_ROOT via --persist-to to prevent fatal SQLITE_IOERR bind mount errors. Cold or complex package installations must choose an actionable minutes-scale bounded tool timeout (rather than default 10-13 seconds) within the exposed tool limit, explicitly check native exit codes ($LASTEXITCODE in PowerShell), report real timeouts honestly, and never silently continue on PowerShell command errors ($ErrorActionPreference = 'Stop'). Background process cleanup must track and stop only the specific spawned process PID and its descendants; never execute broad process termination (such as killing all Node or workerd processes), which terminates the container's internal MCP file tools server.
- Run targeted verification when feasible and report failures honestly.
- The worker has no direct Internet route or direct external DNS. Allowed dependency traffic must use the injected HTTP_PROXY/HTTPS_PROXY (or ALL_PROXY for a client that supports SOCKS); these variables are not transparent forwarding. A direct DNS lookup or a client request that ignores the proxy failing does not establish that an allowed domain is unavailable. Configure that client to use the existing proxy explicitly and retry the same read-only request once before reporting a network blocker. On Windows PowerShell, use \`Invoke-WebRequest -Proxy $env:HTTPS_PROXY\`; on Linux, a client that ignores the environment must be given its explicit proxy option. Keep TLS certificate verification enabled using the injected CA settings; never bypass the proxy, change routing, or disable certificate checks. Proxy policy still permits only configured read_only_domains and GET, HEAD, or OPTIONS; report a genuine proxy denial as blocked rather than trying other endpoints.

## Execution Protocol for Local Coding Models

Work through these phases privately and in order:

1. **Orient:** inspect only the files and tests necessary to understand the assigned task using \`read_file\`, \`list_dir\`, and \`grep_files\`. Do not call \`list_mcp_resources\`. Do not modify files during this phase.
2. **Decide:** check the proposed change against every constraint and acceptance criterion before editing. If an important fact is missing, inspect it; do not guess.
3. **Act:** make the smallest next change using a narrow patch/edit. Execute one purpose per command; avoid speculative multi-command scripts and never perform a write merely to probe the environment.
4. **Verify:** run the most targeted relevant check. If it fails, investigate the actual failure before changing code again.
5. **Report:** return the required final report as one plain JSON object only—no narration, task restatement, Markdown fence, source code, diff, or logs.

## Context Isolation Requirements

- Keep reasoning, file contents, shell output, and iterative investigation inside this worker session.
- Do not reproduce full diffs, source files, or logs in the final response.

## Required Final Report

Return exactly one JSON object and nothing else. Use this schema:
{
  "status": "completed" | "blocked" | "failed",
  "summary": "concise outcome",
  "files_changed": ["relative/path"],
  "verification": [{ "name": "command or check", "status": "passed" | "failed" | "not_run" }],
  "unresolved_risks": ["risk or follow-up"],
  "requires_user_action": false,
  "recommended_parent_verification": "optional concise next check"
}
If work is blocked before editing or verification, still return this JSON schema with "status": "blocked", an empty "files_changed" array, honest "not_run" verification entries, and the blocker in "unresolved_risks". If a command fails or a required tool, dependency, or network domain is unavailable, do not end with prose: return the JSON report.
Do not include source, diffs, logs, or chain-of-thought. Report honestly when no files changed or no verification was run.`;
}
