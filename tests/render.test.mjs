import test from "node:test";
import assert from "node:assert/strict";

import {
  renderReviewResult,
  renderSetupReport,
  renderStoredJobResult,
  renderTaskResult
} from "../plugins/antigravity/scripts/lib/render.mjs";

test("renderReviewResult preserves agy stdout under an Antigravity review header", () => {
  const output = renderReviewResult(
    {
      status: 0,
      stdout: "Verdict: needs-attention\n- finding in src/app.js:12",
      stderr: ""
    },
    { reviewLabel: "Adversarial Review", targetLabel: "working tree diff" }
  );

  assert.match(output, /^# Antigravity Adversarial Review/);
  assert.match(output, /Target: working tree diff/);
  assert.match(output, /Verdict: needs-attention/);
  assert.match(output, /finding in src\/app\.js:12/);
});

test("renderReviewResult reports failure plainly when agy returns no stdout", () => {
  const output = renderReviewResult(
    {
      status: 1,
      stdout: "",
      stderr: "boom"
    },
    { reviewLabel: "Review", targetLabel: "branch diff against main" }
  );

  assert.match(output, /agy review failed\./);
  assert.match(output, /stderr:/);
  assert.match(output, /boom/);
});

test("renderTaskResult passes raw output through unchanged", () => {
  const output = renderTaskResult({ rawOutput: "hello world" });
  assert.equal(output, "hello world\n");
});

test("renderTaskResult reports a fallback message when there is no raw output", () => {
  const output = renderTaskResult({ rawOutput: "", failureMessage: "agy returned nothing" });
  assert.equal(output, "agy returned nothing\n");
});

test("renderStoredJobResult points users at `agy --conversation <id>` when a thread is known", () => {
  const output = renderStoredJobResult(
    {
      id: "task-123",
      status: "completed",
      title: "Antigravity Task",
      jobClass: "task",
      threadId: "abc-123-uuid"
    },
    {
      threadId: "abc-123-uuid",
      result: { rawOutput: "Done.\n" }
    }
  );

  assert.match(output, /^Done\./);
  assert.match(output, /Agy conversation ID: abc-123-uuid/);
  assert.match(output, /Resume in agy: agy --conversation abc-123-uuid/);
});

test("renderSetupReport surfaces the agy, auth, and review-gate lines", () => {
  const output = renderSetupReport({
    ready: false,
    node: { detail: "v22.0.0" },
    agy: { detail: "agy version 0.1" },
    auth: { detail: "agy is installed (auth probe skipped)" },
    sessionRuntime: { label: "subprocess" },
    reviewGateEnabled: false,
    actionsTaken: [],
    nextSteps: ["Install the Antigravity CLI."]
  });

  assert.match(output, /# Antigravity Setup/);
  assert.match(output, /- agy: agy version 0\.1/);
  assert.match(output, /- auth: agy is installed/);
  assert.match(output, /- review gate: disabled/);
  assert.match(output, /Install the Antigravity CLI\./);
});
