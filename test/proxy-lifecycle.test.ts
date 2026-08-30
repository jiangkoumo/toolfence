import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ApprovalRequester } from "../src/approval.js";
import { AuditLogger, readAudit } from "../src/audit.js";
import { parsePolicy } from "../src/config.js";
import { PolicyEngine } from "../src/policy.js";
import { startProxy } from "../src/proxy.js";

const fixtures = dirname(fileURLToPath(import.meta.url));
const echoFixture = join(fixtures, "fixtures/echo-server.mjs");
const exitFixture = join(fixtures, "fixtures/exit-server.mjs");
const trackingFixture = join(fixtures, "fixtures/tracking-server.mjs");

function waitForLine(output: PassThrough): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => reject(new Error("timed out")), 2_000);
    output.on("data", function onData(chunk: Buffer) {
      buffered += chunk.toString("utf8");
      const end = buffered.indexOf("\n");
      if (end < 0) return;
      clearTimeout(timer);
      output.off("data", onData);
      resolve(JSON.parse(buffered.slice(0, end)) as Record<string, unknown>);
    });
  });
}

function harness(approval: ApprovalRequester, options?: { timeout?: number; fixture?: string }) {
  const workspace = mkdtempSync(join(tmpdir(), "toolfence-lifecycle-"));
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  const auditPath = join(workspace, "audit.jsonl");
  const policy = new PolicyEngine(
    parsePolicy({ version: 1, default: "ask", rules: [] }),
    { workspace, home: workspace },
  );
  const controller = startProxy({
    command: process.execPath,
    args: [options?.fixture ?? echoFixture],
    cwd: workspace,
    server: "fixture",
    policy,
    approval,
    audit: new AuditLogger(auditPath),
    input,
    output,
    errorOutput,
    approvalTimeoutMs: options?.timeout ?? 1_000,
  });
  return { workspace, input, output, errorOutput, auditPath, controller };
}

function call(id: string | number, name = "read_file"): string {
  return `${JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: { path: "README.md" } },
  })}\n`;
}

describe("proxy lifecycle safety", () => {
  it("never forwards an approval that is cancelled by the client", async () => {
    const approval: ApprovalRequester = { request: () => new Promise(() => undefined) };
    const test = harness(approval);
    test.input.write(call("cancelled"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    test.input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: "cancelled", reason: "user" },
    })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(readFileSync(test.auditPath, "utf8")).toBe("");
    expect(test.output.readableLength).toBe(0);
    test.input.end();
    await test.controller.closed;
  });

  it("denies after an approval timeout even if the requester hangs", async () => {
    const approval: ApprovalRequester = { request: () => new Promise(() => undefined) };
    const test = harness(approval, { timeout: 20, fixture: trackingFixture });
    test.input.write(call("timeout"));
    const response = await waitForLine(test.output);
    expect(response.result).toMatchObject({ isError: true });
    expect(JSON.stringify(response)).toContain("timed out");

    const count = waitForLine(test.output);
    test.input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "test/report-count" })}\n`);
    expect(await count).toMatchObject({
      method: "test/request-count",
      params: { count: 0 },
    });
    test.input.end();
    await test.controller.closed;

    expect(readAudit(test.auditPath)[0]).toMatchObject({
      event: "decision",
      requestId: "timeout",
      approvalId: expect.any(String),
      resolution: "deny",
      dispatch: "not-forwarded",
      decision: { effect: "deny", reason: "Approval timed out" },
    });
  });

  it("returns a terminal denial when an approval implementation throws", async () => {
    const approval: ApprovalRequester = {
      request: async () => { throw new Error("approval transport broke"); },
    };
    const test = harness(approval);
    test.input.write(call("approval-error"));
    const response = await waitForLine(test.output);
    expect(response.result).toMatchObject({ isError: true });
    test.input.end();
    await test.controller.closed;
  });

  it("reports an explicit error when upstream exits with a request in flight", async () => {
    const test = harness({ request: async () => true }, { fixture: exitFixture });
    test.input.write(call("exit"));
    const response = await waitForLine(test.output);
    expect(response).toMatchObject({ id: "exit", error: { code: -32603 } });
    expect(JSON.stringify(response)).toContain("exited before responding");
    test.input.end();
    await test.controller.closed;
  });

  it("propagates tool schema fingerprints into approval context", async () => {
    let updated = "";
    let observed = "";
    const approval: ApprovalRequester = {
      updateToolFingerprint: (_server, _tool, fingerprint) => { updated = fingerprint; },
      request: async (_action, _decision, context) => {
        observed = context?.schemaFingerprint ?? "";
        return false;
      },
    };
    const test = harness(approval);
    test.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    await waitForLine(test.output);
    test.input.write(call(2));
    await waitForLine(test.output);
    expect(updated).toMatch(/^[a-f0-9]{64}$/);
    expect(observed).toBe(updated);
    test.input.end();
    await test.controller.closed;
  });
});
