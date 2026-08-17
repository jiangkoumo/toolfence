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
  });

  it("fails unknown tools closed through the unknown operation", () => {
    const action = normalizeToolCall("custom", "send_everything", {}, "/tmp");
    expect(action.operation).toBe("unknown");
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
