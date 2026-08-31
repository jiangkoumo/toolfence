import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { ApprovalRequester } from "../src/approval.js";
import { AuditLogger, type AuditRecord } from "../src/audit.js";
import { parsePolicy } from "../src/config.js";
import { PolicyEngine } from "../src/policy.js";
import { startProxy, type ProxyController } from "../src/proxy.js";
import {
  DECISION_CASES,
  MODERN_PROTOCOL,
  MODERN_TRACE,
  MRTR_COMPLETE,
  MRTR_INPUT_REQUIRED,
  MRTR_RETRY,
  STATUSES,
  TOOLS,
  UNVERIFIED_PROTOCOL,
  modernMeta,
  preamble,
  toolCall,
} from "../conformance/corpus.mjs";
import matrix from "../conformance/matrix.json";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const reportPath = join(repoRoot, "conformance", "report.json");

interface MatrixRow {
  id: string;
  style: "legacy" | "modern";
  transport: string;
  mcpProtocol: string[];
  node: number[];
  server: string | null;
  corpus: string;
  status: string;
}

interface DecisionCase {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  policy: () => { version: 1; default: "allow" | "ask" | "deny"; rules: unknown[] };
  approval: "reject" | "approve" | "hang";
  metaOverride?: Record<string, unknown>;
  neutralMeta?: boolean;
  expect: {
    effect?: "allow" | "ask" | "deny";
    forwarded: boolean;
    askPath?: boolean;
    noAudit?: boolean;
    resolution?: string;
  };
}

interface Harness {
  row: MatrixRow;
  revision: string;
  workspace: string;
  input: PassThrough;
  output: PassThrough;
  errors: PassThrough;
  auditPath: string;
  controller: ProxyController;
}

interface HangSignals {
  requested: Promise<void>;
  cancelled: Promise<void>;
}

interface CaseRun {
  caseId: string;
  style: "legacy" | "modern";
  revision: string;
  effect?: string;
  forwarded: boolean;
  noAudit?: boolean;
  resolution?: string;
  dispatch?: string;
  response?: Record<string, unknown>;
  captured?: { arguments?: unknown; _meta?: unknown };
}

interface RowResult {
  id: string;
  revision: string;
  status: "pass" | "fail";
  failures: string[];
  cases: Map<string, CaseRun>;
  schema: { fp1?: string; fp2?: string };
  verifiedAt: string;
}

const sleep = (ms: number) => new Promise((resolveDone) => setTimeout(resolveDone, ms));

function startHarness(
  row: MatrixRow,
  revision: string,
  approval: ApprovalRequester,
  policy: Parameters<typeof parsePolicy>[0],
): Harness {
  const workspace = mkdtempSync(join(tmpdir(), `toolfence-conformance-${row.id}-`));
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  const auditPath = join(workspace, "audit.jsonl");
  const controller = startProxy({
    command: process.execPath,
    args: [resolve(repoRoot, row.server as string)],
    cwd: workspace,
    server: `conformance/${row.id}`,
    policy: new PolicyEngine(parsePolicy(policy), { workspace, home: workspace }),
    approval,
    audit: new AuditLogger(auditPath),
    input,
    output,
    errorOutput: errors,
    approvalTimeoutMs: 2_000,
  });
  return { row, revision, workspace, input, output, errors, auditPath, controller };
}

function writeRequest(h: Harness, message: Record<string, unknown>): void {
  h.input.write(`${JSON.stringify(message)}\n`);
}

