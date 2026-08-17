import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCli } from "../src/cli.js";
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
