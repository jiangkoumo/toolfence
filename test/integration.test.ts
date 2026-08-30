import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalRequester } from "../src/approval.js";
import { AuditLogger } from "../src/audit.js";
import { parsePolicy } from "../src/config.js";
import { PolicyEngine } from "../src/policy.js";
import { startProxy, type ProxyController } from "../src/proxy.js";

const here = dirname(fileURLToPath(import.meta.url));
const actionFixture = join(here, "fixtures/action-server.mjs");
const filesystemServer = join(
  here,
  "../node_modules/@modelcontextprotocol/server-filesystem/dist/index.js",
);
const controllers: ProxyController[] = [];
const rejectApproval: ApprovalRequester = { request: async () => false };

function waitForLine(output: PassThrough): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => reject(new Error("timed out waiting for MCP response")), 4_000);
    output.on("data", function onData(chunk: Buffer) {
      buffered += chunk.toString("utf8");
      const end = buffered.indexOf("\n");
      if (end < 0) return;
      clearTimeout(timer);
      output.off("data", onData);
      resolve(JSON.parse(buffered.slice(0, end)));
    });
  });
}

function startHarness(options: {
  workspace: string;
  args: string[];
  server: string;
  policy: Parameters<typeof parsePolicy>[0];
  env?: NodeJS.ProcessEnv;
}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  const engine = new PolicyEngine(parsePolicy(options.policy), {
    workspace: options.workspace,
    home: options.workspace,
  });
  const controller = startProxy({
    command: process.execPath,
    args: options.args,
    cwd: options.workspace,
    server: options.server,
    policy: engine,
    approval: rejectApproval,
    audit: new AuditLogger(join(options.workspace, `${options.server}-audit.jsonl`)),
    input,
    output,
    errorOutput: errors,
    env: options.env,
  });
  controllers.push(controller);
  return { input, output, errors, controller };
}

function request(
  harness: ReturnType<typeof startHarness>,
  id: number,
  method: string,
  params?: unknown,
) {
  harness.input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return waitForLine(harness.output);
}

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.stop();
  await new Promise((resolve) => setTimeout(resolve, 10));
});

