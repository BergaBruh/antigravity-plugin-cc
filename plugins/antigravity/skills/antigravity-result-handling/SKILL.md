---
name: antigravity-result-handling
description: Internal guidance for presenting agy helper output back to the user
user-invocable: false
---

# Antigravity Result Handling

When the helper returns agy output:
- agy returns plain text, not a structured JSON shape. Preserve its prose as-is.
- For review output, keep findings in the order agy reported them. Do not reorder by severity unless agy already did so explicitly.
- Use the file paths and line numbers exactly as agy reports them.
- If agy made edits, say so explicitly. The helper cannot enumerate touched files (the upstream CLI does not surface that information), so do not invent a "touched files" list when one was not provided.
- If agy explicitly says no issues were found, say so explicitly and keep any residual-risk note brief.
- For `antigravity:antigravity-rescue`, do not turn a failed or incomplete agy run into a Claude-side implementation attempt. Report the failure and stop.
- For `antigravity:antigravity-rescue`, if agy was never successfully invoked, do not generate a substitute answer at all.
- CRITICAL: After presenting review findings, STOP. Do not make any code changes. Do not fix any issues. You MUST explicitly ask the user which issues, if any, they want fixed before touching a single file. Auto-applying fixes from a review is strictly forbidden, even if the fix is obvious.
- If the helper reports malformed output or a failed agy run, include the most actionable stderr lines and stop there instead of guessing.
- If the helper reports that setup or authentication is required, direct the user to `/antigravity:setup` and do not improvise alternate auth flows.