function waitForResponse(h: Harness, id: unknown, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  return new Promise((resolveDone, reject) => {
    let buffered = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for response id=${String(id)}`)), timeoutMs);
    h.output.on("data", function onData(chunk: Buffer) {
      buffered += chunk.toString("utf8");
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const message = JSON.parse(line) as Record<string, unknown>;
        if (message.id === id) {
          clearTimeout(timer);
          h.output.off("data", onData);
          resolveDone(message);
          return;
        }
        newline = buffered.indexOf("\n");
      }
    });
  });
}

async function request(h: Harness, message: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = message.id;
  writeRequest(h, message);
  return await waitForResponse(h, id);
}

async function fixtureState(h: Harness): Promise<{
  calls: Array<Record<string, unknown>>;
  sawInitialized: boolean;
}> {
  const response = await request(h, { jsonrpc: "2.0", id: "report-calls", method: "test/report-calls" });
  const result = response.result as {
    calls?: Array<Record<string, unknown>>;
    sawInitialized?: boolean;
  };
  return { calls: result.calls ?? [], sawInitialized: result.sawInitialized === true };
}

function decisions(h: Harness): AuditRecord[] {
  return readFileSync(h.auditPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditRecord)
    .filter((record) => record.event === "decision");
}

function decisionFor(h: Harness, requestId: unknown): AuditRecord | undefined {
  return decisions(h).find((record) => record.requestId === requestId);
}

// Prove the protocol preambles, tools/list, per-request _meta, and MRTR flows
// pass through transparently for this row's revision.
async function runTransparency(
  row: MatrixRow,
  revision: string,
  mkHarness: (approval: ApprovalRequester, policy: Parameters<typeof parsePolicy>[0]) => Harness,
): Promise<string[]> {
  const failures: string[] = [];
  const h = mkHarness({ request: async () => true }, { version: 1, default: "allow", rules: [] });

  for (const message of preamble(row.style, "preamble", revision)) {
    if (message.id === undefined) {
      writeRequest(h, message);
    } else {
      const response = await request(h, message);
      const result = response.result as Record<string, unknown> | undefined;
      if (row.style === "legacy") {
        if ((result as { serverInfo?: { name?: string } })?.serverInfo?.name !== "legacy-init-server") {
          failures.push("initialize response was not passed through (serverInfo lost)");
        }
        if (result?.protocolVersion !== revision) {
          failures.push(`initialize protocolVersion was not echoed (expected ${revision})`);
        }
      } else {
        if (result?.resultType !== "complete") failures.push("server/discover resultType was not passed through");
        if (!(result?.supportedVersions as string[] | undefined)?.includes(MODERN_PROTOCOL)) {
          failures.push("server/discover supportedVersions was not passed through");
        }
        if (result?.ttlMs !== 3_600_000 || result?.cacheScope !== "public") {
          failures.push("server/discover cache metadata was not passed through");
        }
      }
    }
  }

  if (row.style === "legacy") {
    const { sawInitialized } = await fixtureState(h);
    if (!sawInitialized) failures.push("notifications/initialized did not reach the upstream fixture");
  }

  const list = await request(h, { jsonrpc: "2.0", id: "list", method: "tools/list" });
  const listResult = list.result as { tools?: Array<{ name?: string }> } & Record<string, unknown>;
  const names = listResult.tools?.map((tool) => tool.name) ?? [];
  for (const tool of TOOLS) {
    if (!names.includes(tool)) failures.push(`tools/list response lost tool ${tool}`);
  }
  if (row.style === "legacy") {
    if ("ttlMs" in listResult || "cacheScope" in listResult) {
      failures.push("legacy tools/list gained cache metadata it did not send");
    }
  } else {
    if (listResult.resultType !== "complete" || listResult.ttlMs !== 60_000 || listResult.cacheScope !== "public") {
      failures.push("2026-07-28 tools/list cache metadata was not passed through");
    }
  }

  // Per-request _meta must reach the upstream unchanged (the 2026 fixture
  // rejects calls that lost _meta entirely).
  const metaCheck = await request(h, toolCall({ style: row.style, id: "meta-check", name: "read_file", args: { path: "safe.txt" } }));
  if (row.style === "modern") {
    if (metaCheck.result && (metaCheck.result as { isError?: boolean }).isError === true) {
      failures.push("per-request _meta did not survive pass-through (fixture rejected the call)");
    }
    const { calls } = await fixtureState(h);
    const captured = calls.find((call) => call.name === "read_file");
    if (!captured?._meta) {
      failures.push("upstream did not receive per-request _meta");
    } else if (JSON.stringify(captured._meta) !== JSON.stringify(modernMeta())) {
      failures.push("per-request _meta changed during pass-through");
    } else {
      for (const key of Object.keys(MODERN_TRACE)) {
        if ((captured._meta as Record<string, unknown>)[key] !== MODERN_TRACE[key]) {
          failures.push(`trace field ${key} was lost from _meta`);
        }
      }
    }
  }

  // MRTR: the input_required result and the inputResponses retry must pass
  // through unchanged in both directions.
  const mrr = await request(h, toolCall({ style: row.style, id: "mrr-1", name: MRTR_RETRY.name, args: {} }));
  if (JSON.stringify(mrr.result) !== JSON.stringify(MRTR_INPUT_REQUIRED)) {
    failures.push("MRTR input_required result changed during pass-through");
  }
  const mrrRetry = await request(h, toolCall({ style: row.style, id: "mrr-2", name: MRTR_RETRY.name, args: MRTR_RETRY.args }));
  if (JSON.stringify(mrrRetry.result) !== JSON.stringify(MRTR_COMPLETE)) {
    failures.push("MRTR retry result changed during pass-through");
  }
  const { calls: afterMrr } = await fixtureState(h);
  const retryCall = afterMrr.find((call) =>
    call.name === MRTR_RETRY.name &&
    (call.arguments as { inputResponses?: unknown } | undefined)?.inputResponses !== undefined,
  );
  if (!retryCall || JSON.stringify(retryCall.arguments) !== JSON.stringify(MRTR_RETRY.args)) {
    failures.push("MRTR retry inputResponses/requestState changed during pass-through");
  }

  return failures;
}

async function runDecisionCase(
  h: Harness,
  caseDef: DecisionCase,
  hang?: HangSignals,
  matchCall?: (call: Record<string, unknown>) => boolean,
): Promise<CaseRun> {
  const id = caseDef.id;
  const matches = matchCall ?? ((call) => call.name === caseDef.tool);
  if (caseDef.approval === "hang") {
    writeRequest(h, toolCall({ style: h.row.style, id, name: caseDef.tool, args: caseDef.args, metaOverride: caseDef.metaOverride }));
    await hang?.requested;
    writeRequest(h, {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: id, reason: "conformance-cancel" },
    });
    await hang?.cancelled;
    await sleep(40);
    const { calls } = await fixtureState(h);
    const decision = decisionFor(h, id);
    return {
      caseId: caseDef.id,
      style: h.row.style,
      revision: h.revision,
      forwarded: calls.some(matches),
      noAudit: decision === undefined,
    };
  }
  const response = await request(h, toolCall({ style: h.row.style, id, name: caseDef.tool, args: caseDef.args, metaOverride: caseDef.metaOverride }));
  const { calls } = await fixtureState(h);
  const capturedCall = calls.find(matches);
  const decision = decisionFor(h, id);
  return {
    caseId: caseDef.id,
    style: h.row.style,
    revision: h.revision,
    effect: decision ? (decision.decision.effect as string) : undefined,
    forwarded: capturedCall !== undefined,
    resolution: decision?.resolution,
    dispatch: decision?.dispatch,
    response,
    captured: capturedCall
      ? { arguments: capturedCall.arguments, _meta: capturedCall._meta }
      : undefined,
  };
}

function verifyCase(run: CaseRun, caseDef: DecisionCase): string[] {
  const problems: string[] = [];
  const expect = caseDef.expect;
  if (caseDef.approval === "hang") {
    if (run.forwarded) problems.push("a cancelled approval was forwarded upstream");
    if (run.noAudit !== true) problems.push("a cancelled approval left an audit decision");
    return problems;
  }
  if (run.effect !== expect.effect) problems.push(`decision effect ${run.effect} !== expected ${expect.effect}`);
  if (run.forwarded !== expect.forwarded) problems.push(`forwarded ${run.forwarded} !== expected ${expect.forwarded}`);
  if (expect.resolution !== undefined && run.resolution !== expect.resolution) {
    problems.push(`approval resolution ${run.resolution} !== expected ${expect.resolution}`);
  }
  if (expect.askPath === true && run.resolution === undefined) {
    problems.push("expected an approval path but no approval resolution was recorded");
  }
  if (expect.effect === "deny" && run.dispatch !== "not-forwarded") {
    problems.push(`deny must record dispatch=not-forwarded (got ${run.dispatch})`);
  }
  if (expect.effect === "deny" && !(run.response?.result as { isError?: boolean } | undefined)?.isError) {
    problems.push("deny did not produce an isError tool result");
  }
  if (expect.forwarded && (run.response?.result as { isError?: boolean } | undefined)?.isError === true) {
    if (run.style === "modern") problems.push("modern upstream rejected the forwarded call; per-request _meta was not preserved");
    else problems.push("upstream rejected the forwarded call");
  }
  if (expect.forwarded && run.captured && JSON.stringify(run.captured.arguments) !== JSON.stringify(caseDef.args)) {
    problems.push("forwarded tool arguments changed during pass-through");
  }
  return problems;
}

async function runSchemaChange(
  row: MatrixRow,
  revision: string,
  mkHarness: (approval: ApprovalRequester, policy: Parameters<typeof parsePolicy>[0]) => Harness,
): Promise<{ failures: string[]; fp1?: string; fp2?: string }> {
  const failures: string[] = [];
  const fingerprints = new Map<string, string>();
  const observed: string[] = [];
  const approval: ApprovalRequester = {
    updateToolFingerprint: (_server, tool, fingerprint) => fingerprints.set(tool, fingerprint),
    request: async (_action, _decision, context) => {
      observed.push(context?.schemaFingerprint ?? "");
      return false;
    },
  };
  const h = mkHarness(approval, { version: 1, default: "ask", rules: [] });

  await request(h, { jsonrpc: "2.0", id: "schema-list-1", method: "tools/list" });
  const fp1 = fingerprints.get("read_file");
  await request(h, toolCall({ style: row.style, id: "schema-call-1", name: "read_file", args: { path: "safe.txt" } }));
  if (observed.length !== 1) failures.push("first ask did not reach approval");
  if (observed[0] !== fp1) failures.push("approval did not receive the current schema fingerprint");

  await request(h, { jsonrpc: "2.0", id: "schema-set", method: "test/set-schema", params: { version: 2 } });
  await request(h, { jsonrpc: "2.0", id: "schema-list-2", method: "tools/list" });
  const fp2 = fingerprints.get("read_file");
  await request(h, toolCall({ style: row.style, id: "schema-call-2", name: "read_file", args: { path: "safe.txt" } }));

  if (!fp1 || !fp2) failures.push("schema fingerprints were not recorded");
  if (fp1 === fp2) failures.push("a schema change did not change the tool fingerprint");
  if (observed.length !== 2) failures.push("the second ask did not request approval after the schema change");
  if (observed[1] !== fp2) failures.push("approval did not receive the refreshed schema fingerprint");
  return { failures, fp1, fp2 };
}

async function runRow(row: MatrixRow, revision: string): Promise<RowResult> {
  const failures: string[] = [];
  const cases = new Map<string, CaseRun>();
  const harnesses: Harness[] = [];
  const mkHarness = (approval: ApprovalRequester, policy: Parameters<typeof parsePolicy>[0]): Harness => {
    const h = startHarness(row, revision, approval, policy);
    harnesses.push(h);
    return h;
  };
  try {
    failures.push(...await runTransparency(row, revision, mkHarness));

    for (const caseDef of DECISION_CASES) {
      let approval: ApprovalRequester;
      let hang: HangSignals | undefined;
      if (caseDef.approval === "approve") {
        approval = { request: async () => true };
      } else if (caseDef.approval === "reject") {
        approval = { request: async () => false };
      } else {
        let markRequested: (() => void) | undefined;
        let markCancelled: (() => void) | undefined;
        const requested = new Promise<void>((resolveDone) => { markRequested = resolveDone; });
        const cancelled = new Promise<void>((resolveDone) => { markCancelled = resolveDone; });
        hang = { requested, cancelled };
        approval = {
          request: () => {
            markRequested?.();
            return new Promise(() => undefined);
          },
          cancel: () => markCancelled?.(),
        };
      }
      const h = mkHarness(approval, caseDef.policy());
      const run = await runDecisionCase(h, caseDef, hang);
      cases.set(caseDef.id, run);
      const problems = verifyCase(run, caseDef);

      // Protocol revision metadata neutrality: the same known action must be
      // decided and forwarded identically when per-request _meta advertises an
      // unverified protocol revision, and that payload must still reach the
      // upstream verbatim.
      if (caseDef.neutralMeta === true && row.style === "modern") {
        const bogusMeta = modernMeta(UNVERIFIED_PROTOCOL);
        const variantId = `${caseDef.id}@unverified`;
        const matchBogus = (call: Record<string, unknown>) =>
          call.name === caseDef.tool &&
          (call._meta as Record<string, unknown> | undefined)?.["io.modelcontextprotocol/protocolVersion"] ===
            UNVERIFIED_PROTOCOL;
        const variant = await runDecisionCase(h, { ...caseDef, id: variantId, metaOverride: bogusMeta }, undefined, matchBogus);
        cases.set(variantId, variant);
        const variantProblems = verifyCase(variant, caseDef);
        if (variant.effect !== run.effect || variant.forwarded !== run.forwarded) {
          variantProblems.push("decision or forwarding differs between the verified and unverified protocol revisions");
        }
        if (JSON.stringify(variant.captured?._meta) !== JSON.stringify(bogusMeta)) {
          variantProblems.push("the unverified protocol revision payload did not survive pass-through verbatim");
        }
        if (variantProblems.length) failures.push(`${variantId}: ${variantProblems.join("; ")}`);
      }

      if (problems.length) failures.push(`${caseDef.id}: ${problems.join("; ")}`);
    }

    const schema = await runSchemaChange(row, revision, mkHarness);
    failures.push(...schema.failures.map((problem) => `schema-change: ${problem}`));
    return {
      id: row.id,
      revision,
      status: failures.length ? "fail" : "pass",
      failures,
      cases,
      schema: { fp1: schema.fp1, fp2: schema.fp2 },
      verifiedAt: new Date().toISOString(),
    };
  } finally {
    for (const h of harnesses) h.controller.stop();
    await sleep(40);
  }
}

describe("protocol conformance corpus", () => {
  const rowResults = new Map<string, RowResult>();

  it(
    "every supported row passes the corpus for every declared protocol revision",
    async () => {
      const rows = matrix.rows.filter((row) => row.status === "supported") as MatrixRow[];
      expect(rows.length).toBeGreaterThan(0);
      const revisionsByRow = new Map<string, string[]>();
      for (const row of rows) {
        const revisions = row.mcpProtocol as string[];
        expect(revisions.length).toBeGreaterThan(0);
        revisionsByRow.set(row.id, revisions);
        for (const revision of revisions) {
          const result = await runRow(row, revision);
          rowResults.set(`${row.id}@${revision}`, result);
          expect(result.failures, `${row.id}@${revision}`).toEqual([]);
        }
      }

      // Cross-revision identity within each row: every declared revision of a
      // row makes the same decision and forwards identically.
      for (const row of rows) {
        const revisions = revisionsByRow.get(row.id) ?? [];
        const baseline = revisions[0];
        for (const caseDef of DECISION_CASES) {
          const first = rowResults.get(`${row.id}@${baseline}`)?.cases.get(caseDef.id);
          expect(first, `${caseDef.id} must run on ${row.id}@${baseline}`).toBeDefined();
          for (const revision of revisions.slice(1)) {
            const other = rowResults.get(`${row.id}@${revision}`)?.cases.get(caseDef.id);
            expect(other, `${caseDef.id} must run on ${row.id}@${revision}`).toBeDefined();
            expect(other?.effect, `${caseDef.id} decision effect on ${row.id}@${revision}`).toBe(first?.effect);
            expect(other?.forwarded, `${caseDef.id} forwarding on ${row.id}@${revision}`).toBe(first?.forwarded);
          }
        }
      }

      // Cross-row identity: the same case is decided identically on every
      // supported row's baseline revision.
      const firstRow = rows[0];
      const firstBaseline = revisionsByRow.get(firstRow.id)?.[0] ?? "";
      for (const caseDef of DECISION_CASES) {
        const first = rowResults.get(`${firstRow.id}@${firstBaseline}`)?.cases.get(caseDef.id);
        expect(first, `${caseDef.id} must run on ${firstRow.id}@${firstBaseline}`).toBeDefined();
        for (const row of rows.slice(1)) {
          const other = rowResults.get(`${row.id}@${revisionsByRow.get(row.id)?.[0] ?? ""}`)?.cases.get(caseDef.id);
          expect(other, `${caseDef.id} must run on ${row.id}`).toBeDefined();
          expect(other?.effect, `${caseDef.id} decision effect on ${row.id}`).toBe(first?.effect);
          expect(other?.forwarded, `${caseDef.id} forwarding on ${row.id}`).toBe(first?.forwarded);
        }
      }

      // Schema fingerprints are protocol-independent (identical across rows and
      // revisions) while a real Schema change still alters them everywhere.
      const baselineSchema = rowResults.get(`${firstRow.id}@${firstBaseline}`)?.schema;
      expect(baselineSchema?.fp1).toBeDefined();
      for (const [key, result] of rowResults) {
        expect(result.schema.fp1, `schema v1 fingerprint on ${key}`).toBe(baselineSchema?.fp1);
        expect(result.schema.fp2, `schema v2 fingerprint on ${key}`).toBe(baselineSchema?.fp2);
        expect(result.schema.fp1, `schema change must alter the fingerprint on ${key}`).not.toBe(result.schema.fp2);
      }
    },
    300_000,
  );

  it("matrix declares only the documented status vocabulary", () => {
    expect(matrix.statuses).toEqual(STATUSES);
    for (const row of matrix.rows) {
      expect(STATUSES).toContain(row.status);
    }
  });

  it("matrix toolfenceVersion matches the package version", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };
    expect(matrix.toolfenceVersion).toBe(pkg.version);
  });

  it("matrix declares the binding identity fields and per-row revision lists", () => {
    expect(Number.isInteger(matrix.matrixVersion)).toBe(true);
    expect(typeof matrix.toolfenceVersion).toBe("string");
    expect(matrix.toolfenceVersion!.length).toBeGreaterThan(0);
    for (const row of matrix.rows) {
      if (row.status === "supported") {
        expect(Array.isArray(row.mcpProtocol), `${row.id} mcpProtocol`).toBe(true);
        expect(row.mcpProtocol.length, `${row.id} revisions`).toBeGreaterThan(0);
        for (const revision of row.mcpProtocol) {
          expect(typeof revision, `${row.id} revision`).toBe("string");
        }
      }
    }
  });

  it("supported rows declare runnable fixtures; unsupported rows declare no corpus-backed claim", () => {
    for (const row of matrix.rows) {
      if (row.status === "supported") {
        expect(row.server, `${row.id} server`).toBeTruthy();
        expect(["legacy", "modern"]).toContain(row.style);
        expect(existsSync(resolve(repoRoot, row.server as string)), `${row.id} fixture`).toBe(true);
      } else {
        expect(row.server ?? null, `${row.id} must not claim fixture-backed support`).toBe(null);
      }
    }
  });

  afterAll(async () => {
    if (process.env.TOOLFENCE_CONFORMANCE_REPORT !== "1") return;
    const report = {
      reportVersion: 1,
      matrixVersion: matrix.matrixVersion,
      toolfenceVersion: matrix.toolfenceVersion,
      nodeVersion: process.versions.node,
      os: process.platform,
      host: process.env.GITHUB_ACTIONS === "true" ? "github-actions" : "local",
      generatedAt: new Date().toISOString(),
      rows: [...rowResults.values()].map((result) => ({
        id: result.id,
        revision: result.revision,
        status: result.status,
        cases: result.cases.size,
        failures: result.failures.slice(0, 20),
        verifiedAt: result.verifiedAt,
      })),
    };
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  });
});
