---
description: Check whether the local Antigravity CLI (`agy`) is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate] [--probe-auth]'
allowed-tools: Bash(node:*), Bash(agy:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-companion.mjs" setup --json $ARGUMENTS
```

Output rules:
- Present the final setup output to the user.
- If `agy` is not installed, point the user at the upstream install instructions at https://antigravity.google. There is no official `npm` package to offer to install, so do not offer that.
- If `agy` is installed but the auth probe was skipped, mention that the user can rerun `/antigravity:setup --probe-auth` to verify sign-in (this consumes one turn against Google's backend).
- If the auth probe reports the user is not signed in, instruct them to run `agy` once interactively in their own terminal and complete the OAuth flow.
- If shell PATH configuration is missing after install, mention that `agy install` can configure shell paths.
