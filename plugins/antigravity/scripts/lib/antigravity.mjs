/**
 * Subprocess wrapper for Google's Antigravity CLI (`agy`).
 *
 * The original Codex plugin used `codex app-server`, which exposed a
 * streaming JSON-RPC protocol with structured items, reasoning summaries,
 * file-change manifests, and a shared broker. `agy` exposes none of that:
 * the only programmatic surface is `agy --print` (a one-shot prompt that
 * writes the final assistant message to stdout) plus `--continue` /
 * `--conversation <id>` for resume.
 *
 * Consequence: many capabilities of the old plugin are simply not available
 * here. We model a single "turn" as one `agy --print` subprocess and expose
 * a roughly compatible API (`runAgyTurn`, `runAgyReview`, `interruptAgyTurn`,
 * `findLatestTaskThread`) so the companion script and renderers can stay
 * structurally similar. Fields we cannot populate (turnId, reasoningSummary,
 * fileChanges, commandExecutions) are returned empty.
 *
 * @typedef {((update: string | { message: string, phase: string | null, threadId?: string | null, turnId?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null }) => void)} ProgressReporter
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { binaryAvailable } from "./process.mjs";

const TASK_THREAD_PREFIX = "Antigravity Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current conversation state. Pick the next highest-value step and follow through until the task is resolved.";
const AGY_BINARY = "agy";
const AGY_PRINT_TIMEOUT_DEFAULT = "30m"; // generous; agy's own default is 5m.
const CONVERSATION_DIR_CANDIDATES = [
  path.join(os.homedir(), ".gemini", "antigravity-cli", "conversations"),
  path.join(os.homedir(), ".agy", "conversations")
];

function cleanAgyStderr(stderr) {
  return String(stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !/^\s*$/.test(line))
    .join("\n");
}

function shorten(text, limit = 56) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function buildTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress, options = {}) {
  if (!onProgress) {
    return;
  }
  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

/**
 * Detect the most recently written agy conversation `.pb` file. We cannot
 * read its contents (protobuf, undocumented schema), but the UUID-named
 * file is exactly the conversation ID we'd pass to `--conversation`.
 * Returns `null` if no conversations directory is found.
 */
function snapshotLatestConversationFile() {
  for (const dir of CONVERSATION_DIR_CANDIDATES) {
    if (!fs.existsSync(dir)) {
      continue;
    }
    try {
      const entries = fs.readdirSync(dir).filter((name) => name.endsWith(".pb"));
      if (entries.length === 0) {
        continue;
      }
      const stats = entries
        .map((name) => {
          const filePath = path.join(dir, name);
          try {
            return { filePath, name, mtimeMs: fs.statSync(filePath).mtimeMs };
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      if (stats.length === 0) {
        continue;
      }
      stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return stats[0];
    } catch {
      // ignore directory read failures
    }
  }
  return null;
}

function deriveConversationIdFromFile(file) {
  if (!file) {
    return null;
  }
  const base = path.basename(file.name, ".pb");
  return base && /^[a-z0-9-]+$/i.test(base) ? base : null;
}

function detectConversationIdAfter(beforeFile) {
  const after = snapshotLatestConversationFile();
  if (!after) {
    return null;
  }
  if (beforeFile && after.filePath === beforeFile.filePath && after.mtimeMs === beforeFile.mtimeMs) {
    return null;
  }
  return deriveConversationIdFromFile(after);
}

function spawnAgy(args, { cwd, env, input, timeoutMs, onPid } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(AGY_BINARY, args, {
      cwd,
      env: env ?? process.env,
      detached: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    onPid?.(child.pid ?? null);

    let timer = null;
    if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
      }, timeoutMs);
      timer.unref?.();
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      resolve({ status: -1, signal: null, stdout, stderr, error, timedOut: false });
    });

    child.on("close", (code, signal) => {
      if (timer) {
        clearTimeout(timer);
      }
      resolve({
        status: code ?? (signal ? -1 : 0),
        signal: signal ?? null,
        stdout,
        stderr,
        error: null,
        timedOut
      });
    });

    child.stdin.on("error", (err) => {
      if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") {
        // Child closed stdin early — this is normal (e.g. region-error, timeout, network drop).
        // Ignore silently; the 'close' event will resolve the promise with the appropriate exit code.
        return;
      }
      // Unexpected stdin error — log but do not throw (let exit code handle the failure).
      process.stderr.write(`[antigravity] unexpected stdin error: ${err.message}\n`);
    });

    if (typeof input === "string") {
      try {
        child.stdin.write(input);
        child.stdin.end();
      } catch (err) {
        if (err.code !== "EPIPE" && err.code !== "ERR_STREAM_DESTROYED") {
          process.stderr.write(`[antigravity] unexpected stdin write error: ${err.message}\n`);
        }
      }
    } else {
      try {
        child.stdin.end();
      } catch {
        // ignore
      }
    }
  });
}

