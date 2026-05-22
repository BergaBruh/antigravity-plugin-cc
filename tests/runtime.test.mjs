import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";

import { writeFakeAgy } from "./fake-agy-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";

async function withFakeAgy(fn) {
  const fake = writeFakeAgy();
  const conversationsDir = path.join(fake.dir, "conversations");
  fs.mkdirSync(conversationsDir, { recursive: true });
  const previousPath = process.env.PATH;
  const previousConversationsDir = process.env.FAKE_AGY_CONVERSATIONS_DIR;
  process.env.PATH = `${fake.dir}${path.delimiter}${previousPath}`;
  process.env.FAKE_AGY_CONVERSATIONS_DIR = conversationsDir;
  // Force the antigravity module to look for conversation files in our
  // fake directory by symlinking the canonical location to it.
  const home = process.env.HOME;
  const stagedHome = fs.mkdtempSync(path.join(os.tmpdir(), "fake-home-"));
  fs.mkdirSync(path.join(stagedHome, ".gemini", "antigravity-cli"), { recursive: true });
  fs.symlinkSync(conversationsDir, path.join(stagedHome, ".gemini", "antigravity-cli", "conversations"));
  process.env.HOME = stagedHome;
  try {
    // Import fresh so it picks up the (re)assigned HOME for conversation
    // path resolution. Bust the loader cache via a query param.
    const stamp = Date.now() + Math.random();
    const mod = await import(
      `../plugins/antigravity/scripts/lib/antigravity.mjs?stamp=${stamp}`
    );
    await fn({ fake, conversationsDir, mod });
  } finally {
    process.env.PATH = previousPath;
    if (previousConversationsDir == null) {
      delete process.env.FAKE_AGY_CONVERSATIONS_DIR;
    } else {
      process.env.FAKE_AGY_CONVERSATIONS_DIR = previousConversationsDir;
    }
    if (home == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = home;
    }
  }
}

test("getAgyAvailability returns true when a fake agy is on PATH", async () => {
  await withFakeAgy(async ({ mod }) => {
    const workspace = makeTempDir();
    const availability = mod.getAgyAvailability(workspace);
    assert.equal(availability.available, true);
    assert.match(availability.detail, /Usage of fake agy/);
  });
});

test("runAgyTurn echoes its prompt back and detects a conversation id", async () => {
  await withFakeAgy(async ({ mod, conversationsDir }) => {
    const workspace = makeTempDir();
    const result = await mod.runAgyTurn(workspace, {
      prompt: "hello from the test"
    });
    assert.equal(result.status, 0);
    assert.equal(result.finalMessage.trim(), "hello from the test");
    assert.equal(result.turnId, null);
    assert.deepEqual(result.reasoningSummary, []);
    assert.deepEqual(result.fileChanges, []);
    assert.deepEqual(result.touchedFiles, []);
    // Fake agy creates a .pb file in conversationsDir; the turn should
    // surface a thread id matching that filename.
    const created = fs.readdirSync(conversationsDir).filter((name) => name.endsWith(".pb"));
    assert.equal(created.length, 1);
    assert.equal(`${result.threadId}.pb`, created[0]);
  });
});

test("runAgyTurn returns failure metadata when agy exits non-zero", async () => {
  process.env.FAKE_AGY_EXIT = "7";
  try {
    await withFakeAgy(async ({ mod }) => {
      const workspace = makeTempDir();
      const result = await mod.runAgyTurn(workspace, {
        prompt: "anything"
      });
      assert.notEqual(result.status, 0);
      assert.ok(result.error);
      assert.equal(result.turn.status, "failed");
    });
  } finally {
    delete process.env.FAKE_AGY_EXIT;
  }
});

test("runAgyReview shapes the result like runAgyTurn but exposes reviewText", async () => {
  process.env.FAKE_AGY_REPLY = "Verdict: approve\n- no findings\n";
  try {
    await withFakeAgy(async ({ mod }) => {
      const workspace = makeTempDir();
      const result = await mod.runAgyReview(workspace, {
        prompt: "review me"
      });
      assert.equal(result.status, 0);
      assert.match(result.reviewText, /Verdict: approve/);
      assert.equal(result.turnId, null);
      assert.deepEqual(result.reasoningSummary, []);
    });
  } finally {
    delete process.env.FAKE_AGY_REPLY;
  }
});

test("findLatestTaskThread returns the most recent .pb conversation in agy storage", async () => {
  await withFakeAgy(async ({ mod, conversationsDir }) => {
    fs.writeFileSync(path.join(conversationsDir, "old-thread.pb"), "");
    // The mtime granularity is OS-dependent; force the newer one to win.
    const now = Date.now() / 1000;
    fs.utimesSync(path.join(conversationsDir, "old-thread.pb"), now - 10, now - 10);
    fs.writeFileSync(path.join(conversationsDir, "newer-thread.pb"), "");
    fs.utimesSync(path.join(conversationsDir, "newer-thread.pb"), now, now);

    const thread = await mod.findLatestTaskThread(makeTempDir());
    assert.equal(thread?.id, "newer-thread");
  });
});

test("getSessionRuntimeStatus reports the direct/subprocess mode (no broker)", async () => {
  const mod = await import("../plugins/antigravity/scripts/lib/antigravity.mjs");
  const status = mod.getSessionRuntimeStatus();
  assert.equal(status.mode, "direct");
  assert.equal(status.label, "subprocess");
  assert.equal(status.endpoint, null);
});
