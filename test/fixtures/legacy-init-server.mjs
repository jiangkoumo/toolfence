// Legacy MCP lifecycle fixture: initialize/initialized handshake, tools/list
// without cache metadata, per-call params carrying only name and arguments.
//
// Used by the conformance corpus (conformance/corpus.mjs) to prove that
// ToolFence passes legitimate protocol content through transparently and makes
// identical policy decisions across protocol revisions. This is a test fixture,
// not a reference MCP server.
import { createInterface } from "node:readline";

const SERVER_INFO = { name: "legacy-init-server", version: "1.0.0" };
const LEGACY_PROTOCOL = "2025-06-18";

let schemaVersion = 1;
let sawInitialized = false;
const calls = [];

function toolDefs() {
  const common = { type: "object", properties: {} };
  if (schemaVersion >= 2) {
    // Schema change fixture: the fingerprint must change so approvals are
    // re-requested after a tools/list refresh.
    common.properties.encoding = { type: "string" };
  }
  return [
    {
      name: "read_file",
      description: `Read a file (schema v${schemaVersion})`,
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, ...common.properties },
        required: ["path"],
      },
    },
    {
      name: "read_multiple_files",
      description: `Read several files (schema v${schemaVersion})`,
      inputSchema: {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" } },
          ...common.properties,
        },
        required: ["paths"],
      },
    },
    {
      name: "run_command",
      description: `Run a command (schema v${schemaVersion})`,
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" }, ...common.properties },
        required: ["command"],
      },
    },
    {
      name: "fetch",
      description: `Fetch a URL (schema v${schemaVersion})`,
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" }, method: { type: "string" }, ...common.properties },
        required: ["url"],
      },
    },
    {
      name: "ask_user",
      description: `Multi round-trip demo tool (schema v${schemaVersion})`,
      inputSchema: {
        type: "object",
        properties: { requestState: { type: "string" }, inputResponses: { type: "array" } },
      },
    },
  ];
}

function reply(message, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const message = JSON.parse(line);

  if (message.method === "test/report-calls") {
    reply(message, { calls: calls.map((call) => call.params), sawInitialized });
    return;
  }
  if (message.method === "test/set-schema") {
    schemaVersion = message.params?.version ?? 1;
    reply(message, { ok: true, schemaVersion });
    return;
  }
  if (message.method === "initialize") {
    reply(message, {
      protocolVersion: message.params?.protocolVersion ?? LEGACY_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
    return;
  }
  if (message.method === "notifications/initialized") {
    sawInitialized = true;
    return;
  }
  if (message.method === "tools/list") {
    reply(message, { tools: toolDefs() });
    return;
  }
  if (message.method === "tools/call") {
    calls.push(message);
    const { name, arguments: args } = message.params ?? {};
    if (name === "ask_user") {
      reply(message, args?.inputResponses
        ? { resultType: "complete", content: [{ type: "text", text: "answered" }] }
        : {
            resultType: "input_required",
            requestState: "rs-1",
            requests: [{ id: "q1", type: "input/confirmation", prompt: "Continue?" }],
          });
      return;
    }
    reply(message, { content: [{ type: "text", text: "ok" }] });
  }
});
