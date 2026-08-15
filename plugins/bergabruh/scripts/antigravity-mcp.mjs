#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const COMPANION = path.join(PLUGIN_ROOT, "scripts", "antigravity-companion.mjs");
const PROTOCOL_VERSION = "2025-03-26";

const LOCAL_READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const LOCAL_STATE_CHANGE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const EXTERNAL_ANTIGRAVITY_TURN = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

const TOOLS = [
  tool("setup", "Check whether Antigravity is installed. With probeAuth enabled, starts a network-backed authentication probe with Antigravity.", {
    probeAuth: booleanProperty("Run the network-backed authentication probe."),
    workspace: workspaceProperty()
  }, [], EXTERNAL_ANTIGRAVITY_TURN),
  tool("review", "Run a code review with Antigravity. This sends review instructions and selected workspace diff/context to the configured external Antigravity service.", {
    base: stringProperty("Optional Git base reference."),
    scope: enumProperty(["auto", "working-tree", "branch"], "Review target scope."),
    background: booleanProperty("Return immediately after starting the review."),
    workspace: workspaceProperty()
  }, [], EXTERNAL_ANTIGRAVITY_TURN),
  tool("adversarial_review", "Run a focused adversarial code review with Antigravity. This sends the focus, review instructions, and selected workspace diff/context to the configured external Antigravity service.", {
    focus: stringProperty("Risk or design concern for the review."),
    base: stringProperty("Optional Git base reference."),
    scope: enumProperty(["auto", "working-tree", "branch"], "Review target scope."),
    background: booleanProperty("Return immediately after starting the review."),
    workspace: workspaceProperty()
  }, [], EXTERNAL_ANTIGRAVITY_TURN),
  tool("task", "Delegate a task to Antigravity. This sends the task prompt and grants the configured external Antigravity service access to the selected workspace context.", {
    prompt: stringProperty("Task prompt for Antigravity."),
    resume: booleanProperty("Resume the latest tracked task."),
    background: booleanProperty("Return immediately after starting the task."),
    workspace: workspaceProperty()
  }, ["prompt"], EXTERNAL_ANTIGRAVITY_TURN),
  tool("status", "Show Antigravity jobs for the workspace.", {
    jobId: stringProperty("Optional job identifier."),
    all: booleanProperty("Show jobs from all sessions."),
    workspace: workspaceProperty()
  }, [], LOCAL_READ_ONLY),
  tool("result", "Show the stored result for an Antigravity job.", {
    jobId: stringProperty("Optional job identifier; defaults to the latest job."),
    workspace: workspaceProperty()
  }, [], LOCAL_READ_ONLY),
  tool("cancel", "Cancel an active Antigravity job.", {
    jobId: stringProperty("Optional job identifier; defaults to the latest active job."),
    workspace: workspaceProperty()
  }, [], LOCAL_STATE_CHANGE)
];

function tool(name, description, properties, required = [], annotations = LOCAL_READ_ONLY) {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required: [...new Set([...required, "workspace"])], additionalProperties: false },
    annotations
  };
}

function stringProperty(description) {
  return { type: "string", description };
}

function booleanProperty(description) {
  return { type: "boolean", description };
}

function enumProperty(values, description) {
  return { type: "string", enum: values, description };
}

function workspaceProperty() {
  return stringProperty("Absolute path to the target workspace.");
}

function resolveWorkspace(value) {
  if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value)) {
    throw new InvalidParamsError("workspace must be an absolute, non-empty path.");
  }
  try {
    const workspace = fs.realpathSync(value);
    if (!fs.statSync(workspace).isDirectory()) {
      throw new InvalidParamsError("workspace must resolve to a directory.");
    }
    return workspace;
  } catch (error) {
    if (error instanceof InvalidParamsError) throw error;
    throw new InvalidParamsError("workspace must resolve to an existing directory.");
  }
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new InvalidParamsError(`${name} must be a non-empty string.`);
  return value;
}

function optionalString(value, name) {
  return value == null ? null : requireString(value, name);
}

function requireBoolean(value, name) {
  if (value != null && typeof value !== "boolean") throw new InvalidParamsError(`${name} must be a boolean.`);
  return Boolean(value);
}

function appendFlag(args, flag, enabled) {
  if (enabled) args.push(flag);
}

function buildCompanionArgs(name, rawArguments) {
  const args = rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments) ? rawArguments : {};
  const workspace = resolveWorkspace(args.workspace);
  const command = name.replace("_", "-");
  const commandArgs = [COMPANION, command, "--cwd", workspace];

  switch (name) {
    case "setup":
      appendFlag(commandArgs, "--probe-auth", requireBoolean(args.probeAuth, "probeAuth"));
      break;
    case "review":
    case "adversarial_review": {
      const base = optionalString(args.base, "base");
      const scope = optionalString(args.scope, "scope");
      if (scope && !["auto", "working-tree", "branch"].includes(scope)) {
        throw new InvalidParamsError("scope must be auto, working-tree, or branch.");
      }
      appendFlag(commandArgs, "--background", requireBoolean(args.background, "background"));
      if (base) commandArgs.push("--base", base);
      if (scope) commandArgs.push("--scope", scope);
      if (name === "adversarial_review") {
        const focus = optionalString(args.focus, "focus");
        if (focus) commandArgs.push(focus);
      }
      break;
    }
    case "task":
      appendFlag(commandArgs, "--background", requireBoolean(args.background, "background"));
      appendFlag(commandArgs, "--resume-last", requireBoolean(args.resume, "resume"));
      commandArgs.push(requireString(args.prompt, "prompt"));
      break;
    case "status": {
      appendFlag(commandArgs, "--all", requireBoolean(args.all, "all"));
      const jobId = optionalString(args.jobId, "jobId");
      if (jobId) commandArgs.push(jobId);
      break;
    }
    case "result":
    case "cancel": {
      const jobId = optionalString(args.jobId, "jobId");
      if (jobId) commandArgs.push(jobId);
      break;
    }
    default:
      throw new MethodNotFoundError(`Unknown Antigravity tool: ${name}`);
  }
  return { commandArgs, workspace };
}

function runCompanion(commandArgs, workspace) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, commandArgs, { cwd: workspace, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function textResult(text, isError = false) {
  return { content: [{ type: "text", text: String(text).trimEnd() || "(no output)" }], isError };
}

async function handleRequest(request) {
  if (request.method === "initialize") {
    return { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "bergabruh-antigravity", version: "2.0.0" } };
  }
  if (request.method === "ping") return {};
  if (request.method === "tools/list") return { tools: TOOLS };
  if (request.method === "tools/call") {
    const name = requireString(request.params?.name, "tool name");
    if (!TOOLS.some((definition) => definition.name === name)) throw new MethodNotFoundError(`Unknown Antigravity tool: ${name}`);
    const { commandArgs, workspace } = buildCompanionArgs(name, request.params?.arguments);
    const result = await runCompanion(commandArgs, workspace);
    return textResult([result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n"), result.code !== 0);
  }
  throw new MethodNotFoundError(`Unsupported MCP method: ${request.method}`);
}

class InvalidParamsError extends Error {}

class MethodNotFoundError extends Error {}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    continue;
  }
  try {
    const result = await handleRequest(request);
    if (request.id !== undefined) writeMessage({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    if (request?.id !== undefined) {
      const code = error instanceof MethodNotFoundError ? -32601 : error instanceof InvalidParamsError ? -32602 : -32603;
      writeMessage({ jsonrpc: "2.0", id: request.id, error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  }
}
