import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  upsertJob
} from "../plugins/bergabruh/scripts/lib/state.mjs";
import { detectOrphanedJob } from "../plugins/bergabruh/scripts/lib/job-control.mjs";

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  const previousCodexPluginDataDir = process.env.PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.PLUGIN_DATA;
  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(os.tmpdir()), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    // The fallback storage slug should be antigravity-flavoured.
    assert.match(stateDir, /antigravity-companion/);
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
    if (previousCodexPluginDataDir == null) {
      delete process.env.PLUGIN_DATA;
    } else {
      process.env.PLUGIN_DATA = previousCodexPluginDataDir;
    }
  }
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  const previousCodexPluginDataDir = process.env.PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  delete process.env.PLUGIN_DATA;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
    if (previousCodexPluginDataDir == null) delete process.env.PLUGIN_DATA;
    else process.env.PLUGIN_DATA = previousCodexPluginDataDir;
  }
});

test("resolveStateDir uses Codex PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.PLUGIN_DATA;
  const previousClaudePluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.PLUGIN_DATA = pluginDataDir;
  delete process.env.CLAUDE_PLUGIN_DATA;

  try {
    const stateDir = resolveStateDir(workspace);
    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
  } finally {
    if (previousPluginDataDir == null) delete process.env.PLUGIN_DATA;
    else process.env.PLUGIN_DATA = previousPluginDataDir;
    if (previousClaudePluginDataDir == null) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousClaudePluginDataDir;
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(resolveJobFile(workspace, "job-0"));

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

// ──────────────────────────────────────────────────────────────────────────────
// PID health-check: live PID → job must remain running
// ──────────────────────────────────────────────────────────────────────────────
test("detectOrphanedJob returns null when the wrapper PID is still alive", () => {
  const job = {
    id: "job-live-pid",
    status: "running",
    pid: process.pid,
    startedAt: new Date(Date.now() - 5000).toISOString()
  };

  // Our own PID is guaranteed alive.
  const result = detectOrphanedJob(job, []);
  assert.equal(result, null);
});

// ──────────────────────────────────────────────────────────────────────────────
// PID health-check: dead PID → job becomes orphaned
// ──────────────────────────────────────────────────────────────────────────────
test("detectOrphanedJob marks job orphaned when the wrapper PID is dead", () => {
  // Spawn a short-lived child and wait for it to exit.
  const child = spawnSync("true", [], { encoding: "utf8" });
  // spawnSync already waited; the process is gone. Re-use its (now invalid) pid
  // via a synthetic dead-pid number: 999999 is almost always free on Linux.
  const deadPid = 999999;

  const job = {
    id: "job-dead-pid",
    status: "running",
    pid: deadPid,
    startedAt: new Date(Date.now() - 5000).toISOString()
  };

  const result = detectOrphanedJob(job, []);
  assert.ok(result, "expected a patched job object, not null");
  assert.equal(result.status, "orphaned");
  assert.equal(result.phase, "wrapper-died");
  assert.ok(result.completedAt, "completedAt should be set");
});

// ──────────────────────────────────────────────────────────────────────────────
// threadId recovery: exactly one .pb candidate → threadId is recovered
// ──────────────────────────────────────────────────────────────────────────────
test("detectOrphanedJob recovers threadId from a single matching .pb file", () => {
  const conversationsDir = makeTempDir("antigravity-test-convs-");
  const startedAt = new Date(Date.now() - 10000).toISOString();
  const nowMs = Date.now();

  // Write a .pb file with an mtime inside the window.
  const uuid = "aaaabbbb-cccc-dddd-eeee-111122223333";
  const pbFile = path.join(conversationsDir, `${uuid}.pb`);
  fs.writeFileSync(pbFile, "");
  // Explicitly set mtime to 5 seconds ago (within the startedAt → now window).
  const mtimeSec = (Date.now() - 5000) / 1000;
  fs.utimesSync(pbFile, mtimeSec, mtimeSec);

  const job = {
    id: "job-single-pb",
    status: "running",
    pid: 999999,
    startedAt
  };

  const result = detectOrphanedJob(job, [conversationsDir], { nowMs });

  assert.ok(result, "expected a patched job object");
  assert.equal(result.status, "orphaned");
  assert.equal(result.threadId, uuid);
  assert.equal(result.recoveredThreadId, true);
  assert.equal(result.possibleThreadIds, undefined);

  fs.rmSync(conversationsDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────────────
// threadId recovery: multiple .pb candidates → possibleThreadIds, threadId null
// ──────────────────────────────────────────────────────────────────────────────
test("detectOrphanedJob sets possibleThreadIds when multiple .pb files match", () => {
  const conversationsDir = makeTempDir("antigravity-test-convs2-");
  const startedAt = new Date(Date.now() - 10000).toISOString();
  const nowMs = Date.now();

  const ids = ["id-one", "id-two"];
  for (const id of ids) {
    const pbFile = path.join(conversationsDir, `${id}.pb`);
    fs.writeFileSync(pbFile, "");
    const mtimeSec = (Date.now() - 5000) / 1000;
    fs.utimesSync(pbFile, mtimeSec, mtimeSec);
  }

  const job = {
    id: "job-multi-pb",
    status: "running",
    pid: 999999,
    startedAt
  };

  const result = detectOrphanedJob(job, [conversationsDir], { nowMs });

  assert.ok(result, "expected a patched job object");
  assert.equal(result.status, "orphaned");
  assert.equal(result.threadId, null);
  assert.ok(Array.isArray(result.possibleThreadIds), "possibleThreadIds should be an array");
  assert.equal(result.possibleThreadIds.length, 2);
  assert.deepEqual(result.possibleThreadIds.sort(), ids.sort());

  fs.rmSync(conversationsDir, { recursive: true, force: true });
});