function buildAgyArgs(cwd, options = {}) {
  const args = ["--print"];
  if (options.printTimeout) {
    args.push("--print-timeout", String(options.printTimeout));
  } else {
    args.push("--print-timeout", AGY_PRINT_TIMEOUT_DEFAULT);
  }
  if (options.dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }
  if (cwd) {
    args.push("--add-dir", cwd);
  }
  if (options.conversationId) {
    args.push("--conversation", options.conversationId);
  } else if (options.continueConversation) {
    args.push("--continue");
  }
  return args;
}

/**
 * Check if `agy` is on PATH and responds to `--help`.
 */
export function getAgyAvailability(cwd) {
  return binaryAvailable(AGY_BINARY, ["--help"], { cwd });
}

/**
 * Best-effort auth probe. There is no public `agy whoami` or `agy auth status`
 * subcommand. We send the smallest possible prompt and treat exit 0 with any
 * non-empty stdout as "looks authenticated"; everything else is advisory.
 *
 * NOTE: this probe contacts Google's backend, so it consumes a turn. Callers
 * should treat the result as advisory and avoid running it speculatively.
 */
export async function getAgyAuthStatus(cwd, options = {}) {
  const availability = getAgyAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability"
    };
  }
  if (options.skipNetworkProbe) {
    return {
      available: true,
      loggedIn: null,
      detail: "agy is installed (auth probe skipped)",
      source: "availability"
    };
  }
  const result = await spawnAgy(buildAgyArgs(cwd, { printTimeout: "30s" }), {
    cwd,
    input: "respond with exactly the word OK",
    timeoutMs: 45_000
  });
  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  if (result.status === 0 && stdout) {
    return {
      available: true,
      loggedIn: true,
      detail: "agy responded to a one-shot probe",
      source: "print-probe"
    };
  }
  // Heuristic: exit 0 with no stdout often means agy ran but the model
  // refused/errored (e.g. region block, network). We cannot distinguish
  // that from "not authenticated" without parsing internal logs, so we
  // mark loggedIn as null (unknown) instead of false.
  if (result.status === 0) {
    return {
      available: true,
      loggedIn: null,
      detail:
        "agy ran but returned empty output — possibly region-restricted, see ~/.gemini/antigravity-cli/cli.log",
      source: "print-probe"
    };
  }
  const detail =
    stderr || stdout || (result.error ? result.error.message : `exit ${result.status}`);
  return {
    available: true,
    loggedIn: false,
    detail: detail || "agy did not return output for the auth probe",
    source: "print-probe"
  };
}

/**
 * `agy` does not have a shared broker. Every turn is a fresh subprocess.
 */
export function getSessionRuntimeStatus() {
  return {
    mode: "direct",
    label: "subprocess",
    detail:
      "Each task spawns a fresh agy subprocess. No shared runtime is reused across Claude sessions.",
    endpoint: null
  };
}

/**
 * Spawn one `agy --print` subprocess and capture stdout/stderr.
 *
 * Fields preserved from the old runAppServerTurn shape:
 *  - status: 0 on success, non-zero on failure
 *  - threadId: best-effort conversation UUID detected after the turn
 *  - turnId: always null (no equivalent)
 *  - finalMessage: stdout from agy
 *  - reasoningSummary: always [] (no equivalent)
 *  - fileChanges: always [] (no equivalent)
 *  - commandExecutions: always [] (no equivalent)
 *  - touchedFiles: always [] (we do not know what agy edited)
 *  - stderr: cleaned stderr
 *  - error: { message } when agy reports failure
 */
