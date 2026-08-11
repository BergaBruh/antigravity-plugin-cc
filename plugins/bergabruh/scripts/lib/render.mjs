// Renderers for /antigravity:* output. agy does not emit structured JSON,
// reasoning summaries, or file-change manifests, so the renderers here are
// intentionally simpler than the Codex originals.

function formatJobLine(job) {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.title) {
    parts.push(job.title);
  }
  return parts.join(" | ");
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function formatAgyResumeCommand(job) {
  if (!job?.threadId) {
    return null;
  }
  return `agy --conversation ${job.threadId}`;
}

function appendActiveJobsTable(lines, jobs) {
  lines.push("Active jobs:");
  lines.push("| Job | Kind | Status | Phase | Elapsed | Agy Conversation ID | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`/antigravity:status ${job.id}`];
    if (job.status === "queued" || job.status === "running") {
      actions.push(`/antigravity:cancel ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.threadId ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`
    );
  }
}

function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`);
  }
  if (job.phase) {
    lines.push(`  Phase: ${job.phase}`);
  }
  if (options.showElapsed && job.elapsed) {
    lines.push(`  Elapsed: ${job.elapsed}`);
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`);
  }
  if (job.status === "orphaned") {
    lines.push("  ⚠ wrapper died — partial result may be available");
    if (job.threadId) {
      lines.push(`  Agy conversation ID: ${job.threadId}`);
      lines.push(`  Recover result: agy --conversation ${job.threadId} --print "Summarize previous answer"`);
    } else if (job.possibleThreadIds?.length) {
      lines.push("  Multiple candidate conversation IDs found:");
      for (const id of job.possibleThreadIds) {
        lines.push(`    agy --conversation ${id} --print "Summarize previous answer"`);
      }
    } else {
      lines.push("  No conversation ID could be recovered automatically.");
    }
  } else {
    if (job.threadId) {
      lines.push(`  Agy conversation ID: ${job.threadId}`);
    }
    const resumeCommand = formatAgyResumeCommand(job);
    if (resumeCommand) {
      lines.push(`  Resume in agy: ${resumeCommand}`);
    }
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`  Cancel: /antigravity:cancel ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`  Result: /antigravity:result ${job.id}`);
  }
  if (
    job.status !== "queued" &&
    job.status !== "running" &&
    job.jobClass === "task" &&
    options.showReviewHint
  ) {
    lines.push("  Review changes: /antigravity:review --wait");
    lines.push("  Stricter review: /antigravity:adversarial-review --wait");
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
}

export function renderSetupReport(report) {
  const lines = [
    "# Antigravity Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- agy: ${report.agy.detail}`,
    `- auth: ${report.auth.detail}`,
    `- session runtime: ${report.sessionRuntime.label}`,
    `- review gate: ${report.reviewGateEnabled ? "enabled (experimental)" : "disabled"}`,
    ""
  ];

  if (report.actionsTaken.length > 0) {
    lines.push("Actions taken:");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
    lines.push("");
  }

  if (report.nextSteps.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

// agy returns plain text. We present it as-is under a review header so
// users can see the target context but the actual content is untouched.
export function renderReviewResult(result, meta) {
  const stdout = String(result?.stdout ?? "").trim();
  const stderr = String(result?.stderr ?? "").trim();
  const lines = [`# Antigravity ${meta.reviewLabel}`, "", `Target: ${meta.targetLabel}`, ""];

  if (stdout) {
    lines.push(stdout);
  } else if (result?.status === 0) {
    lines.push("agy review completed without any stdout output.");
  } else {
    lines.push("agy review failed.");
  }

  if (stderr) {
    lines.push("", "stderr:", "", "```text", stderr, "```");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderTaskResult(parsedResult /* , meta */) {
  const rawOutput = typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput : "";
  if (rawOutput) {
    return rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
  }

  const message =
    String(parsedResult?.failureMessage ?? "").trim() || "agy did not return a final message.";
  return `${message}\n`;
}

export function renderStatusReport(report) {
  const lines = [
    "# Antigravity Status",
    "",
    `Session runtime: ${report.sessionRuntime.label}`,
    `Review gate: ${report.config.stopReviewGate ? "enabled (experimental)" : "disabled"}`,
    ""
  ];

  if (report.running.length > 0) {
    appendActiveJobsTable(lines, report.running);
    lines.push("");
    lines.push("Live details:");
    for (const job of report.running) {
      pushJobDetails(lines, job, {
        showElapsed: true,
        showLog: true
      });
    }
    lines.push("");
  }

  if (report.orphaned?.length > 0) {
    lines.push("Orphaned jobs (wrapper died before completing):");
    for (const job of report.orphaned) {
      pushJobDetails(lines, job, {
        showDuration: true,
        showLog: true
      });
    }
    lines.push("");
  }

  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, {
      showDuration: true,
      showLog: report.latestFinished.status === "failed"
    });
    lines.push("");
  }

  if (report.recent.length > 0) {
    lines.push("Recent jobs:");
    for (const job of report.recent) {
      pushJobDetails(lines, job, {
        showDuration: true,
        showLog: job.status === "failed"
      });
    }
    lines.push("");
  } else if (report.running.length === 0 && !report.latestFinished) {
    lines.push("No jobs recorded yet.", "");
  }

  if (report.needsReview) {
    lines.push("The stop-time review gate is enabled (experimental).");
    lines.push(
      "Ending the session will trigger a fresh agy review and block if the first line of the response starts with `BLOCK:`."
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job) {
  const lines = ["# Antigravity Job Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  const threadId = storedJob?.threadId ?? job.threadId ?? null;
  const resumeCommand = threadId ? `agy --conversation ${threadId}` : null;

  const rawOutput =
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) ||
    (typeof storedJob?.result?.agy?.stdout === "string" && storedJob.result.agy.stdout) ||
    "";

  if (rawOutput) {
    const output = rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nAgy conversation ID: ${threadId}\nResume in agy: ${resumeCommand}\n`;
  }

  if (storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nAgy conversation ID: ${threadId}\nResume in agy: ${resumeCommand}\n`;
  }

  const lines = [`# ${job.title ?? "Antigravity Result"}`, "", `Job: ${job.id}`, `Status: ${job.status}`];

  if (threadId) {
    lines.push(`Agy conversation ID: ${threadId}`);
    lines.push(`Resume in agy: ${resumeCommand}`);
  }

  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }

  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job) {
  const lines = ["# Antigravity Cancel", "", `Cancelled ${job.id}.`, ""];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  lines.push("- Check `/antigravity:status` for the updated queue.");

  return `${lines.join("\n").trimEnd()}\n`;
}
