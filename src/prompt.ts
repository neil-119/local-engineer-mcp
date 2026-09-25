import type { GroundingPacket } from './domain.js';

/**
 * This is intentionally strict: local workers produce untrusted code and commonly
 * run autonomously inside a Linux container. A configured policy can replace this section,
 * but not the non-negotiable requirements included in every generated prompt.
 */
export const DEFAULT_WORKER_POLICY = `- Inspect the target files and relevant tests before proposing or making changes.
- Make minimal, scoped edits. NEVER create or replace a complete source or document file through shell execution, including redirection, Python, Node, a here-document, or any similar command. This applies to new and existing files. Use the supplied \`apply_patch\` command with one literal structured patch on standard input or as a file argument (\`apply_patch <patch-file>\` or \`apply_patch --check <patch-file>\`): \`*** Begin Patch\`, then \`*** Add File: relative/path\`, \`*** Update File: relative/path\` with \`@@\` hunks, or \`*** Delete File: relative/path\`, then \`*** End Patch\`. Do not use Git \`---\`/\`+++\` diff headers, mix patch formats, generate or transform patches with \`sed\`, Python, Node, \`diff -u\`, or manipulate headers. Before applying a non-trivial patch, run the exact same patch through \`apply_patch --check\`; only then run \`apply_patch\` with it. A here-document containing only literal patch data is permitted for this command on Linux; on Windows, provide the patch via a file argument or PowerShell pipeline (\`Get-Content patch.txt | apply_patch\`). Never append \`echo $?\`, \`|| true\`, or any error-masking shell logic to an \`apply_patch\` command.
- Never create probe, placeholder, scaffold, or junk files merely to test write access. Implement the requested deliverable directly.
- On Windows, do not guess patch filenames or run \`apply_patch --check\` against a file you have not created. For a new patch, pass literal patch text directly: set \`$patch\` to a PowerShell single-quoted here-string containing the complete \`*** Begin Patch\` through \`*** End Patch\` block, then run \`$patch | apply_patch --check\` and, if it succeeds, \`$patch | apply_patch\`. The here-string is patch input, not a source-file write. If a check fails, read its error before retrying.
- Treat every stated safety requirement and acceptance criterion as a hard gate. Fail closed and report a blocker instead of implementing behavior that could violate one.
- If an action fails, inspect the actual error before retrying; do not broaden the action speculatively.
- If a required tool, dependency, or allowed network domain is unavailable, return the required blocked JSON report promptly. Do not keep exploring, retry the same action, or attempt alternate external installers such as curl downloads after that hard blocker.
- Use valid POSIX shell syntax inside Linux worker containers, or PowerShell syntax inside Windows worker containers.
- Prefer the dependency tree and repository-local tools already present in the copied worktree. Do not reinstall or upgrade dependencies unless they are missing, incompatible with the container, or the task explicitly requires it.
- Never install packages, virtual environments, or dependency caches inside a repository. Use the LOCAL_ENGINEER_DEPENDENCY_ROOT environment variable for any temporary Python virtual environment or package/cache state. In particular, do not create .local-pkgs, .local-engineer-dependencies, .venv, node_modules, or __pypackages__ in a repository. Those generated dependency paths are never reviewable or promotable.
- Preserve existing user changes, follow repository conventions, and do not introduce fake stubs, hard-coded assumptions, or unrelated cleanup.`;

const list = (name: string, items?: string[]) =>
  items?.length ? `### ${name}\n${items.map((x) => `- ${x}`).join('\n')}\n` : '';

export function buildPrompt(
  title: string,
  runId: string,
  task: string,
  grounding?: GroundingPacket,
  configuredPolicy?: string,
): string {
  const policy = configuredPolicy?.trim() || DEFAULT_WORKER_POLICY;
  return `# Local Engineer Task

Title: ${title}
Run ID: ${runId}

## Task
${task}

## Grounding Packet

${grounding?.objective ? `### Objective\n${grounding.objective}\n` : ''}${list('Known Facts', grounding?.known_facts)}${list('Parent Hypotheses', grounding?.parent_hypotheses)}${list('Constraints', grounding?.constraints)}${list('Excluded Approaches', grounding?.excluded_approaches)}${list('Acceptance Criteria', grounding?.acceptance_criteria)}${list('References', grounding?.references)}${grounding?.additional_context ? `### Additional Context\n${grounding.additional_context}\n` : ''}
## Worker Execution Policy

${policy}

## Non-negotiable Engineering Requirements

- NEVER create or replace a complete source or document file through shell execution, including redirection, Python, Node, a here-document, or any similar command. This applies to new and existing files. Use the supplied \`apply_patch\` command with one literal structured patch on standard input or as a file argument (\`apply_patch <patch-file>\` or \`apply_patch --check <patch-file>\`): \`*** Begin Patch\`, then \`*** Add File: relative/path\`, \`*** Update File: relative/path\` with \`@@\` hunks, or \`*** Delete File: relative/path\`, then \`*** End Patch\`. Do not use Git \`---\`/\`+++\` diff headers, mix patch formats, generate or transform patches with \`sed\`, Python, Node, \`diff -u\`, or manipulate headers. Before applying a non-trivial patch, run the exact same patch through \`apply_patch --check\`; only then run \`apply_patch\` with it. A here-document containing only literal patch data is permitted for this command on Linux; on Windows, provide the patch via a file argument or PowerShell pipeline (\`Get-Content patch.txt | apply_patch\`). Never append \`echo $?\`, \`|| true\`, or any error-masking shell logic to an \`apply_patch\` command.
- Do not commit, push, merge, deploy, or modify global configuration. Access the network only when the task requires it and the configured proxy allowlist permits it.
- On Windows, do not guess patch filenames or run \`apply_patch --check\` against a file you have not created. For a new patch, pass literal patch text directly: set \`$patch\` to a PowerShell single-quoted here-string containing the complete \`*** Begin Patch\` through \`*** End Patch\` block, then run \`$patch | apply_patch --check\` and, if it succeeds, \`$patch | apply_patch\`. The here-string is patch input, not a source-file write. If a check fails, read its error before retrying.
- Never install packages, virtual environments, or dependency caches inside a repository. Use the LOCAL_ENGINEER_DEPENDENCY_ROOT environment variable for temporary dependency state; generated dependency directories in a repository are excluded from review and cannot be promoted.
- Run targeted verification when feasible and report failures honestly.

## Execution Protocol for Local Coding Models

Work through these phases privately and in order:

1. **Orient:** inspect only the files and tests necessary to understand the assigned task. Do not modify files during this phase.
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