export async function runAgyTurn(cwd, options = {}) {
  const availability = getAgyAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      "Antigravity CLI (`agy`) is not installed or is not on PATH. Install agy and sign in, then rerun `/antigravity:setup`."
    );
  }

  const continueConversation = Boolean(options.resumeLast && !options.resumeThreadId);
  const conversationId = options.resumeThreadId ?? null;
  const prompt =
    String(options.prompt ?? "").trim() || String(options.defaultPrompt ?? "").trim();
  if (!prompt) {
    throw new Error("A prompt is required for this agy run.");
  }

  if (conversationId) {
    emitProgress(options.onProgress, `Resuming conversation ${conversationId}.`, "starting");
  } else if (continueConversation) {
    emitProgress(options.onProgress, "Continuing the most recent agy conversation.", "starting");
  } else {
    emitProgress(options.onProgress, "Starting a new agy task.", "starting");
  }

  const beforeFile = snapshotLatestConversationFile();
  const args = buildAgyArgs(cwd, {
    printTimeout: options.printTimeout ?? AGY_PRINT_TIMEOUT_DEFAULT,
    dangerouslySkipPermissions: Boolean(options.dangerouslySkipPermissions),
    conversationId,
    continueConversation
  });

  emitProgress(options.onProgress, `Invoking ${AGY_BINARY} ${args.join(" ")}.`, "running");

  const result = await spawnAgy(args, {
    cwd,
    input: prompt,
    timeoutMs: options.timeoutMs ?? null,
    onPid: options.onPid
  });

  const stdout = result.stdout ?? "";
  const stderr = cleanAgyStderr(result.stderr ?? "");
  const detectedThreadId = conversationId ?? detectConversationIdAfter(beforeFile);

  const error = result.error ?? null;
  const turnFailed = result.timedOut || result.status !== 0 || Boolean(error);

  if (turnFailed) {
    const message = result.timedOut
      ? "agy --print timed out before producing a response."
      : error?.message
        ? `agy exited with error: ${error.message}`
        : stderr || `agy exited with non-zero status ${result.status}.`;
    emitLogEvent(options.onProgress, {
      message: "agy run failed.",
      phase: "failed",
      stderrMessage: message,
      logTitle: "agy stderr",
      logBody: stderr || message
    });
  } else if (stdout.trim()) {
    emitLogEvent(options.onProgress, {
      message: `Final message captured (${stdout.trim().length} chars).`,
      phase: "finalizing",
      logTitle: "agy final message",
      logBody: stdout.trim()
    });
  } else {
    emitProgress(
      options.onProgress,
      "agy exited successfully but produced no stdout.",
      "finalizing"
    );
  }

  return {
    status: turnFailed ? (result.status === 0 ? 1 : result.status) : 0,
    threadId: detectedThreadId,
    turnId: null,
    finalMessage: stdout,
    reasoningSummary: [],
    turn: turnFailed
      ? { id: null, status: result.timedOut ? "timed_out" : "failed" }
      : { id: null, status: "completed" },
    error: turnFailed
      ? {
          message: result.timedOut
            ? "agy --print timed out"
            : error?.message ?? stderr ?? `exit ${result.status}`
        }
      : null,
    stderr,
    fileChanges: [],
    touchedFiles: [],
    commandExecutions: [],
    timedOut: Boolean(result.timedOut)
  };
}

/**
 * Run a review through agy. The companion script assembles the prompt
 * from the existing `prompts/adversarial-review.md` template plus the
 * git diff context, and forwards it here.
 */
export async function runAgyReview(cwd, options = {}) {
  const result = await runAgyTurn(cwd, {
    prompt: options.prompt,
    printTimeout: options.printTimeout,
    onProgress: options.onProgress,
    onPid: options.onPid,
    dangerouslySkipPermissions: options.dangerouslySkipPermissions
  });

  return {
    status: result.status,
    threadId: result.threadId,
    sourceThreadId: result.threadId,
    turnId: null,
    reviewText: result.finalMessage,
    reasoningSummary: [],
    turn: result.turn,
    error: result.error,
    stderr: result.stderr
  };
}

/**
 * `agy` does not expose a conversation-list RPC, so we can only point at
 * "the most recently modified conversation file in agy's storage dir",
 * which is also what `agy --continue` would resume.
 */
export async function findLatestTaskThread(_cwd) {
  const latest = snapshotLatestConversationFile();
  if (!latest) {
    return null;
  }
  const id = deriveConversationIdFromFile(latest);
  if (!id) {
    return null;
  }
  return { id, name: null };
}

/**
 * Kept for API parity with the old broker. agy turns are killed by
 * terminating the tracked subprocess PID — there is no out-of-band
 * "interrupt this turn" RPC for an agy subprocess.
 */
export async function interruptAgyTurn(_cwd, { threadId, turnId } = {}) {
  if (!threadId && !turnId) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail:
        "agy turns are killed by terminating the tracked subprocess PID; no extra RPC needed."
    };
  }
  return {
    attempted: false,
    interrupted: false,
    transport: "subprocess",
    detail:
      "agy does not expose an RPC to interrupt a turn out-of-band; kill the subprocess PID instead."
  };
}

export function buildPersistentTaskThreadName(prompt) {
  return buildTaskThreadName(prompt);
}

export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX };
