import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { diagnose, formatDoctorReport } from "../src/doctor.js";
import { startBroker } from "../src/broker.js";
import { initPolicy } from "../src/config.js";
import { parseCli } from "../src/cli.js";

describe("doctor CLI", () => {
  it("parses optional checks and an explicit upstream probe", () => {
    expect(parseCli([
      "doctor",
      "--policy", "policy.yaml",
      "--workspace", ".",
      "--json",
      "--",
      process.execPath,
      "--version",
    ])).toEqual({
      command: "doctor",
      json: true,
      policy: resolve("policy.yaml"),
      workspace: resolve("."),
      upstreamCommand: process.execPath,
      args: ["--version"],
    });
    expect(() => parseCli(["doctor", "--"])).toThrow("Expected an upstream command after '--'");
    expect(() => parseCli(["doctor", "--audit", "audit.jsonl"])).toThrow("Unknown option for doctor: --audit");
  });

  it("reports a valid policy and optional inactive checks without failing", async () => {
    const root = mkdtempSync(join(tmpdir(), "toolfence-doctor-"));
    const policy = join(root, "policy.yaml");
    initPolicy(policy);
    const report = await diagnose({ policy, workspace: root, args: [] }, {
      brokerPaths: {
        runtimeDir: join(root, "run"),
        socketPath: join(root, "run", "broker.sock"),
        tokenPath: join(root, "home", ".toolfence", "broker.token"),
      },
    });

    expect(report.ok).toBe(true);
    expect(report.checks).toMatchObject([
      { check: "node", status: "pass" },
      { check: "policy", status: "pass" },
      { check: "broker", status: "warn" },
      { check: "upstream", status: "warn" },
    ]);
    expect(formatDoctorReport(report)).toContain("Summary: 2 passed, 2 warnings, 0 failed");
  });

  it("fails unsupported Node.js and invalid Policy checks", async () => {
    const root = mkdtempSync(join(tmpdir(), "toolfence-doctor-"));
    const report = await diagnose({
      policy: join(root, "missing-policy.yaml"),
      workspace: root,
      args: [],
    }, {
      nodeVersion: "18.20.0",
      platform: "win32",
    });

    expect(report.ok).toBe(false);
    expect(report.checks.slice(0, 2)).toMatchObject([
      { check: "node", status: "fail" },
      { check: "policy", status: "fail" },
    ]);
  });

  it("passes a healthy startup probe and fails a missing executable", async () => {
    const root = mkdtempSync(join(tmpdir(), "toolfence-doctor-"));
    const paths = {
      runtimeDir: join(root, "run"),
      socketPath: join(root, "run", "broker.sock"),
      tokenPath: join(root, "home", ".toolfence", "broker.token"),
    };
    const healthy = await diagnose({
      workspace: root,
      upstreamCommand: process.execPath,
      args: ["--version"],
    }, { brokerPaths: paths });
    const staying = await diagnose({
      workspace: root,
      upstreamCommand: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
    }, { brokerPaths: paths, startupTimeoutMs: 20 });
    const missing = await diagnose({
      workspace: root,
      upstreamCommand: join(root, "missing-command"),
      args: [],
    }, { brokerPaths: paths });

    expect(healthy.checks.at(-1)).toMatchObject({ check: "upstream", status: "pass" });
    expect(healthy.ok).toBe(true);
    expect(staying.checks.at(-1)).toMatchObject({ check: "upstream", status: "pass" });
    expect(missing.checks.at(-1)).toMatchObject({ check: "upstream", status: "fail" });
    expect(missing.ok).toBe(false);
  });

  it("checks a live Broker and rejects insecure local permissions", async () => {
    const root = mkdtempSync(join(tmpdir(), "toolfence-doctor-"));
    const paths = {
      runtimeDir: join(root, "run"),
      socketPath: join(root, "run", "broker.sock"),
      tokenPath: join(root, "home", ".toolfence", "broker.token"),
    };
    const broker = await startBroker(paths);
    try {
      const healthy = await diagnose({ workspace: root, args: [] }, { brokerPaths: broker.paths });
      expect(healthy.checks.find((check) => check.check === "broker")).toMatchObject({ status: "pass" });

      chmodSync(broker.paths.tokenPath, 0o644);
      const insecure = await diagnose({ workspace: root, args: [] }, { brokerPaths: broker.paths });
      expect(insecure.checks.find((check) => check.check === "broker")).toMatchObject({ status: "fail" });
      expect(insecure.ok).toBe(false);
    } finally {
      await broker.close();
    }
  });
});
