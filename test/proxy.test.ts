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

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = join(fixtures, "echo-server.mjs");
const trackingFixture = join(fixtures, "tracking-server.mjs");

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

function waitForLines(output: PassThrough, count: number): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const messages: Array<Record<string, unknown>> = [];
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for proxy output")), 5000);
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        messages.push(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
        buffered = buffered.slice(newline + 1);
        if (messages.length === count) {
          clearTimeout(timeout);
          output.off("data", onData);
          resolve(messages);
          return;
        }
        newline = buffered.indexOf("\n");
      }
    };
    output.on("data", onData);
  });
}

function harness(
  defaultEffect: "allow" | "deny" | "ask",
  approval: ApprovalRequester = neverApprove,
  serverFixture = fixture,
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
    args: [serverFixture],
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

  it("requires approval for an unmatched unknown call even when the default allows", async () => {
    const test = harness("allow");
    test.input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "unknown-default-allow",
      method: "tools/call",
      params: { name: "unknown_tool", arguments: {} },
    })}\n`);
    const response = await waitForLine(test.output);
    expect(response.result).toMatchObject({ isError: true });
    expect(JSON.stringify(response)).toContain("Rejected by user");
    test.input.end();
    await test.controller.closed;
  });

  it("requires approval for a malformed known call even when the default allows", async () => {
    const test = harness("allow");
    test.input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "malformed-default-allow",
      method: "tools/call",
      params: { name: "read_file", arguments: {} },
    })}\n`);
    const response = await waitForLine(test.output);
    expect(response.result).toMatchObject({ isError: true });
    expect(JSON.stringify(response)).toContain("Rejected by user");
    test.input.end();
    await test.controller.closed;
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

  it("redacts sensitive secrets from tool call output and marks audit record", async () => {
    const sampleApiKey = ["sk", "proj", "abcdef1234567890abcdef1234567890"].join("-");
    const test = harness("allow");
    test.input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "call-secret",
      method: "tools/call",
      params: { name: "read_file", arguments: { path: "README.md", apiKey: sampleApiKey } },
    })}\n`);
    const response = await waitForLine(test.output);
    expect(response.id).toBe("call-secret");
    const text = (response.result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain("[REDACTED_SECRET]");
    expect(text).not.toContain("abcdef1234567890");
    test.input.end();
    await test.controller.closed;

    const audit = readFileSync(test.auditPath, "utf8");
    expect(audit).toContain('"redacted":true');
  });

  it("redacts sensitive secrets from JSON-RPC errors", async () => {
    const test = harness("allow");
    test.input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "error-secret",
      method: "tools/call",
      params: {
        name: "read_file",
        arguments: { path: "README.md", errorMessage: "password=supersecret123" },
      },
    })}\n`);
    const response = await waitForLine(test.output);
    expect(response.error).toMatchObject({
      code: -32000,
      message: "password=[REDACTED_SECRET]",
    });
    test.input.end();
    await test.controller.closed;

    const audit = readFileSync(test.auditPath, "utf8");
    expect(audit).toContain('"error":true');
    expect(audit).toContain('"redacted":true');
  });

  it("rejects a request before upstream execution when tracking capacity is exhausted", async () => {
    const test = harness("allow", neverApprove, trackingFixture);
    const responses = waitForLines(test.output, 4);

    test.input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "oldest",
      method: "tools/call",
      params: { name: "read_file", arguments: { path: "README.md" } },
    })}\n`);
    for (let id = 0; id < 2001; id += 1) {
      test.input.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: `filler-${id}`,
        method: "test/filler",
      })}\n`);
    }
    test.input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "test/report-count",
    })}\n`);
    test.input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "test/release-oldest",
    })}\n`);

    const messages = await responses;
    for (const id of ["filler-1999", "filler-2000"]) {
      expect(messages).toContainEqual({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: "ToolFence has too many in-flight requests",
        },
      });
    }
    expect(messages).toContainEqual({
      jsonrpc: "2.0",
      method: "test/request-count",
      params: { count: 2000 },
    });
    const oldest = messages.find((message) => message.id === "oldest");
    const text = (oldest?.result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toBe("password=[REDACTED_SECRET]");

    test.input.end();
    await test.controller.closed;

    const audit = readFileSync(test.auditPath, "utf8");
    expect(audit).toContain('"requestId":"oldest"');
    expect(audit).toContain('"event":"result"');
    expect(audit).toContain('"redacted":true');
    expect(audit).not.toContain("supersecret123");
  });

  it("does not let a duplicate non-tool request overwrite tracked tool state", async () => {
    const test = harness("allow", neverApprove, trackingFixture);
    const responses = waitForLines(test.output, 2);

    test.input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "oldest",
      method: "tools/call",
      params: { name: "read_file", arguments: { path: "README.md" } },
    })}\n`);
    test.input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "oldest",
      method: "test/filler",
    })}\n`);
    test.input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "test/release-oldest",
    })}\n`);

    const messages = await responses;
    expect(messages).toContainEqual({
      jsonrpc: "2.0",
      id: "oldest",
      error: { code: -32600, message: "Duplicate in-flight request id" },
    });
    const oldest = messages.find((message) => message.result !== undefined);
    const text = (oldest?.result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toBe("password=[REDACTED_SECRET]");

    test.input.end();
    await test.controller.closed;
  });

  it("rejects a cancellation request with an id before it reaches upstream", async () => {
    const test = harness("allow", neverApprove, trackingFixture);
    const responses = waitForLines(test.output, 3);

    test.input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "oldest",
      method: "tools/call",
      params: { name: "read_file", arguments: { path: "README.md" } },
    })}\n`);
    test.input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "oldest",
      method: "notifications/cancelled",
      params: { requestId: "oldest", reason: "user" },
    })}\n`);
    test.input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "test/report-count",
    })}\n`);
    test.input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "test/release-oldest",
    })}\n`);

    const messages = await responses;
    expect(messages).toContainEqual({
      jsonrpc: "2.0",
      id: "oldest",
      error: {
        code: -32600,
        message: "notifications/cancelled must not include a request id",
      },
    });
    expect(messages).toContainEqual({
      jsonrpc: "2.0",
      method: "test/request-count",
      params: { count: 1 },
    });
    const oldest = messages.find((message) => message.result !== undefined);
    const text = (oldest?.result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toBe("password=[REDACTED_SECRET]");

    test.input.end();
    await test.controller.closed;
  });
});
