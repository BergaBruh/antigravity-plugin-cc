---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Antigravity rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [what agy should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `antigravity:antigravity-rescue` subagent via the `Agent` tool (`subagent_type: "antigravity:antigravity-rescue"`), forwarding the raw user request as the prompt.
`antigravity:antigravity-rescue` is a subagent, not a skill — do not call `Skill(antigravity:antigravity-rescue)` or `Skill(antigravity:rescue)`. The command runs inline so the `Agent` tool stays in scope.
The final user-visible response must be agy's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `antigravity:antigravity-rescue` subagent in the background.
- If the request includes `--wait`, run the `antigravity:antigravity-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting agy, check for a resumable rescue conversation from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current agy conversation or start a new one.
- The two choices must be:
  - `Continue current agy conversation`
  - `Start a new agy conversation`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current agy conversation (Recommended)` first.
- Otherwise put `Start a new agy conversation (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new conversation, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-companion.mjs" task ...` and return that command's stdout as-is.
- Return the agy companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/antigravity:status`, fetch `/antigravity:result`, call `/antigravity:cancel`, summarize output, or do follow-up work of its own.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that agy is missing or unauthenticated, stop and tell the user to run `/antigravity:setup`.
- If the user did not supply a request, ask what agy should investigate or fix.
- The subagent defaults to a read-only run. It adds `--write` only when the user's request explicitly contains words like "fix", "apply", "patch", "edit", "change the code", or "implement", or the user passed `--write` explicitly. Default read-only because Claude Code's security warnings on untrusted-marketplace plugins specifically flag `--write` invocations and may cause the subagent to skip the Bash call entirely.

Notes:

- `agy` does not currently surface a public `--model` or `--effort` flag through its `--print` interface, so this command does not accept model or reasoning-effort overrides. If the upstream CLI starts exposing those flags they will be added back.
