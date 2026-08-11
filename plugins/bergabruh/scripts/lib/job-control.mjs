import fs from "node:fs";
import path from "node:path";

import { CONVERSATION_DIR_CANDIDATES, getSessionRuntimeStatus } from "./antigravity.mjs";
import { getConfig, listJobs, readJobFile, resolveJobFile, upsertJob } from "./state.mjs";
import { SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

/**
 * Returns true if the given PID is still alive, false if it is dead (ESRCH).
 * Throws for unexpected errors (e.g. EPERM).
 */
function checkIfPidAlive(pid, options = {}) {
  const killImpl = options.killImpl ?? process.kill.bind(process);
  try {
    killImpl(pid, 0);
    return true;
  } catch (err) {
    if (err?.code === "ESRCH") {
      return false;
    }
    // EPERM means the process exists but we cannot signal it — treat as alive.
    if (err?.code === "EPERM") {
      return true;
    }
    throw err;
  }
}

/**
 * Scan conversation directories for .pb files whose mtime falls within the
 * window [startedAtMs, nowMs]. Returns an array of UUID strings (filenames
 * without the .pb extension).
 */
function findPbCandidates(startedAtMs, nowMs, conversationDirs) {
  const candidates = [];
  for (const dir of conversationDirs) {
    if (!fs.existsSync(dir)) {
      continue;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir).filter((name) => name.endsWith(".pb"));
    } catch {
      continue;
    }
    for (const name of entries) {
      const filePath = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (stat.mtimeMs >= startedAtMs && stat.mtimeMs <= nowMs) {
        const uuid = path.basename(name, ".pb");
        candidates.push(uuid);
      }
    }
  }
  return candidates;
}

/**
 * Given a running job whose wrapper process has died, attempt to recover the
 * agy conversation ID from nearby .pb files and return a patched job object
 * with status "orphaned" and phase "wrapper-died".
 *
 * @param {object} job - The job record to check
 * @param {string[]} conversationDirs - List of directories to scan
 * @param {object} options - Injectable overrides (killImpl, nowMs)
 * @returns {object|null} - Patched job object if orphaned, null if still alive
 */
export function detectOrphanedJob(job, conversationDirs, options = {}) {
  if (job.status !== "running" || !Number.isFinite(job.pid)) {
    return null;
  }

  let alive;
  try {
    alive = checkIfPidAlive(job.pid, options);
  } catch {
    // Cannot determine — leave the job alone.
    return null;
  }

  if (alive) {
    return null;
  }

  const nowMs = options.nowMs ?? Date.now();
  const startedAtMs = job.startedAt ? Date.parse(job.startedAt) : (job.createdAt ? Date.parse(job.createdAt) : 0);
  const validStartedAtMs = Number.isFinite(startedAtMs) ? startedAtMs : 0;

  const candidates = findPbCandidates(validStartedAtMs, nowMs, conversationDirs);

  const patch = {
    ...job,
    status: "orphaned",
    phase: "wrapper-died",
    completedAt: new Date(nowMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString()
  };

  if (candidates.length === 1) {
    patch.threadId = candidates[0];
    patch.recoveredThreadId = true;
  } else if (candidates.length > 1) {
    patch.threadId = job.threadId ?? null;
    patch.possibleThreadIds = candidates;
  } else {
    patch.threadId = job.threadId ?? null;
    patch.recoveryAttempted = true;
  }

  return patch;
}

/**
 * Iterate over all running jobs, apply PID health-check, persist any
 * orphaned jobs back to state, and return the updated jobs list.
 */
function applyOrphanDetection(workspaceRoot, jobs, conversationDirs, options = {}) {
  let mutated = false;
  const patched = jobs.map((job) => {
    const orphaned = detectOrphanedJob(job, conversationDirs, options);
    if (!orphaned) {
      return job;
    }
    mutated = true;
    upsertJob(workspaceRoot, orphaned);
    return orphaned;
  });
  return mutated ? patched : jobs;
}

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function getCurrentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    return "rescue";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "rescue";
  }
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return ["Final output", "agy final message", "agy stderr"].includes(line);
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function inferLegacyJobPhase(job, progressPreview = []) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "done";
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index].toLowerCase();
    if (
      line.startsWith("starting a new agy") ||
      line.startsWith("continuing the most recent agy") ||
      line.startsWith("resuming conversation") ||
      line.startsWith("invoking agy")
    ) {
      return "starting";
    }
    if (line.startsWith("final message captured")) {
      return "finalizing";
    }
    if (line.startsWith("agy run failed") || line.startsWith("agy exited")) {
      return "failed";
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running";
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const isTerminal = job.status === "completed" || job.status === "failed" || job.status === "cancelled" || job.status === "orphaned";
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      job.status === "queued" || job.status === "running" || job.status === "failed" || job.status === "orphaned"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration: isTerminal
      ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
      : null
  };

  return {
    ...enriched,
    phase: enriched.phase ?? inferLegacyJobPhase(enriched, enriched.progressPreview)
  };
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  throw new Error(`No job found for "${reference}". Run /antigravity:status to list known jobs.`);
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const conversationDirs = options.conversationDirs ?? CONVERSATION_DIR_CANDIDATES;
  const rawJobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), options));
  const jobs = applyOrphanDetection(workspaceRoot, rawJobs, conversationDirs, options);
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => enrichJob(job, { maxProgressLines }));

  const orphaned = jobs
    .filter((job) => job.status === "orphaned")
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw = jobs.find((job) => job.status !== "queued" && job.status !== "running" && job.status !== "orphaned") ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => job.status !== "queued" && job.status !== "running" && job.status !== "orphaned" && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(options.env, workspaceRoot),
    running,
    orphaned,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate)
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const conversationDirs = options.conversationDirs ?? CONVERSATION_DIR_CANDIDATES;
  const rawJobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const jobs = applyOrphanDetection(workspaceRoot, rawJobs, conversationDirs, options);
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /antigravity:status to inspect known jobs.`);
  }

  return {
    workspaceRoot,
    job: enrichJob(selected, { maxProgressLines: options.maxProgressLines })
  };
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(reference ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot)));
  const selected = matchJobReference(
    jobs,
    reference,
    (job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled"
  );

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const active = matchJobReference(jobs, reference, (job) => job.status === "queued" || job.status === "running");
  if (active) {
    throw new Error(`Job ${active.id} is still ${active.status}. Check /antigravity:status and try again once it finishes.`);
  }

  if (reference) {
    throw new Error(`No finished job found for "${reference}". Run /antigravity:status to inspect active jobs.`);
  }

  throw new Error("No finished Antigravity jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");

  if (reference) {
    const selected = matchJobReference(activeJobs, reference);
    if (!selected) {
      throw new Error(`No active job found for "${reference}".`);
    }
    return { workspaceRoot, job: selected };
  }

  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);

  if (sessionScopedActiveJobs.length === 1) {
    return { workspaceRoot, job: sessionScopedActiveJobs[0] };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new Error("Multiple Antigravity jobs are active. Pass a job id to /antigravity:cancel.");
  }

  if (getCurrentSessionId(options)) {
    throw new Error("No active Antigravity jobs to cancel for this session.");
  }

  throw new Error("No active Antigravity jobs to cancel.");
}
