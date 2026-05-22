# Antigravity plugin for Claude Code

Wrap Google's Antigravity CLI (`agy`) from inside Claude Code for code reviews or to delegate tasks to agy.

This is a community port of the original [OpenAI Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc). It is not produced or endorsed by Google or OpenAI.

## What You Get

- `/antigravity:review` for a basic agy-driven code review
- `/antigravity:adversarial-review` for a steerable challenge review
- `/antigravity:rescue`, `/antigravity:status`, `/antigravity:result`, and `/antigravity:cancel` to delegate work and manage background jobs
- An `antigravity-rescue` subagent that forwards rescue requests through the same companion script

## What This Plugin Does NOT Do (vs. the Codex original)

The Antigravity CLI (`agy`) only exposes a one-shot prompt interface (`agy --print`) and conversation resume. It does not expose anything equivalent to Codex's `app-server` JSON-RPC. Because of that, this port intentionally drops the following capabilities the Codex version had:

- No real-time streaming progress (no lifecycle events, no live phase updates from the model).
- No structured JSON output / schema enforcement on review results — agy returns plain text.
- No shared broker reused across Claude sessions — every task spawns a fresh `agy` subprocess.
- No reasoning-summary panel and no model-reported file-change manifest.
- The stop-time review gate is now **experimental**. It works by asking agy for a one-line `ALLOW:` / `BLOCK:` verdict and parsing that text. Text-only parsing is more fragile and more exposed to prompt injection than the Codex schema-based version. Treat it as best effort.
- No `--model` or `--effort` knobs on `/antigravity:rescue` — agy does not currently surface those flags through `--print`.
- Write-capable rescue runs (`--dangerously-skip-permissions` passed to agy) require explicit opt-in. The rescue subagent defaults to read-only because Claude Code's security model flags `--write` invocations from plugins installed via the local marketplace as untrusted, which can cause the Bash call to be skipped entirely. Use "fix", "apply", "patch", "implement", or explicitly pass `--write` to enable write mode.

If you need any of the above, the Codex plugin is still a more featureful option for OpenAI users.

## Requirements

- **A Google account signed in to Antigravity.** Antigravity is currently region-restricted; the CLI itself works anywhere, but the backend may refuse turns from unsupported regions.
- **The Antigravity CLI (`agy`) installed and on PATH.** See https://antigravity.google for the latest install instructions.
- **Node.js 18.18 or later.**

## Install

Add the marketplace in Claude Code (replace the path with the right git source for your fork or remote):

```bash
/plugin marketplace add <this-repository>
```

Install the plugin:

```bash
/plugin install antigravity@google-antigravity
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/antigravity:setup
```

`/antigravity:setup` will tell you whether `agy` is installed. If `agy` is installed but the auth probe was skipped (the default — it consumes one turn), you can rerun:

```bash
/antigravity:setup --probe-auth
```

to confirm the local CLI is signed in. If it is not, run `agy` once interactively in your own terminal and complete the OAuth flow.

After install, you should see:

- the slash commands listed below
- the `antigravity:antigravity-rescue` subagent in `/agents`

One simple first run is:

```bash
/antigravity:review --background
/antigravity:status
/antigravity:result
```

## Usage

### `/antigravity:review`

Runs a basic code review on your current work. agy reads the supplied diff context and returns plain text.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/antigravity:adversarial-review`](#antigravityadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/antigravity:review
/antigravity:review --base main
/antigravity:review --background
```

This command is read-only on the Claude side and will not perform any changes itself. When run in the background you can use [`/antigravity:status`](#antigravitystatus) to check on the progress and [`/antigravity:cancel`](#antigravitycancel) to cancel the ongoing task.

### `/antigravity:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/antigravity:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/antigravity:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/antigravity:adversarial-review
/antigravity:adversarial-review --base main challenge whether this was the right caching and retry design
/antigravity:adversarial-review --background look for race conditions and question the chosen approach
```

This command does not fix code.

### `/antigravity:rescue`

Hands a task to agy through the `antigravity:antigravity-rescue` subagent.

Use it when you want agy to:

- investigate a bug
- try a fix
- continue a previous agy task

> [!NOTE]
> Depending on the task these runs might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue conversation for this repo.

Examples:

```bash
/antigravity:rescue investigate why the tests started failing
/antigravity:rescue fix the failing test with the smallest safe patch
/antigravity:rescue --resume apply the top fix from the last run
/antigravity:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to agy:

```text
Ask agy to redesign the database connection to be more resilient.
```

**Notes:**

- `agy` does not expose `--model` or `--effort` flags through its `--print` interface, so this plugin does not surface those options. agy picks its own model.
- Follow-up rescue requests can continue the latest agy conversation in the repo. The companion tracks per-job conversation UUIDs and forwards them to `agy --conversation <id>`.
- When the user adds `--write` (the rescue subagent's default), the companion passes `--dangerously-skip-permissions` to agy so it can act on the workspace without an interactive approval prompt. Use `--no-write` style read-only phrasing if you do not want this.

### `/antigravity:status`

Shows running and recent Antigravity jobs for the current repository.

Examples:

```bash
/antigravity:status
/antigravity:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

Note: because there is no streaming protocol, "progress" is limited to the discrete log messages the companion writes (subprocess started, final message captured, etc.).

### `/antigravity:result`

Shows the final stored agy output for a finished job.
When available, it also includes the agy conversation ID so you can reopen that conversation directly with `agy --conversation <id>`.

Examples:

```bash
/antigravity:result
/antigravity:result task-abc123
```

### `/antigravity:cancel`

Cancels an active background Antigravity job. Cancellation works by sending SIGTERM to the tracked subprocess PID — there is no out-of-band "interrupt this turn" RPC.

Examples:

```bash
/antigravity:cancel
/antigravity:cancel task-abc123
```

### `/antigravity:setup`

Checks whether `agy` is installed and (optionally) whether it appears authenticated.

You can also use `/antigravity:setup` to manage the optional review gate.

#### Enabling the review gate

```bash
/antigravity:setup --enable-review-gate
/antigravity:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted agy review based on Claude's response. If the first line of agy's response starts with `BLOCK:`, the stop is blocked so Claude can address the issues first.

> [!WARNING]
> The review gate is **experimental**. It relies on text parsing (no JSON schema is enforced), so prompt-injection risk is higher than the Codex version had. It can also create a long-running Claude/agy loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Antigravity Integration

The plugin spawns the global `agy` binary in your environment for each task. It does not bundle agy. Authentication and config (model selection, OAuth token, plugins) live in `~/.gemini/antigravity-cli/` and follow whatever agy itself does there.

### Moving the work over to agy

Delegated tasks can be resumed directly inside agy by running `agy --conversation <id>` with the conversation ID surfaced by `/antigravity:result` or `/antigravity:status`. `agy --continue` resumes the most recent conversation without needing an ID.

## FAQ

### Do I need a separate Google account for this plugin?

If you are already signed into agy on this machine, that account will work here too. The plugin uses your local `agy` CLI authentication.

### Does the plugin use a separate agy runtime?

No. This plugin shells out to your local agy install on the same machine.

That means:

- it uses the same agy install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Why is this so much less featureful than the Codex original?

Because agy does not yet expose a programmatic streaming protocol, and Google has not (publicly) shipped an `app-server`-equivalent. This port deliberately drops the capabilities that required JSON-RPC and structured outputs rather than fake them on top of plain stdout text. If/when agy adds a richer programmatic interface, that's the natural place to grow these features back.
