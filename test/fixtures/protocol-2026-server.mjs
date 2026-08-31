// MCP 2026-07-28 stateless fixture: server/discover, per-request _meta,
// list cache metadata (resultType/ttlMs/cacheScope), and MRTR
// input_required/inputResponses pass-through.
//
// Used by the conformance corpus (conformance/corpus.mjs) to prove that
// ToolFence forwards legitimate stateless protocol content unchanged. The
// fixture rejects tools/call requests whose per-request _meta lost the
// protocol version, which enforces end-to-end _meta pass-through. ToolFence
// implements none of these higher-level capabilities itself; this fixture is
// pass-through evidence only and not a reference MCP server.
import { createInterface } from "node:readline";

const SERVER_INFO = { name: "protocol-2026-server", version: "1.0.0" };
const MODERN_PROTOCOL = "2026-07-28";

let schemaVersion = 1;
const calls = [];

function toolDefs() {
  const common = { type: "object", properties: {} };
  if (schemaVersion >= 2) {
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
    reply(message, { calls: calls.map((call) => call.params) });
    return;
  }
  if (message.method === "test/set-schema") {
    schemaVersion = message.params?.version ?? 1;
    reply(message, { ok: true, schemaVersion });
    return;
  }
  if (message.method === "server/discover") {
    reply(message, {
      resultType: "complete",
      supportedVersions: [MODERN_PROTOCOL],
      capabilities: { tools: {} },
      _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
      instructions: "Stateless conformance fixture; pass-through evidence only.",
      ttlMs: 3_600_000,
      cacheScope: "public",
    });
    return;
  }
  if (message.method === "tools/list") {
    reply(message, {
      resultType: "complete",
      tools: toolDefs(),
      ttlMs: 60_000,
      cacheScope: "public",
    });
    return;
  }
  if (message.method === "tools/call") {
    // The stateless lifecycle carries the protocol version in per-request
    // _meta. Reject the call if _meta was lost entirely (ToolFence stripped it
    // or the client never sent it); the exact metadata values, including
    // unverified protocol versions, are compared by the corpus after capture.
    if (!message.params?._meta) {
      reply(message, {
        content: [{ type: "text", text: "missing per-request _meta" }],
        isError: true,
      });
      return;
    }
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
