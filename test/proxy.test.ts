import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ApprovalRequester } from "../src/approval.js";
import { AuditLogger } from "../src/audit.js";
import { parsePolicy } from "../src/config.js";
import { PolicyEngine } from "../src/policy.js";
import { startProxy } from "../src/proxy.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures/echo-server.mjs");

const neverApprove: ApprovalRequester = { request: async () => false };
const alwaysApprove: ApprovalRequester = { request: async () => true };

function waitForLine(output: PassThrough): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for proxy output")), 3000);
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timeout);
      output.off("data", onData);
      resolve(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
    };
    output.on("data", onData);
  });
}

function harness(
  defaultEffect: "allow" | "deny" | "ask",
  approval: ApprovalRequester = neverApprove,
) {
  const workspace = mkdtempSync(join(tmpdir(), "toolfence-proxy-"));
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  const auditPath = join(workspace, "audit.jsonl");
  const policy = new PolicyEngine(
    parsePolicy({ version: 1, default: defaultEffect, rules: [] }),
    { workspace, home: workspace },
  );
  const controller = startProxy({
    command: process.execPath,
    args: [fixture],
    cwd: workspace,
    server: "echo",
    policy,
    approval,
    audit: new AuditLogger(auditPath),
    input,
    output,
    errorOutput: errors,
  });
  return { workspace, input, output, errors, auditPath, controller };
}

describe("stdio proxy", () => {
  it("passes non-tool MCP requests through", async () => {
    const test = harness("deny");
    test.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    const response = await waitForLine(test.output);
    expect(response.id).toBe(1);
    expect(response.result).toMatchObject({ tools: [{ name: "read_file" }] });
    test.input.end();
    await test.controller.closed;
  });

  it("returns an MCP tool error without forwarding a denied call", async () => {
    const test = harness("deny");
    test.input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "read_file", arguments: { path: "secret.txt" } },
    })}\n`);
    const response = await waitForLine(test.output);
    expect(response.id).toBe(2);
    expect(response.result).toMatchObject({ isError: true });
    test.input.end();
    await test.controller.closed;

    const audit = readFileSync(test.auditPath, "utf8");
    expect(audit).toContain('"event":"decision"');
    expect(audit).not.toContain("rawArguments");
  });

  it("forwards allowed calls and records a result hash", async () => {
    const test = harness("allow");
    test.input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "call-1",
      method: "tools/call",
      params: { name: "read_file", arguments: { path: "README.md" } },
    })}\n`);
    const response = await waitForLine(test.output);
    expect(response.id).toBe("call-1");
    expect(response.result).toBeDefined();
    test.input.end();
    await test.controller.closed;

    const audit = readFileSync(test.auditPath, "utf8");
    expect(audit).toContain('"event":"result"');
    expect(audit).toMatch(/"resultHash":"[a-f0-9]{64}"/);
  });

  it("fails ask closed when approval is rejected", async () => {
    const test = harness("ask");
    test.input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "unknown_tool", arguments: {} },
    })}\n`);
    const response = await waitForLine(test.output);
    expect(response.result).toMatchObject({ isError: true });
    test.input.end();
    await test.controller.closed;

    const audit = readFileSync(test.auditPath, "utf8");
    expect(audit).toContain('"effect":"deny"');
    expect(audit).toContain("Rejected by user");
  });

  it("forwards an ask decision after one-time approval", async () => {
    const test = harness("ask", alwaysApprove);
    test.input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "unknown_tool", arguments: { value: "ok" } },
    })}\n`);
    const response = await waitForLine(test.output);
    expect(response.id).toBe(4);
    expect(response.result).toBeDefined();
    test.input.end();
    await test.controller.closed;

    const audit = readFileSync(test.auditPath, "utf8");
    expect(audit).toContain('"effect":"allow"');
    expect(audit).toContain("Approved once by user");
  });
});
