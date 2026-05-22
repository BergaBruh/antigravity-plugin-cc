---
name: antigravity-cli-runtime
description: Internal helper contract for calling the antigravity-companion runtime from Claude Code
user-invocable: false
---

# Antigravity Runtime

Use this skill only inside the `antigravity:antigravity-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct `agy` strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `antigravity:antigravity-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- Do not inspect the repository, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Default to a write-capable agy run by adding `--write` unless the user explicitly asks for read-only behavior. The companion translates `--write` into `agy --dangerously-skip-permissions` so agy can act on the workspace without an interactive approval prompt.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run. It maps to `agy --continue` (or `agy --conversation <id>` when a specific conversation ID has been tracked).

agy CLI surface (relevant flags only):
- `agy --print` runs a single non-interactive prompt and writes the final assistant message to stdout.
- `agy --print-timeout <duration>` overrides the 5m print-mode wait.
- `agy --continue` resumes the most recent conversation.
- `agy --conversation <id>` resumes a specific conversation by UUID.
- `agy --add-dir <path>` adds a workspace directory.
- `agy --dangerously-skip-permissions` auto-approves tool permission prompts (used when `--write` is set).
- There is no `agy --model`, no `agy --effort`, and no streaming/JSON-RPC interface. Do not try to pass those flags; they will fail.

Safety rules:
- Default to write-capable agy work in `antigravity:antigravity-rescue` unless the user explicitly asks for read-only behavior.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or agy cannot be invoked, return nothing.
