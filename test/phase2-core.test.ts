import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeToolCall } from "../src/adapters.js";
import { AuditLogger } from "../src/audit.js";
import { parseCli } from "../src/cli.js";
import { parsePolicy } from "../src/config.js";
import { PolicyEngine } from "../src/policy.js";
import { checkPolicy, explainPolicy, testPolicy } from "../src/policy-tools.js";
import { toolSchemaFingerprint } from "../src/schema.js";

describe("phase 2 action adapters", () => {
  it.each([
    ["git status", "git.read"],
    ["git log --oneline", "git.read"],
    ["git branch --list", "git.read"],
    ["git remote -v", "git.read"],
    ["git commit -m test", "git.write"],
    ["git branch new-feature", "git.write"],
    ["git branch -D old", "git.write"],
    ["git push origin main", "git.remote"],
    ["git remote add origin https://example.test/repo", "git.remote"],
  ])("classifies %s as %s", (command, operation) => {
    expect(normalizeToolCall("shell", "execute_command", { command }, "/tmp").operation)
      .toBe(operation);
  });

  it("does not downgrade ambiguous or compound Git commands", () => {
    expect(normalizeToolCall("shell", "execute_command", { command: "git frobnicate" }, "/tmp").operation)
      .toBe("shell.exec");
    expect(normalizeToolCall("shell", "execute_command", { command: "git status && git push" }, "/tmp").operation)
      .toBe("shell.exec");
  });

  it("normalizes HTTP URL fields without credentials, ports, or paths in host", () => {
    const action = normalizeToolCall(
      "http",
      "http_request",
      { url: "https://user:pass@API.Example.com:8443/v1/items?q=1", method: "post" },
      "/tmp",
    );
    expect(action.operation).toBe("net.request");
    expect(action.network).toMatchObject({
      host: "api.example.com",
      method: "POST",
      scheme: "https",
    });
    expect(action.network?.url).toContain("/v1/items?q=1");
  });

  it("fails invalid and non-HTTP URLs closed", () => {
    expect(normalizeToolCall("http", "fetch", { url: ":::" }, "/tmp").operation).toBe("unknown");
    expect(normalizeToolCall("http", "fetch", { url: "file:///etc/passwd" }, "/tmp").operation)
      .toBe("unknown");
  });
});

describe("phase 2 policy rules", () => {
  it("matches HTTP host wildcards and methods together", () => {
    const policy = parsePolicy({
      version: 1,
      default: "deny",
      rules: [{
        id: "read-api",
        effect: "allow",
        operations: ["net.request"],
        hosts: ["*.example.com"],
        methods: ["get", "head"],
      }],
    });
    const engine = new PolicyEngine(policy, { workspace: "/tmp", home: "/tmp" });
    const get = normalizeToolCall("http", "fetch", { url: "https://api.example.com/v1" }, "/tmp");
    const post = normalizeToolCall(
      "http",
      "fetch",
      { url: "https://api.example.com/v1", method: "POST" },
      "/tmp",
    );
    expect(engine.evaluate(get)).toMatchObject({ effect: "allow", ruleId: "read-api" });
    expect(engine.evaluate(post).effect).toBe("deny");
  });

  it("rejects network-only fields on unrelated operations", () => {
    expect(() => parsePolicy({
      version: 1,
      default: "ask",
      rules: [{ id: "bad", effect: "allow", operations: ["fs.read"], hosts: ["example.com"] }],
    })).toThrow(/hosts and methods/);
  });
});

describe("phase 2 safety utilities", () => {
  it("tightens an existing audit file to 0600 and omits raw data", () => {
    const root = mkdtempSync(join(tmpdir(), "toolfence-audit-"));
    const path = join(root, "audit.jsonl");
    writeFileSync(path, "");
    chmodSync(path, 0o666);
    const logger = new AuditLogger(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    logger.decision(1, normalizeToolCall("shell", "execute_command", {
      command: "echo top-secret",
    }, root), { effect: "deny", reason: "test" });
    expect(readFileSync(path, "utf8")).not.toContain("top-secret");
  });

  it("only recognizes ToolFence help/version before the separator", () => {
    const parsed = parseCli([
      "wrap", "--policy", "policy.yaml", "--", "upstream", "--help", "--version",
    ]);
    expect(parsed).toMatchObject({
      command: "wrap",
      upstreamCommand: "upstream",
      args: ["--help", "--version"],
    });
  });

  it("computes stable fingerprints independent of object key order", () => {
    const first = toolSchemaFingerprint({
      name: "read",
      description: "read",
      inputSchema: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } },
    });
    const second = toolSchemaFingerprint({
      inputSchema: { properties: { b: { type: "number" }, a: { type: "string" } }, type: "object" },
      description: "read",
      name: "read",
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("policy development commands", () => {
  it("checks, explains, and executes declarative cases", () => {
    const root = mkdtempSync(join(tmpdir(), "toolfence-policy-tools-"));
    const policyPath = join(root, "policy.yaml");
    const actionPath = join(root, "action.json");
    const casesPath = join(root, "cases.yaml");
    writeFileSync(policyPath, [
      "version: 1",
      "default: deny",
      "rules:",
      "  - id: allow-status",
      "    effect: allow",
      "    operations: [git.read]",
    ].join("\n"));
    writeFileSync(actionPath, JSON.stringify({
      operation: "git.read",
      resources: [],
      server: "git",
      tool: "git",
      rawArguments: {},
      argv: ["git", "status"],
    }));
    writeFileSync(casesPath, [
      "cases:",
      "  - name: status",
      "    server: shell",
      "    tool: execute_command",
      "    arguments: { command: git status }",
      "    expect: { effect: allow, ruleId: allow-status }",
    ].join("\n"));
    expect(checkPolicy(policyPath)).toContain("Policy is valid");
    expect(explainPolicy(policyPath, actionPath, root)).toContain('"allow-status"');
    expect(testPolicy(policyPath, casesPath)).toMatchObject({ passed: 1, failed: 0 });
  });
});
