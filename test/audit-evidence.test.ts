import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUDIT_SCHEMA_VERSION,
  AuditLogger,
  readAudit,
  summarizeAudit,
  type AuditEvidenceContext,
} from "../src/audit.js";
import { ACTION_MODEL_VERSION, type NormalizedAction } from "../src/types.js";

describe("versioned audit evidence schema", () => {
  it("writes and strictly parses decision records with full evidence correlation", () => {
    const root = mkdtempSync(join(tmpdir(), "toolfence-audit-evidence-"));
    const auditPath = join(root, "audit.jsonl");
    const logger = new AuditLogger(auditPath);

    const action: NormalizedAction = {
      actionModelVersion: ACTION_MODEL_VERSION,
      operation: "fs.read",
      normalization: "known",
      resources: ["/workspace/src/index.ts"],
      server: "filesystem",
      tool: "read_file",
      rawArguments: { secretParam: "super-secret-argument-val" },
    };

    const evidenceContext: AuditEvidenceContext = {
      proxyRunId: "run-42",
      clientSessionId: "session-abc",
      approvalId: "appr-123",
      resolution: "allow-once",
      dispatch: "forwarded",
      host: "claude-code",
      protocolRevision: "2026-07-28",
      toolFingerprint: "fingerprint-sha256-abc",
      actionModelVersion: ACTION_MODEL_VERSION,
      policyHash: "policy-sha256-xyz",
    };

    logger.decision(
      "req-1",
      action,
      { effect: "allow", ruleId: "allow-source-read", reason: "Source reads permitted" },
      evidenceContext,
    );

    logger.result("req-1", "result-hash-123", false, true, {
      proxyRunId: "run-42",
      clientSessionId: "session-abc",
    });

    const records = readAudit(auditPath);
    expect(records).toHaveLength(2);

    const decisionRecord = records[0];
    expect(decisionRecord).toMatchObject({
      event: "decision",
      auditSchemaVersion: AUDIT_SCHEMA_VERSION,
      requestId: "req-1",
      action: {
        operation: "fs.read",
        resources: ["/workspace/src/index.ts"],
        server: "filesystem",
        tool: "read_file",
      },
      decision: {
        effect: "allow",
        ruleId: "allow-source-read",
        reason: "Source reads permitted",
      },
      proxyRunId: "run-42",
      clientSessionId: "session-abc",
      approvalId: "appr-123",
      resolution: "allow-once",
      dispatch: "forwarded",
      host: "claude-code",
      protocolRevision: "2026-07-28",
      toolFingerprint: "fingerprint-sha256-abc",
      actionModelVersion: "1.0",
      policyHash: "policy-sha256-xyz",
    });

    // Zero-leak check on serialized content
    const rawLines = readFileSync(auditPath, "utf8");
    expect(rawLines).not.toContain("rawArguments");
    expect(rawLines).not.toContain("super-secret-argument-val");

    const resultRecord = records[1];
    expect(resultRecord).toMatchObject({
      event: "result",
      auditSchemaVersion: AUDIT_SCHEMA_VERSION,
      requestId: "req-1",
      resultHash: "result-hash-123",
      error: false,
      redacted: true,
      proxyRunId: "run-42",
      clientSessionId: "session-abc",
    });

    const summary = summarizeAudit(records);
    expect(summary.events).toBe(2);
    expect(summary.decisions.allow).toBe(1);
    expect(summary.results.redacted).toBe(1);
  });

  it("smoothly reads and migrates legacy v0.3 audit records lacking schemaVersion", () => {
    const root = mkdtempSync(join(tmpdir(), "toolfence-legacy-audit-"));
    const auditPath = join(root, "legacy-audit.jsonl");

    // A valid v0.3 record without auditSchemaVersion or v0.4 evidence fields
    const legacyLine = JSON.stringify({
      timestamp: "2026-08-30T10:00:00.000Z",
      event: "decision",
      requestId: 10,
      action: {
        operation: "fs.read",
        resources: ["/workspace/README.md"],
        server: "filesystem",
        tool: "read_file",
      },
      decision: {
        effect: "allow",
        reason: "legacy default",
      },
      proxyRunId: "legacy-run",
    });

    writeFileSync(auditPath, `${legacyLine}\n`);

    const records = readAudit(auditPath);
    expect(records).toHaveLength(1);
    expect(records[0].auditSchemaVersion).toBe(1);
    expect(records[0].requestId).toBe(10);
    expect(records[0].action.operation).toBe("fs.read");
  });

  it("strictly rejects malformed or invalid auditSchemaVersion and fails closed", () => {
    const root = mkdtempSync(join(tmpdir(), "toolfence-malformed-audit-"));
    const auditPath = join(root, "invalid.jsonl");

    writeFileSync(auditPath, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "decision",
      auditSchemaVersion: -1,
      requestId: 1,
      action: {
        operation: "fs.read",
        resources: ["/workspace/test"],
        server: "fs",
        tool: "read",
      },
      decision: { effect: "deny", reason: "test" },
    })}\n`);

    expect(() => readAudit(auditPath)).toThrow(/malformed auditSchemaVersion/);
  });
});
