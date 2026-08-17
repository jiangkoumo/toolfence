import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const mode = process.argv[2];
const logPath = process.env.TOOLFENCE_FIXTURE_LOG;
const toolName = mode === "shell"
  ? "execute_command"
  : mode === "http"
    ? "http_request"
    : "git";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", async (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: `${mode}-fixture`, version: "1.0.0" },
      },
    })}\n`);
    return;
  }
  if (request.method === "tools/list") {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: [{
          name: toolName,
          description: `${mode} fixture`,
          inputSchema: { type: "object", additionalProperties: true },
        }],
      },
    })}\n`);
    return;
  }
  if (request.method !== "tools/call") return;
  if (logPath) appendFileSync(logPath, `${JSON.stringify(request.params)}\n`);
  let text = "ok";
  let isError = false;
  try {
    const args = request.params.arguments ?? {};
    if (mode === "git") {
      const gitArgs = Array.isArray(args.args) ? args.args : [];
      const result = spawnSync("git", gitArgs, { cwd: process.cwd(), encoding: "utf8" });
      text = result.stdout || result.stderr;
      isError = result.status !== 0;
    } else if (mode === "http") {
      const response = await fetch(args.url, {
        method: args.method ?? "GET",
        redirect: "manual",
      });
      text = `${response.status} ${await response.text()}`;
    } else {
      text = String(args.command ?? "");
    }
  } catch (error) {
    text = error instanceof Error ? error.message : String(error);
    isError = true;
  }
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: request.id,
    result: { content: [{ type: "text", text }], isError },
  })}\n`);
});
