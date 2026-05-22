import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "antigravity");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return agy's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(
    source,
    /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/antigravity-companion\.mjs" review "\$ARGUMENTS"`/
  );
  assert.match(source, /description:\s*"Antigravity review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /does not support extra focus text/i);
});

test("adversarial review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return agy's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /adversarial-review "\$ARGUMENTS"/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(
    source,
    /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/antigravity-companion\.mjs" adversarial-review "\$ARGUMENTS"`/
  );
  assert.match(source, /description:\s*"Antigravity adversarial review"/);
  assert.match(source, /uses the same review target selection as `\/antigravity:review`/i);
  assert.match(source, /can still take extra focus text after the flags/i);
});

test("expected command files exist for the antigravity plugin", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md"
  ]);
});

test("rescue command routes through the antigravity-rescue subagent without re-entering itself", () => {
  const rescue = read("commands/rescue.md");
  const agent = read("agents/antigravity-rescue.md");
  const runtimeSkill = read("skills/antigravity-cli-runtime/SKILL.md");

  assert.match(rescue, /The final user-visible response must be agy's output verbatim/i);
  assert.match(rescue, /allowed-tools:\s*Bash\(node:\*\),\s*AskUserQuestion,\s*Agent/);
  assert.match(rescue, /subagent_type: "antigravity:antigravity-rescue"/);
  assert.doesNotMatch(rescue, /^context:\s*fork\b/m);
  assert.match(rescue, /--background\|--wait/);
  assert.match(rescue, /--resume\|--fresh/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /AskUserQuestion/);
  assert.match(rescue, /Continue current agy conversation/);
  assert.match(rescue, /Start a new agy conversation/);
  assert.match(rescue, /run the `antigravity:antigravity-rescue` subagent in the background/i);
  assert.match(rescue, /default to foreground/i);
  assert.match(rescue, /thin forwarder only/i);
  assert.match(rescue, /Return the agy companion stdout verbatim to the user/i);

  // The agent should be a single-call forwarder that does not advertise
  // the dropped --model / --effort flags.
  assert.match(agent, /^name: antigravity-rescue$/m);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /Use exactly one `Bash` call/i);
  assert.match(agent, /Do not inspect the repository, read files, grep, monitor progress/i);
  assert.match(agent, /Return the stdout of the `antigravity-companion` command exactly as-is/i);
  assert.doesNotMatch(agent, /gpt-5-4-prompting/);
  // The agent file may mention --effort / --model only in a "this flag is
  // not supported" note. It must not invite Claude to forward those flags.
  assert.doesNotMatch(agent, /If they ask for `spark`/i);
  assert.doesNotMatch(agent, /pass it through with `--model`/i);

  // Runtime skill should describe the agy --print contract.
  assert.match(runtimeSkill, /antigravity-companion\.mjs" task "<raw arguments>"/);
  assert.match(runtimeSkill, /Use `task` for every rescue request/i);
  assert.match(runtimeSkill, /agy --print/);
  assert.match(runtimeSkill, /agy --continue/);
  assert.match(runtimeSkill, /There is no `agy --model`/);
});

test("result and cancel commands are exposed as deterministic runtime entrypoints", () => {
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");
  const resultHandling = read("skills/antigravity-result-handling/SKILL.md");

  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /antigravity-companion\.mjs" result "\$ARGUMENTS"/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /antigravity-companion\.mjs" cancel "\$ARGUMENTS"/);
  assert.match(
    resultHandling,
    /do not turn a failed or incomplete agy run into a Claude-side implementation attempt/i
  );
  assert.match(resultHandling, /if agy was never successfully invoked, do not generate a substitute answer/i);
});

test("hooks expose only the experimental Stop gate", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /experimental/i);
  assert.match(source, /stop-review-gate-hook\.mjs/);
  // The codex broker SessionStart/SessionEnd hooks should be gone.
  assert.doesNotMatch(source, /SessionStart/);
  assert.doesNotMatch(source, /SessionEnd/);
  assert.doesNotMatch(source, /session-lifecycle-hook/);
});

test("setup command points users at agy install / login (no npm offer)", () => {
  const setup = read("commands/setup.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(setup, /antigravity-companion\.mjs" setup --json \$ARGUMENTS/);
  assert.match(setup, /antigravity\.google/);
  assert.match(setup, /agy install/);
  assert.doesNotMatch(setup, /npm install -g/);
  assert.match(readme, /`agy` is installed/);
  assert.match(readme, /\/antigravity:setup --enable-review-gate/);
  assert.match(readme, /\/antigravity:setup --disable-review-gate/);
});

test("README documents the rewrite's scope reductions", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.match(readme, /What This Plugin Does NOT Do/i);
  assert.match(readme, /No real-time streaming progress/i);
  assert.match(readme, /No structured JSON output/i);
  assert.match(readme, /experimental/i);
});
