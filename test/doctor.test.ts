import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
      conformanceRoot: join(root, "no-conformance"),
    });

    expect(report.ok).toBe(true);
    expect(report.checks).toMatchObject([
      { check: "node", status: "pass" },
      { check: "policy", status: "pass" },
      { check: "broker", status: "warn" },
      { check: "upstream", status: "warn" },
      { check: "conformance", status: "warn" },
    ]);
    expect(formatDoctorReport(report)).toContain("Summary: 2 passed, 3 warnings, 0 failed");
  });

  it("reports the shipped conformance matrix with its evidence status", async () => {
    const root = mkdtempSync(join(tmpdir(), "toolfence-doctor-"));
    const report = await diagnose({
      workspace: root,
      args: [],
    }, {
      conformanceRoot: resolve("."),
    });
    const conformance = report.checks.find((check) => check.check === "conformance");
    expect(conformance).toBeDefined();
    expect(conformance!.message).toContain("supported");
    expect(conformance!.message).toContain("fail-closed");
    expect(report.ok).toBe(true);
  });

  it("warns when conformance evidence targets a different version or matrix revision", async () => {
    const root = mkdtempSync(join(tmpdir(), "toolfence-doctor-"));
    const conformanceDir = join(root, "conformance");
    mkdirSync(conformanceDir, { recursive: true });
    const matrix = {
      matrixVersion: 2,
      toolfenceVersion: "0.0.1",
      rows: [{ id: "row-a", status: "supported", style: "legacy", mcpProtocol: ["2025-06-18"] }],
    };
    const reportJson = {
      matrixVersion: 1,
      generatedAt: "2026-08-31T00:00:00.000Z",
      rows: [{ id: "row-a", revision: "2025-06-18", status: "pass" }],
    };
    writeFileSync(join(conformanceDir, "matrix.json"), `${JSON.stringify(matrix)}\n`);
    writeFileSync(join(conformanceDir, "report.json"), `${JSON.stringify(reportJson)}\n`);
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { version: string };

    const versionMismatch = await diagnose({ workspace: root, args: [] }, { conformanceRoot: root });
    const check = versionMismatch.checks.find((candidate) => candidate.check === "conformance");
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain(`package is ${packageJson.version}`);

    const alignedMatrix = { ...matrix, toolfenceVersion: packageJson.version };
    writeFileSync(join(conformanceDir, "matrix.json"), `${JSON.stringify(alignedMatrix)}\n`);
    const staleReport = await diagnose({ workspace: root, args: [] }, { conformanceRoot: root });
    const staleCheck = staleReport.checks.find((candidate) => candidate.check === "conformance");
    expect(staleCheck?.status).toBe("warn");
    expect(staleCheck?.message).toContain("stale");
    expect(staleReport.ok).toBe(true);
  });

  it("warns when the matrix or report omits binding identity fields", async () => {
    const root = mkdtempSync(join(tmpdir(), "toolfence-doctor-"));
    const conformanceDir = join(root, "conformance");
    mkdirSync(conformanceDir, { recursive: true });
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { version: string };
    const baseMatrix = {
      matrixVersion: 1,
      toolfenceVersion: packageJson.version,
      rows: [{ id: "row-a", status: "supported", style: "legacy", mcpProtocol: ["2025-06-18"] }],
    };
    const baseReport = {
      matrixVersion: 1,
      generatedAt: "2026-08-31T00:00:00.000Z",
      rows: [{ id: "row-a", revision: "2025-06-18", status: "pass" }],
    };

    const checkFor = async (matrix: unknown, report: unknown) => {
      writeFileSync(join(conformanceDir, "matrix.json"), `${JSON.stringify(matrix)}\n`);
      writeFileSync(join(conformanceDir, "report.json"), `${JSON.stringify(report)}\n`);
      const run = await diagnose({ workspace: root, args: [] }, { conformanceRoot: root });
      return run.checks.find((candidate) => candidate.check === "conformance");
    };

    const noMatrixVersion = await checkFor(
      { ...baseMatrix, matrixVersion: undefined },
      baseReport,
    );
    expect(noMatrixVersion?.status).toBe("warn");
    expect(noMatrixVersion?.message).toContain("matrixVersion");

    const noToolfenceVersion = await checkFor(
      { ...baseMatrix, toolfenceVersion: undefined },
      baseReport,
    );
    expect(noToolfenceVersion?.status).toBe("warn");
    expect(noToolfenceVersion?.message).toContain("toolfenceVersion");

    const noReportMatrixVersion = await checkFor(baseMatrix, { ...baseReport, matrixVersion: undefined });
    expect(noReportMatrixVersion?.status).toBe("warn");
    expect(noReportMatrixVersion?.message).toContain("matrixVersion");
  });

  it("warns when conformance evidence is undated or misses a declared protocol revision", async () => {
    const root = mkdtempSync(join(tmpdir(), "toolfence-doctor-"));
    const conformanceDir = join(root, "conformance");
    mkdirSync(conformanceDir, { recursive: true });
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { version: string };
    const matrix = {
      matrixVersion: 1,
      toolfenceVersion: packageJson.version,
      rows: [{ id: "row-a", status: "supported", style: "legacy", mcpProtocol: ["2025-06-18", "2024-11-05"] }],
    };
    writeFileSync(join(conformanceDir, "matrix.json"), `${JSON.stringify(matrix)}\n`);

    writeFileSync(join(conformanceDir, "report.json"), `${JSON.stringify({
      matrixVersion: 1,
      rows: [{ id: "row-a", revision: "2025-06-18", status: "pass" }],
    })}\n`);
    const undated = await diagnose({ workspace: root, args: [] }, { conformanceRoot: root });
    expect(undated.checks.find((candidate) => candidate.check === "conformance")?.status).toBe("warn");
    expect(undated.checks.find((candidate) => candidate.check === "conformance")?.message).toContain("undated");

    writeFileSync(join(conformanceDir, "report.json"), `${JSON.stringify({
      matrixVersion: 1,
      generatedAt: "2026-08-31T00:00:00.000Z",
      rows: [{ id: "row-a", revision: "2025-06-18", status: "pass" }],
    })}\n`);
    const incomplete = await diagnose({ workspace: root, args: [] }, { conformanceRoot: root });
    const incompleteCheck = incomplete.checks.find((candidate) => candidate.check === "conformance");
    expect(incompleteCheck?.status).toBe("warn");
    expect(incompleteCheck?.message).toContain("incomplete");
    expect(incomplete.ok).toBe(true);
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
    }, { brokerPaths: paths, conformanceRoot: join(root, "no-conformance") });
    const staying = await diagnose({
      workspace: root,
      upstreamCommand: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
    }, { brokerPaths: paths, startupTimeoutMs: 20, conformanceRoot: join(root, "no-conformance") });
    const missing = await diagnose({
      workspace: root,
      upstreamCommand: join(root, "missing-command"),
      args: [],
    }, { brokerPaths: paths, conformanceRoot: join(root, "no-conformance") });

    expect(healthy.checks.find((check) => check.check === "upstream")).toMatchObject({ status: "pass" });
    expect(healthy.ok).toBe(true);
    expect(staying.checks.find((check) => check.check === "upstream")).toMatchObject({ status: "pass" });
    expect(missing.checks.find((check) => check.check === "upstream")).toMatchObject({ status: "fail" });
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
      const healthy = await diagnose({ workspace: root, args: [] }, {
        brokerPaths: broker.paths,
        conformanceRoot: join(root, "no-conformance"),
      });
      expect(healthy.checks.find((check) => check.check === "broker")).toMatchObject({ status: "pass" });

      chmodSync(broker.paths.tokenPath, 0o644);
      const insecure = await diagnose({ workspace: root, args: [] }, {
        brokerPaths: broker.paths,
        conformanceRoot: join(root, "no-conformance"),
      });
      expect(insecure.checks.find((check) => check.check === "broker")).toMatchObject({ status: "fail" });
      expect(insecure.ok).toBe(false);
    } finally {
      await broker.close();
    }
  });
});
