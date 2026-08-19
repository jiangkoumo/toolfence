import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtempSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { AuditLogger } from "../src/audit.js";
import { BrokerApprovalRequester, startBroker } from "../src/broker.js";
import { isMainModule, parseCli, runApprovals, runCli } from "../src/cli.js";
import { initPolicy, loadPolicy } from "../src/config.js";

describe("policy init", () => {
  it("creates a conservative valid policy in a new parent directory", () => {
    const root = mkdtempSync(join(tmpdir(), "toolfence-init-"));
    const policyPath = join(root, "nested", "policy.yaml");

    expect(initPolicy(policyPath)).toBe(policyPath);
    expect(loadPolicy(policyPath)).toMatchObject({
      version: 1,
      default: "ask",
      rules: [
        { id: "protect-secrets", effect: "deny" },
        { id: "allow-workspace-read", effect: "allow" },
        { id: "allow-git-read", effect: "allow" },
      ],
    });
  });

  it("never overwrites an existing policy", () => {
    const root = mkdtempSync(join(tmpdir(), "toolfence-init-"));
    const policyPath = join(root, "policy.yaml");
    initPolicy(policyPath);
    const original = readFileSync(policyPath, "utf8");

    expect(() => initPolicy(policyPath)).toThrow(`Policy already exists: ${policyPath}`);
    expect(readFileSync(policyPath, "utf8")).toBe(original);
  });
});

describe("policy init CLI", () => {
  it("uses a discoverable default path", () => {
    expect(parseCli(["policy", "init"])).toEqual({
      command: "policy-init",
      policy: resolve("toolfence.yaml"),
    });
  });

  it("accepts a custom policy path and rejects unrelated options", () => {
    expect(parseCli(["policy", "init", "--policy", "config/policy.yaml"])).toEqual({
      command: "policy-init",
      policy: resolve("config/policy.yaml"),
    });
    expect(() => parseCli(["policy", "init", "--workspace", "."])).toThrow(
      "Unknown option for policy init: --workspace",
    );
    expect(() =>
      parseCli(["policy", "check", "--policy", "policy.yaml", "--cases", "cases.yaml"]),
    ).toThrow("Unknown option for policy check: --cases");
  });
});

describe("operational CLI", () => {
  it("supports machine-readable and targeted Broker approvals", () => {
    expect(parseCli(["approvals", "--json"])).toEqual({
      command: "approvals",
      json: true,
      approvalId: undefined,
      decision: undefined,
    });
    expect(parseCli(["approvals", "--id", "approval-1", "--decision", "allow-once"])).toEqual({
      command: "approvals",
      json: false,
      approvalId: "approval-1",
      decision: "allow-once",
    });
    expect(() => parseCli(["approvals", "--id", "approval-1"])).toThrow(
      "--id and --decision must be used together",
    );
    expect(() => parseCli(["approvals", "--id", "approval-1", "--decision", "always"])).toThrow(
      "--decision must be allow-once, allow-session, or deny",
    );
  });

  it("parses audit summary and tail options", () => {
    expect(parseCli(["audit", "summary", "--audit", "logs/audit.jsonl", "--json"])).toEqual({
      command: "audit-summary",
      audit: resolve("logs/audit.jsonl"),
      json: true,
    });
    expect(parseCli(["audit", "tail", "--lines", "5"])).toEqual({
      command: "audit-tail",
      audit: resolve(".toolfence/audit.jsonl"),
      json: false,
      lines: 5,
    });
    expect(() => parseCli(["audit", "tail", "--lines", "0"])).toThrow(
      "--lines must be between 1 and 10000",
    );
    expect(() => parseCli(["audit", "summary", "--lines", "5"])).toThrow(
      "Unknown option for audit summary: --lines",
    );
  });

  it("prints audit summaries and tails as JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "toolfence-cli-audit-"));
    const path = join(root, "audit.jsonl");
    const logger = new AuditLogger(path);
    logger.decision(1, {
      operation: "fs.read",
      resources: [join(root, "README.md")],
      server: "fixture",
      tool: "read_file",
      rawArguments: { secret: "do-not-return" },
    }, { effect: "allow", reason: "test" });
    logger.result(1, "hash", false);
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runCli(["audit", "summary", "--audit", path, "--json"]);
      const summary = JSON.parse(String(output.mock.calls.at(-1)?.[0]));
      expect(summary).toMatchObject({ events: 2, decisions: { allow: 1 }, results: { total: 1 } });

      await runCli(["audit", "tail", "--audit", path, "--lines", "1", "--json"]);
      const tail = JSON.parse(String(output.mock.calls.at(-1)?.[0]));
      expect(tail).toMatchObject([{ event: "result", requestId: 1, resultHash: "hash" }]);
    } finally {
      output.mockRestore();
    }
  });

  it("resolves one pending approval non-interactively", async () => {
    const root = mkdtempSync(join(tmpdir(), "toolfence-cli-approval-"));
    const paths = {
      runtimeDir: join(root, "run"),
      socketPath: join(root, "run", "broker.sock"),
      tokenPath: join(root, "home", ".toolfence", "broker.token"),
    };
    const broker = await startBroker(paths);
    const requester = new BrokerApprovalRequester(broker.paths, 1_000);
    const result = requester.request({
      operation: "fs.read",
      resources: [join(root, "README.md")],
      server: "fixture",
      tool: "read_file",
      rawArguments: {},
    }, { effect: "ask", reason: "test" }, {
      requestId: 1,
      sessionId: "session",
      schemaFingerprint: "schema",
    });
    for (let attempt = 0; attempt < 100 && broker.pendingCount() === 0; attempt += 1) {
      await new Promise((resolveDone) => setTimeout(resolveDone, 5));
    }
    expect(broker.pendingCount()).toBe(1);
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runApprovals({ command: "approvals", json: true }, broker.paths);
      const snapshot = String(output.mock.calls.at(-1)?.[0]);
      expect(snapshot).not.toContain("rawArguments");
      expect(snapshot).not.toContain("do-not-return");
      const approvalId = JSON.parse(snapshot)[0].approvalId as string;
      await runApprovals({ command: "approvals", json: false, approvalId, decision: "allow-once" }, broker.paths);
      expect(await result).toBe(true);
      expect(String(output.mock.calls.at(-1)?.[0])).toContain(`Resolved ${approvalId} as allow-once`);
    } finally {
      output.mockRestore();
      await broker.close();
    }
  });
});

describe("CLI entry point", () => {
  it("recognizes an npm-style symlink as the main module", () => {
    const root = mkdtempSync(join(tmpdir(), "toolfence-main-"));
    const target = join(root, "cli.js");
    const link = join(root, "toolfence");
    writeFileSync(target, "", { flag: "wx" });
    symlinkSync(target, link);

    expect(isMainModule(link, pathToFileURL(target).href)).toBe(true);
  });
});
