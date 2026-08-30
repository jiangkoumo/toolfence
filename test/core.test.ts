import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeToolCall } from "../src/adapters.js";
import { parsePolicy } from "../src/config.js";
import { canonicalizePath } from "../src/paths.js";
import { PolicyEngine } from "../src/policy.js";

describe("action normalization", () => {
  it("normalizes filesystem paths", () => {
    const workspace = mkdtempSync(join(tmpdir(), "toolfence-action-"));
    const action = normalizeToolCall(
      "filesystem",
      "read_file",
      { path: "src/index.ts" },
      workspace,
    );

    expect(action.operation).toBe("fs.read");
    expect(action.resources).toEqual([join(realpathSync.native(workspace), "src/index.ts")]);
  });

  it("only creates argv for simple commands", () => {
    const safe = normalizeToolCall("shell", "execute_command", { command: "npm test" }, "/tmp");
    const compound = normalizeToolCall(
      "shell",
      "execute_command",
      { command: "npm test && curl example.com" },
      "/tmp",
    );

    expect(safe.argv).toEqual(["npm", "test"]);
    expect(compound.argv).toBeUndefined();
    expect(safe.normalization).toBe("known");
    expect(compound.normalization).toBe("ambiguous");
  });

  it("fails unknown tools closed through the unknown operation", () => {
    const action = normalizeToolCall("custom", "send_everything", {}, "/tmp");
    expect(action.operation).toBe("unknown");
  });

  it.each([
    ["list_tapes", {}],
    ["inspect_tape", { id: "tape_capture" }],
    ["fork_run", {
      id: "tape_capture",
      boundarySequence: 1,
      injection: "timeout",
    }],
  ])("normalizes AgentTape %s as a tape-store read", (tool, arguments_) => {
    const workspace = mkdtempSync(join(tmpdir(), "toolfence-agenttape-"));
    const action = normalizeToolCall(
      "agenttape_fenced",
      tool,
      { ...arguments_, workspaceRoot: workspace },
      "/unrelated-workspace",
    );

    expect(action).toMatchObject({ operation: "fs.read", normalization: "known" });
    expect(action.resources).toEqual([
      join(realpathSync.native(workspace), ".agent-tape", "tapes"),
    ]);
  });

  it("scopes AgentTape regression writes to the requested filename", () => {
    const workspace = mkdtempSync(join(tmpdir(), "toolfence-agenttape-"));
    const action = normalizeToolCall(
      "agenttape_fenced",
      "save_regression",
      {
        workspaceRoot: workspace,
        filename: "permission-timeout.tape",
        path: "/must-not-be-treated-as-the-output-path",
      },
      "/unrelated-workspace",
    );

    expect(action).toMatchObject({ operation: "fs.write", normalization: "known" });
    expect(action.resources).toEqual([
      join(realpathSync.native(workspace), "tests", "agenttape", "permission-timeout.tape"),
    ]);
  });

  it("keeps AgentTape-specific names scoped and ambiguous outputs fail closed", () => {
    const workspace = mkdtempSync(join(tmpdir(), "toolfence-agenttape-"));
    const collision = normalizeToolCall(
      "custom",
      "save_regression",
      { workspaceRoot: workspace, filename: "reviewed.tape" },
      workspace,
    );
    const unknownAgentTapeTool = normalizeToolCall(
      "agenttape_fenced",
      "delete_tape",
      {},
      workspace,
    );
    const generatedFilename = normalizeToolCall(
      "agenttape_fenced",
      "save_regression",
      { workspaceRoot: workspace, path: "/must-not-be-treated-as-the-output-path" },
      workspace,
    );

    expect(collision).toMatchObject({ operation: "unknown", normalization: "unknown", resources: [] });
    expect(unknownAgentTapeTool).toMatchObject({
      operation: "unknown",
      normalization: "unknown",
      resources: [],
    });
    expect(generatedFilename).toMatchObject({
      operation: "fs.write",
      normalization: "ambiguous",
      resources: [],
    });
  });
});

