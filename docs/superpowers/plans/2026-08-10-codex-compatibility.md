# Codex Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Antigravity plugin installable and operational from OpenAI Codex as `bergabruh@antigravity-plugin-cc` without removing its Claude Code bundle.

**Architecture:** Keep the existing CLI companion as the single runtime implementation. Add a Codex plugin root and a small stdio MCP adapter that validates tool arguments, invokes the companion with an explicit workspace, and returns MCP text content. The original Claude commands and hook remain in the same package as compatibility assets.

**Tech Stack:** Node.js 18 ESM, JSON manifests, MCP stdio JSON-RPC, node:test.

## Global Constraints

- Plugin identifier is `bergabruh`; Codex marketplace identifier is `antigravity-plugin-cc`.
- Do not add third-party runtime dependencies.
- Every MCP subprocess receives an explicit workspace; no shell interpolation is used.
- Claude command and hook assets remain available.

---

### Task 1: Codex package and marketplace

**Files:**
- Move: `plugins/antigravity` to `plugins/bergabruh`
- Create: `plugins/bergabruh/.codex-plugin/plugin.json`
- Create: `plugins/bergabruh/.mcp.json`
- Create: `.agents/plugins/marketplace.json`
- Test: `tests/codex-plugin.test.mjs`

- [ ] Write the failing packaging test, run it, then add the manifest and marketplace.
- [ ] Validate the bundle with `validate_plugin.py plugins/bergabruh`.

### Task 2: Codex MCP bridge

**Files:**
- Create: `plugins/bergabruh/scripts/antigravity-mcp.mjs`
- Test: `tests/codex-plugin.test.mjs`

- [ ] Write failing MCP initialize, tools/list, and status-call tests.
- [ ] Implement JSON-lines MCP dispatch for the existing companion commands.
- [ ] Re-run the focused test.

### Task 3: Rebrand and regression coverage

**Files:**
- Modify: `.claude-plugin/marketplace.json`, `plugins/bergabruh/.claude-plugin/plugin.json`, `README.md`, `scripts/bump-version.mjs`
- Modify: `tests/bump-version.test.mjs`, `tests/commands.test.mjs`

- [ ] Update names and installation instructions without removing Claude use.
- [ ] Update version checks for both manifests.
- [ ] Run `npm test` and `npm run check-version`.
