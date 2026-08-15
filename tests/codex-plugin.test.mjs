import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "bergabruh");
const MCP_BRIDGE = path.join(PLUGIN_ROOT, "scripts", "antigravity-mcp.mjs");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function runMcp(messages, options = {}) {
  const mcpConfig = readJson("plugins/bergabruh/.mcp.json");
  const server = mcpConfig.mcpServers.antigravity;
  const script = path.resolve(PLUGIN_ROOT, server.args[0]);
  return run(server.command, [script], {
    cwd: options.cwd ?? ROOT,
    input: `${messages.map((message) => typeof message === "string" ? message : JSON.stringify(message)).join("\n")}\n`
  });
}

test("Codex marketplace exposes bergabruh from antigravity-plugin-cc", () => {
  const marketplace = readJson(".agents/plugins/marketplace.json");
  const manifest = readJson("plugins/bergabruh/.codex-plugin/plugin.json");

  assert.equal(marketplace.name, "antigravity-plugin-cc");
  assert.deepEqual(marketplace.plugins, [
    {
      name: "bergabruh",
      source: { source: "local", path: "./plugins/bergabruh" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity"
    }
  ]);
  assert.equal(manifest.name, "bergabruh");
  assert.equal(manifest.mcpServers, "./.mcp.json");
});

test("Codex MCP bridge uses the plugin-local companion and exposes supported operations", () => {
  const mcpConfig = readJson("plugins/bergabruh/.mcp.json");
  const server = mcpConfig.mcpServers.antigravity;

  assert.deepEqual(server, {
    command: "node",
    args: ["./scripts/antigravity-mcp.mjs"],
    cwd: "${PLUGIN_ROOT}"
  });

  const result = runMcp([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }
  ]);

  assert.equal(result.status, 0, result.stderr);
  const replies = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(replies[0].result.serverInfo.name, "bergabruh-antigravity");
  assert.deepEqual(
    replies[1].result.tools.map((tool) => tool.name),
    ["setup", "review", "adversarial_review", "task", "status", "result", "cancel"]
  );
  assert.equal(replies[1].result.tools.every((tool) => tool.inputSchema.required.includes("workspace")), true);
  assert.equal(replies[1].result.tools.find((tool) => tool.name === "task").inputSchema.properties.write, undefined);
  assert.deepEqual(replies[1].result.tools.find((tool) => tool.name === "status").annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false
  });
  assert.deepEqual(replies[1].result.tools.find((tool) => tool.name === "cancel").annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false
  });
  for (const name of ["setup", "review", "adversarial_review", "task"]) {
    assert.deepEqual(replies[1].result.tools.find((tool) => tool.name === name).annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true
    });
  }
  assert.match(replies[1].result.tools.find((tool) => tool.name === "review").description, /external Antigravity service/);
  assert.match(replies[1].result.tools.find((tool) => tool.name === "task").description, /workspace context/);
});

test("Codex MCP bridge rejects invalid workspaces and uses JSON-RPC error codes", () => {
  const missingWorkspace = path.join(ROOT, "does-not-exist");
  const result = runMcp([
    "{not-json",
    { jsonrpc: "2.0", id: 1, method: "not/a/method", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "status", arguments: { workspace: missingWorkspace } } }
  ]);

  assert.equal(result.status, 0, result.stderr);
  const replies = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(replies[0].error.code, -32700);
  assert.equal(replies[0].id, null);
  assert.equal(replies[1].error.code, -32601);
  assert.equal(replies[2].error.code, -32602);
});

test("Codex MCP bridge runs companion commands in an explicit workspace", () => {
  const workspace = makeTempDir("bergabruh-mcp-workspace-");
  const result = runMcp(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "status", arguments: { workspace } } }
    ],
    { cwd: workspace }
  );

  assert.equal(result.status, 0, result.stderr);
  const reply = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.equal(reply.result.isError, false);
  assert.match(reply.result.content[0].text, /No jobs recorded yet/);
});