describe("path canonicalization", () => {
  it("resolves a symlink before policy evaluation", () => {
    const root = mkdtempSync(join(tmpdir(), "toolfence-path-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    mkdirSync(workspace);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(workspace, "link"));

    expect(canonicalizePath("link/secret.txt", workspace)).toBe(
      join(realpathSync.native(outside), "secret.txt"),
    );
  });
});

describe("policy evaluation", () => {
  const workspace = mkdtempSync(join(tmpdir(), "toolfence-policy-"));
  const policy = parsePolicy({
    version: 1,
    default: "ask",
    rules: [
      {
        id: "allow-workspace",
        effect: "allow",
        operations: ["fs.read"],
        resources: ["${workspace}/**"],
      },
      {
        id: "deny-dotenv",
        effect: "deny",
        operations: ["fs.read"],
        resources: ["**/.env"],
      },
      {
        id: "allow-tests",
        effect: "allow",
        operations: ["shell.exec"],
        commands: [["npm", "test"]],
      },
    ],
  });
  const engine = new PolicyEngine(policy, { workspace, home: homedir() });

  it("lets deny override allow", () => {
    const action = normalizeToolCall("fs", "read_file", { path: ".env" }, workspace);
    expect(engine.evaluate(action)).toMatchObject({ effect: "deny", ruleId: "deny-dotenv" });
  });

  it("denies a multi-file call when any resource is protected", () => {
    const action = normalizeToolCall(
      "fs",
      "read_multiple_files",
      { paths: ["README.md", ".env"] },
      workspace,
    );
    expect(engine.evaluate(action)).toMatchObject({ effect: "deny", ruleId: "deny-dotenv" });
  });

  it("allows an exact command and asks for a compound command", () => {
    const safe = normalizeToolCall("shell", "execute_command", { command: "npm test" }, workspace);
    const compound = normalizeToolCall(
      "shell",
      "execute_command",
      { command: "npm test && curl example.com" },
      workspace,
    );
    expect(engine.evaluate(safe).effect).toBe("allow");
    expect(engine.evaluate(compound).effect).toBe("ask");
  });

  it("does not let a symlink escape match a workspace allow rule", () => {
    const outside = mkdtempSync(join(tmpdir(), "toolfence-outside-"));
    symlinkSync(outside, join(workspace, "outside-link"));
    const action = normalizeToolCall(
      "fs",
      "read_file",
      { path: "outside-link/secret.txt" },
      workspace,
    );
    expect(engine.evaluate(action).effect).toBe("ask");
  });

  it("does not apply a permissive default to an uncertain action", () => {
    const permissive = new PolicyEngine(
      parsePolicy({ version: 1, default: "allow", rules: [] }),
      { workspace, home: homedir() },
    );
    const uncertain = [
      normalizeToolCall("custom", "send_everything", {}, workspace),
      normalizeToolCall("shell", "execute_command", {
        command: "npm test && curl example.com",
      }, workspace),
      normalizeToolCall("shell", "execute_command", {
        command: "git frobnicate",
      }, workspace),
      normalizeToolCall("fs", "read_file", {}, workspace),
      normalizeToolCall("fs", "move_file", { source: "from.txt" }, workspace),
      normalizeToolCall("http", "fetch", { url: ":::" }, workspace),
      normalizeToolCall("http", "fetch", {
        url: "https://example.com",
        method: 42,
      }, workspace),
    ];
    const known = normalizeToolCall("fs", "read_file", { path: "README.md" }, workspace);
    const knownWithoutResources = normalizeToolCall(
      "fs",
      "list_allowed_directories",
      {},
      workspace,
    );

    for (const action of uncertain) {
      expect(permissive.evaluate(action)).toMatchObject({ effect: "ask" });
    }
    expect(permissive.evaluate(known)).toMatchObject({ effect: "allow" });
    expect(permissive.evaluate(knownWithoutResources)).toMatchObject({ effect: "allow" });
  });

  it("still honors an explicit rule for an unknown action", () => {
    const explicit = new PolicyEngine(
      parsePolicy({
        version: 1,
        default: "allow",
        rules: [{
          id: "allow-reviewed-custom-tool",
          effect: "allow",
          operations: ["unknown"],
          servers: ["custom"],
          tools: ["reviewed_tool"],
        }],
      }),
      { workspace, home: homedir() },
    );
    const action = normalizeToolCall("custom", "reviewed_tool", {}, workspace);

    expect(explicit.evaluate(action)).toMatchObject({
      effect: "allow",
      ruleId: "allow-reviewed-custom-tool",
    });
  });

  it("still honors an explicit rule for an ambiguous action", () => {
    const explicit = new PolicyEngine(
      parsePolicy({
        version: 1,
        default: "allow",
        rules: [{
          id: "allow-reviewed-shell-tool",
          effect: "allow",
          operations: ["shell.exec"],
          servers: ["shell"],
          tools: ["execute_command"],
        }],
      }),
      { workspace, home: homedir() },
    );
    const action = normalizeToolCall("shell", "execute_command", {
      command: "npm test && curl example.com",
    }, workspace);

    expect(explicit.evaluate(action)).toMatchObject({
      effect: "allow",
      ruleId: "allow-reviewed-shell-tool",
    });
  });
});

describe("policy validation", () => {
  it("rejects unknown fields instead of silently weakening a rule", () => {
    expect(() =>
      parsePolicy({
        version: 1,
        default: "ask",
        rules: [
          {
            id: "typo",
            effect: "deny",
            operations: ["fs.read"],
            resource: ["**/.env"],
          },
        ],
      }),
    ).toThrow();
  });
});