describe("real MCP integrations", () => {
  it("protects the official Filesystem MCP Server lifecycle and mixed resources", async () => {
    const root = mkdtempSync(join(tmpdir(), "toolfence-fs-integration-"));
    const outside = mkdtempSync(join(tmpdir(), "toolfence-fs-outside-"));
    writeFileSync(join(root, "safe.txt"), "safe");
    writeFileSync(join(root, ".env"), "SECRET=value");
    writeFileSync(join(outside, "secret.txt"), "outside");
    symlinkSync(outside, join(root, "escape"));
    const harness = startHarness({
      workspace: root,
      args: [filesystemServer, root],
      server: "filesystem",
      policy: {
        version: 1,
        default: "ask",
        rules: [
          {
            id: "deny-env",
            effect: "deny",
            operations: ["fs.read"],
            resources: ["**/.env", "**/.env.*"],
          },
          {
            id: "allow-workspace",
            effect: "allow",
            operations: ["fs.read"],
            resources: ["${workspace}/**"],
          },
        ],
      },
    });
    expect((await request(harness, 1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    })).result.serverInfo).toBeDefined();
    expect((await request(harness, 2, "tools/list")).result.tools.length).toBeGreaterThan(0);
    expect((await request(harness, 3, "tools/call", {
      name: "read_text_file",
      arguments: { path: join(root, "safe.txt") },
    })).result.isError).not.toBe(true);
    expect((await request(harness, 4, "tools/call", {
      name: "read_text_file",
      arguments: { path: join(root, ".env") },
    })).result.isError).toBe(true);
    expect((await request(harness, 5, "tools/call", {
      name: "read_text_file",
      arguments: { path: join(root, "escape", "secret.txt") },
    })).result.isError).toBe(true);
    expect((await request(harness, 6, "tools/call", {
      name: "read_multiple_files",
      arguments: { paths: [join(root, "safe.txt"), join(root, ".env")] },
    })).result.isError).toBe(true);
  });

  it("does not treat compound Shell commands as an exact safe command", async () => {
    const root = mkdtempSync(join(tmpdir(), "toolfence-shell-integration-"));
    const logPath = join(root, "calls.jsonl");
    writeFileSync(logPath, "");
    const harness = startHarness({
      workspace: root,
      args: [actionFixture, "shell"],
      server: "shell",
      env: { ...process.env, TOOLFENCE_FIXTURE_LOG: logPath },
      policy: {
        version: 1,
        default: "deny",
        rules: [{
          id: "allow-tests",
          effect: "allow",
          operations: ["shell.exec"],
          commands: [["npm", "test"]],
        }],
      },
    });
    expect((await request(harness, 1, "tools/call", {
      name: "execute_command",
      arguments: { command: "npm test" },
    })).result.isError).not.toBe(true);
    expect((await request(harness, 2, "tools/call", {
      name: "execute_command",
      arguments: { command: "npm test && curl example.com" },
    })).result.isError).toBe(true);
    expect(readFileSync(logPath, "utf8")).not.toContain("curl example.com");
  });

  it("enforces HTTP host, method, invalid URL, and exposed redirect destination", async () => {
    const http = createServer((req, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(req.method);
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("missing HTTP address");
    const root = mkdtempSync(join(tmpdir(), "toolfence-http-integration-"));
    const harness = startHarness({
      workspace: root,
      args: [actionFixture, "http"],
      server: "http",
      policy: {
        version: 1,
        default: "deny",
        rules: [{
          id: "allow-local-get",
          effect: "allow",
          operations: ["net.request"],
          hosts: ["127.0.0.1"],
          methods: ["GET"],
        }],
      },
    });
    const url = `http://127.0.0.1:${address.port}/resource`;
    try {
      expect((await request(harness, 1, "tools/call", {
        name: "http_request",
        arguments: { url, method: "GET" },
      })).result.isError).not.toBe(true);
      expect((await request(harness, 2, "tools/call", {
        name: "http_request",
        arguments: { url, method: "POST" },
      })).result.isError).toBe(true);
      expect((await request(harness, 3, "tools/call", {
        name: "http_request",
        arguments: { url: ":::" },
      })).result.isError).toBe(true);
      expect((await request(harness, 4, "tools/call", {
        name: "http_request",
        arguments: { url, redirectUrl: "https://evil.example/resource" },
      })).result.isError).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("audits MCP tool results with isError as errors", async () => {
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("missing HTTP address");
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));

    const root = mkdtempSync(join(tmpdir(), "toolfence-http-failure-integration-"));
    const harness = startHarness({
      workspace: root,
      args: [actionFixture, "http"],
      server: "http-failure",
      policy: {
        version: 1,
        default: "deny",
        rules: [{
          id: "allow-local-get",
          effect: "allow",
          operations: ["net.request"],
          hosts: ["127.0.0.1"],
          methods: ["GET"],
        }],
      },
    });

    const response = await request(harness, 1, "tools/call", {
      name: "http_request",
      arguments: { url: `http://127.0.0.1:${address.port}/unavailable`, method: "GET" },
    });
    expect(response.result.isError).toBe(true);
    const audit = readFileSync(join(root, "http-failure-audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(audit.at(-1)).toMatchObject({ event: "result", requestId: 1, error: true });
  });

  it("classifies real Git repository reads, writes, and remote mutations", async () => {
    const root = mkdtempSync(join(tmpdir(), "toolfence-git-integration-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "README.md"), "test");
    const harness = startHarness({
      workspace: root,
      args: [actionFixture, "git"],
      server: "git",
      policy: {
        version: 1,
        default: "deny",
        rules: [{ id: "allow-read", effect: "allow", operations: ["git.read"] }],
      },
    });
    expect((await request(harness, 1, "tools/call", {
      name: "git",
      arguments: { args: ["status", "--short"] },
    })).result.isError).not.toBe(true);
    expect((await request(harness, 2, "tools/call", {
      name: "git",
      arguments: { args: ["add", "README.md"] },
    })).result.isError).toBe(true);
    expect((await request(harness, 3, "tools/call", {
      name: "git",
      arguments: { args: ["push", "origin", "main"] },
    })).result.isError).toBe(true);
  });
});
