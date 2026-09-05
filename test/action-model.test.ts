import { describe, expect, it } from "vitest";
import { normalizeToolCall } from "../src/adapters.js";
import { PolicyEngine } from "../src/policy.js";
import { ACTION_MODEL_VERSION, type NormalizedAction, type PolicyConfig } from "../src/types.js";

describe("versioned action model & conservative downgrade", () => {
  const workspace = "/workspace";
  const home = "/home/user";

  it("ensures every adapter emits the current ACTION_MODEL_VERSION", () => {
    const fsAction = normalizeToolCall("fs", "read_file", { path: "README.md" }, workspace);
    expect(fsAction.actionModelVersion).toBe(ACTION_MODEL_VERSION);
    expect(fsAction.operation).toBe("fs.read");

    const shellAction = normalizeToolCall("sh", "execute_command", { command: "ls -la" }, workspace);
    expect(shellAction.actionModelVersion).toBe(ACTION_MODEL_VERSION);
    expect(shellAction.operation).toBe("shell.exec");

    const gitAction = normalizeToolCall("git", "git", { command: "git status" }, workspace);
    expect(gitAction.actionModelVersion).toBe(ACTION_MODEL_VERSION);
    expect(gitAction.operation).toBe("git.read");

    const httpAction = normalizeToolCall("web", "fetch", { url: "https://example.com" }, workspace);
    expect(httpAction.actionModelVersion).toBe(ACTION_MODEL_VERSION);
    expect(httpAction.operation).toBe("net.request");

    const tapeAction = normalizeToolCall("agenttape", "list_tapes", {}, workspace);
    expect(tapeAction.actionModelVersion).toBe(ACTION_MODEL_VERSION);
    expect(tapeAction.operation).toBe("fs.read");

    const unknownAction = normalizeToolCall("custom", "mystery_tool", {}, workspace);
    expect(unknownAction.actionModelVersion).toBe(ACTION_MODEL_VERSION);
    expect(unknownAction.operation).toBe("unknown");
  });

  it("evaluates actions normally when actionModelVersion matches", () => {
    const policy: PolicyConfig = {
      version: 1,
      default: "deny",
      rules: [
        {
          id: "allow-reads",
          effect: "allow",
          operations: ["fs.read"],
        },
      ],
    };
    const engine = new PolicyEngine(policy, { workspace, home });
    const action = normalizeToolCall("fs", "read_file", { path: "README.md" }, workspace);

    const decision = engine.evaluate(action);
    expect(decision.effect).toBe("allow");
    expect(decision.ruleId).toBe("allow-reads");
  });

  it("conservatively downgrades unsupported action model versions to unknown and asks under default: allow", () => {
    const policy: PolicyConfig = {
      version: 1,
      default: "allow",
      rules: [
        {
          id: "allow-all-reads",
          effect: "allow",
          operations: ["fs.read"],
        },
      ],
    };
    const engine = new PolicyEngine(policy, { workspace, home });

    // An action purporting to be fs.read but stamped with an unknown/future version "2.0"
    const futureAction: NormalizedAction = {
      actionModelVersion: "2.0" as typeof ACTION_MODEL_VERSION,
      operation: "fs.read",
      normalization: "known",
      resources: ["/workspace/secret.txt"],
      server: "fs",
      tool: "read_file",
      rawArguments: { path: "secret.txt" },
    };

    const decision = engine.evaluate(futureAction);
    // Invariant: unsupported action model version must never inherit allow or match specific rules
    expect(decision.effect).toBe("ask");
    expect(decision.ruleId).toBeUndefined();
    expect(decision.reason).toContain("Unsupported action model version 2.0");

    const explanation = engine.explain(futureAction);
    expect(explanation.action.operation).toBe("unknown");
    expect(explanation.action.normalization).toBe("unknown");
    expect(explanation.matches).toEqual([]);
    expect(explanation.decision.effect).toBe("ask");
  });

  it("conservatively downgrades unsupported action model versions to deny under default: deny", () => {
    const policy: PolicyConfig = {
      version: 1,
      default: "deny",
      rules: [
        {
          id: "allow-reads",
          effect: "allow",
          operations: ["fs.read"],
        },
      ],
    };
    const engine = new PolicyEngine(policy, { workspace, home });

    const futureAction: NormalizedAction = {
      actionModelVersion: "99.0" as typeof ACTION_MODEL_VERSION,
      operation: "fs.read",
      normalization: "known",
      resources: ["/workspace/file.txt"],
      server: "fs",
      tool: "read_file",
      rawArguments: {},
    };

    const decision = engine.evaluate(futureAction);
    expect(decision.effect).toBe("deny");
    expect(decision.ruleId).toBeUndefined();
    expect(decision.reason).toContain("Unsupported action model version 99.0");
  });

  it("never matches an allow rule for 'unknown' operations when action model version is unsupported", () => {
    const policy: PolicyConfig = {
      version: 1,
      default: "deny",
      rules: [
        {
          id: "allow-explicit-unknown",
          effect: "allow",
          operations: ["unknown"],
        },
      ],
    };
    const engine = new PolicyEngine(policy, { workspace, home });

    const highRiskFutureAction: NormalizedAction = {
      actionModelVersion: "2.0" as typeof ACTION_MODEL_VERSION,
      operation: "shell.exec",
      normalization: "known",
      resources: [],
      server: "sh",
      tool: "exec",
      rawArguments: { command: "rm -rf /" },
    };

    const decision = engine.evaluate(highRiskFutureAction);
    expect(decision.effect).toBe("deny");
    expect(decision.ruleId).toBeUndefined();
    expect(decision.reason).toContain("Unsupported action model version 2.0");

    const explanation = engine.explain(highRiskFutureAction);
    expect(explanation.matches).toEqual([]);
    expect(explanation.decision.effect).toBe("deny");
  });
});
