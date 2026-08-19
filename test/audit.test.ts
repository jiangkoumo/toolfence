import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLogger, readAudit, summarizeAudit, tailAudit } from "../src/audit.js";
import type { NormalizedAction } from "../src/types.js";

function action(operation: NormalizedAction["operation"], tool: string): NormalizedAction {
  return {
    operation,
    resources: [],
    server: "fixture",
    tool,
    rawArguments: {},
  };
}

describe("audit inspection", () => {
  it("reads, summarizes, and tails privacy-safe audit records", () => {
    const root = mkdtempSync(join(tmpdir(), "toolfence-audit-inspect-"));
    const path = join(root, "audit.jsonl");
    const logger = new AuditLogger(path);

    logger.decision(1, action("fs.read", "read_file"), { effect: "allow", reason: "policy" });
    logger.result(1, "hash-a", false);
    logger.decision(2, action("shell.exec", "execute"), { effect: "deny", reason: "policy" });
    logger.result(2, "hash-b", true);

    const records = readAudit(path);
    expect(summarizeAudit(records)).toEqual({
      events: 4,
      decisions: { total: 2, allow: 1, ask: 0, deny: 1 },
      results: { total: 2, errors: 1 },
      operations: { "fs.read": 1, "shell.exec": 1 },
    });
    expect(tailAudit(records, 2).map((record) => record.requestId)).toEqual([2, 2]);
  });

  it("reports the line containing malformed audit data", () => {
    const root = mkdtempSync(join(tmpdir(), "toolfence-audit-inspect-"));
    const path = join(root, "audit.jsonl");
    writeFileSync(path, `${JSON.stringify({ timestamp: new Date().toISOString(), event: "result", requestId: 1, resultHash: "hash", error: false })}\nnot-json\n`);

    expect(() => readAudit(path)).toThrow("Invalid audit JSON on line 2");
    expect(() => tailAudit([], 0)).toThrow("Audit tail limit must be between 1 and 10000");
    expect(() => tailAudit([], 10_001)).toThrow("Audit tail limit must be between 1 and 10000");
  });

  it("returns only the documented privacy-safe fields", () => {
    const root = mkdtempSync(join(tmpdir(), "toolfence-audit-inspect-"));
    const path = join(root, "audit.jsonl");
    writeFileSync(path, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "decision",
      requestId: 1,
      action: {
        operation: "fs.read",
        resources: ["/workspace/README.md"],
        server: "fixture",
        tool: "read_file",
        rawArguments: { secret: "do-not-return" },
      },
      decision: { effect: "allow", reason: "test" },
      unexpected: "do-not-return",
    })}\n`);

    const serialized = JSON.stringify(readAudit(path));
    expect(serialized).not.toContain("rawArguments");
    expect(serialized).not.toContain("do-not-return");
  });
});
