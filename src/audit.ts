import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ApprovalResolution } from "./approval.js";
import { operations, type Decision, type JsonRpcId, type NormalizedAction } from "./types.js";

export type AuditDispatch = "forwarded" | "not-forwarded";

export interface AuditCorrelation {
  proxyRunId?: string;
  clientSessionId?: string;
}

export interface AuditDecisionContext extends AuditCorrelation {
  approvalId?: string;
  resolution?: ApprovalResolution;
  dispatch?: AuditDispatch;
}

export type AuditEvent =
  | {
      event: "decision";
      requestId: JsonRpcId;
      action: Pick<
        NormalizedAction,
        "operation" | "resources" | "server" | "tool" | "executable"
      >;
      decision: Decision;
    } & AuditDecisionContext
  | {
      event: "result";
      requestId: JsonRpcId;
      resultHash: string;
      error: boolean;
      redacted?: boolean;
    } & AuditCorrelation;

export type AuditRecord = AuditEvent & { timestamp: string };

export interface AuditSummary {
  events: number;
  decisions: {
    total: number;
    allow: number;
    ask: number;
    deny: number;
  };
  results: {
    total: number;
    errors: number;
    redacted?: number;
  };
  operations: Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRequestId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" || typeof value === "number";
}

function isApprovalResolution(value: unknown): value is ApprovalResolution {
  return value === "allow-once" || value === "allow-session" || value === "deny";
}

function isAuditDispatch(value: unknown): value is AuditDispatch {
  return value === "forwarded" || value === "not-forwarded";
}

function parseAuditCorrelation(value: Record<string, unknown>, lineNumber: number): AuditCorrelation {
  if (
    (value.proxyRunId !== undefined && typeof value.proxyRunId !== "string") ||
    (value.clientSessionId !== undefined && typeof value.clientSessionId !== "string")
  ) {
    throw new Error(`Invalid audit record on line ${lineNumber}`);
  }
  return {
    ...(value.proxyRunId !== undefined ? { proxyRunId: value.proxyRunId as string } : {}),
    ...(value.clientSessionId !== undefined ? { clientSessionId: value.clientSessionId as string } : {}),
  };
}

function parseAuditRecord(line: string, lineNumber: number): AuditRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`Invalid audit JSON on line ${lineNumber}`);
  }
  if (!isRecord(value) || typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp))) {
    throw new Error(`Invalid audit record on line ${lineNumber}`);
  }
  if (value.event === "decision") {
    const correlation = parseAuditCorrelation(value, lineNumber);
    if (!isRecord(value.action) || !isRecord(value.decision)) {
      throw new Error(`Invalid decision audit record on line ${lineNumber}`);
    }
    const effect = value.decision.effect;
    if (
      !isRequestId(value.requestId) ||
      !operations.includes(value.action.operation as NormalizedAction["operation"]) ||
      !Array.isArray(value.action.resources) ||
      !value.action.resources.every((resource) => typeof resource === "string") ||
      typeof value.action.server !== "string" ||
      typeof value.action.tool !== "string" ||
      (value.action.executable !== undefined && typeof value.action.executable !== "string") ||
      (effect !== "allow" && effect !== "ask" && effect !== "deny") ||
      typeof value.decision.reason !== "string" ||
      (value.decision.ruleId !== undefined && typeof value.decision.ruleId !== "string") ||
      (value.approvalId !== undefined && typeof value.approvalId !== "string") ||
      (value.resolution !== undefined && !isApprovalResolution(value.resolution)) ||
      (value.dispatch !== undefined && !isAuditDispatch(value.dispatch))
    ) {
      throw new Error(`Invalid decision audit record on line ${lineNumber}`);
    }
    return {
      timestamp: value.timestamp,
      event: "decision",
      requestId: value.requestId,
      action: {
        operation: value.action.operation as NormalizedAction["operation"],
        resources: value.action.resources as string[],
        server: value.action.server,
        tool: value.action.tool,
        executable: value.action.executable as string | undefined,
      },
      decision: {
        effect,
        reason: value.decision.reason,
        ruleId: value.decision.ruleId as string | undefined,
      },
      ...correlation,
      ...(value.approvalId !== undefined ? { approvalId: value.approvalId as string } : {}),
      ...(value.resolution !== undefined ? { resolution: value.resolution as ApprovalResolution } : {}),
      ...(value.dispatch !== undefined ? { dispatch: value.dispatch as AuditDispatch } : {}),
    };
  }
  if (value.event === "result") {
    const correlation = parseAuditCorrelation(value, lineNumber);
    if (
      !isRequestId(value.requestId) ||
      typeof value.resultHash !== "string" ||
      typeof value.error !== "boolean" ||
      (value.redacted !== undefined && typeof value.redacted !== "boolean")
    ) {
      throw new Error(`Invalid result audit record on line ${lineNumber}`);
    }
    return {
      timestamp: value.timestamp,
      event: "result",
      requestId: value.requestId,
      resultHash: value.resultHash,
      error: value.error,
      ...(value.redacted !== undefined ? { redacted: value.redacted as boolean } : {}),
      ...correlation,
    };
  }
  throw new Error(`Unknown audit event on line ${lineNumber}`);
}

export function readAudit(filePath: string): AuditRecord[] {
  const content = readFileSync(resolve(filePath), "utf8");
  return content
    .split(/\r?\n/)
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => line.trim().length > 0)
    .map(({ line, lineNumber }) => parseAuditRecord(line, lineNumber));
}

export function tailAudit(records: AuditRecord[], limit = 20): AuditRecord[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error("Audit tail limit must be between 1 and 10000");
  }
  return records.slice(-limit);
}

export function summarizeAudit(records: AuditRecord[]): AuditSummary {
  const summary: AuditSummary = {
    events: records.length,
    decisions: { total: 0, allow: 0, ask: 0, deny: 0 },
    results: { total: 0, errors: 0, redacted: 0 },
    operations: {},
  };
  for (const record of records) {
    if (record.event === "decision") {
      summary.decisions.total += 1;
      summary.decisions[record.decision.effect] += 1;
      summary.operations[record.action.operation] = (summary.operations[record.action.operation] ?? 0) + 1;
    } else {
      summary.results.total += 1;
      if (record.error) summary.results.errors += 1;
      if (record.redacted) summary.results.redacted = (summary.results.redacted ?? 0) + 1;
    }
  }
  summary.operations = Object.fromEntries(
    Object.entries(summary.operations).sort(([left], [right]) => left.localeCompare(right)),
  );
  return summary;
}

export class AuditLogger {
  readonly path: string;

  constructor(filePath: string) {
    this.path = resolve(filePath);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const fd = openSync(this.path, "a", 0o600);
    closeSync(fd);
    if (process.platform !== "win32") chmodSync(this.path, 0o600);
  }

  decision(
    requestId: JsonRpcId,
    action: NormalizedAction,
    decision: Decision,
    context?: AuditDecisionContext,
  ): void {
    const safeAction = {
      operation: action.operation,
      resources: action.resources,
      server: action.server,
      tool: action.tool,
      executable: action.executable,
    };
    this.write({ event: "decision", requestId, action: safeAction, decision, ...context });
  }

  result(
    requestId: JsonRpcId,
    resultHash: string,
    error: boolean,
    redacted?: boolean,
    correlation?: AuditCorrelation,
  ): void {
    this.write({
      event: "result",
      requestId,
      resultHash,
      error,
      ...(redacted ? { redacted: true } : {}),
      ...correlation,
    });
  }

  private write(event: AuditEvent): void {
    appendFileSync(
      this.path,
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }
}
