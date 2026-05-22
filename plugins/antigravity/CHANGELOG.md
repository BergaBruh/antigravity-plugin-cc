# Changelog

## 2.0.0

- BREAKING: rewrite as a community port targeting Google's Antigravity CLI (`agy`) instead of the OpenAI Codex CLI.
- BREAKING: slash-command prefix changes from `/codex:*` to `/antigravity:*`.
- BREAKING: subagent renamed from `codex-rescue` to `antigravity-rescue`.
- Replace the `codex app-server` JSON-RPC runtime with a `agy --print` subprocess wrapper. As a result this version no longer offers real-time streaming progress, structured-JSON review output, schema enforcement, a shared cross-session broker, reasoning summaries, or a model-reported file-change manifest.
- The stop-time review gate is now experimental and works by text-parsing a one-line `ALLOW:`/`BLOCK:` verdict from agy.
- Remove the `gpt-5-4-prompting` skill (Codex/GPT-specific prompting guidance does not apply to agy).
- Remove `--model` and `--effort` flags on `/antigravity:rescue` — agy does not surface those through `--print`.
- Rename the storage slug (`codex-companion` → `antigravity-companion`) and the session-id env var (`CODEX_COMPANION_SESSION_ID` → `ANTIGRAVITY_COMPANION_SESSION_ID`).

## 1.0.0

- (legacy) Initial version of the Codex plugin for Claude Code.
