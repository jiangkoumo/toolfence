import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { normalizeToolCall } from "./adapters.js";
import { loadPolicy } from "./config.js";
import { canonicalizePath } from "./paths.js";
import { PolicyEngine } from "./policy.js";
import { operations, type NormalizedAction } from "./types.js";

const normalizedActionSchema = z.object({
  operation: z.enum(operations),
  resources: z.array(z.string()).default([]),
  server: z.string().min(1),
  tool: z.string().min(1),
  rawArguments: z.unknown().optional().default({}),
  command: z.string().optional(),
  executable: z.string().optional(),
  argv: z.array(z.string()).optional(),
  network: z.object({
    url: z.string(),
    host: z.string(),
    method: z.string(),
    scheme: z.string(),
  }).optional(),
}).strict();

const policyCasesSchema = z.object({
  workspace: z.string().optional(),
  cases: z.array(z.object({
    name: z.string().min(1),
    server: z.string().min(1).optional(),
    tool: z.string().min(1).optional(),
    arguments: z.unknown().optional(),
    action: normalizedActionSchema.optional(),
    expect: z.object({
      effect: z.enum(["allow", "deny", "ask"]),
      ruleId: z.string().optional(),
    }).strict(),
  }).strict().refine((item) => item.action || (item.server && item.tool), {
    message: "Each case needs either action or server/tool",
  })).min(1),
}).strict();

function engineFor(policyPath: string, workspace: string): PolicyEngine {
  return new PolicyEngine(loadPolicy(policyPath), {
    workspace: canonicalizePath(workspace, workspace),
    home: canonicalizePath(homedir(), homedir()),
  });
}

export function checkPolicy(policyPath: string): string {
  const policy = loadPolicy(policyPath);
  return `Policy is valid: ${policy.rules.length} rule(s), default ${policy.default}`;
}

export function explainPolicy(
  policyPath: string,
  actionPath: string,
  workspace = process.cwd(),
): string {
  const action = normalizedActionSchema.parse(JSON.parse(readFileSync(actionPath, "utf8")));
  const explanation = engineFor(policyPath, workspace).explain(action as NormalizedAction);
  return JSON.stringify({
    operation: explanation.action.operation,
    matchedRules: explanation.matches,
    decision: explanation.decision,
  }, null, 2);
}

export interface PolicyTestResult {
  passed: number;
  failed: number;
  output: string;
}

export function testPolicy(policyPath: string, casesPath: string): PolicyTestResult {
  const source = parseYaml(readFileSync(casesPath, "utf8"));
  const suite = policyCasesSchema.parse(source);
  const workspace = canonicalizePath(
    suite.workspace ? resolve(dirname(casesPath), suite.workspace) : process.cwd(),
    process.cwd(),
  );
  const engine = engineFor(policyPath, workspace);
  const lines: string[] = [];
  let passed = 0;
  let failed = 0;
  for (const item of suite.cases) {
    const action = item.action
      ? item.action as NormalizedAction
      : normalizeToolCall(item.server as string, item.tool as string, item.arguments ?? {}, workspace);
    const actual = engine.evaluate(action);
    const ok = actual.effect === item.expect.effect &&
      (item.expect.ruleId === undefined || actual.ruleId === item.expect.ruleId);
    if (ok) {
      passed += 1;
      lines.push(`PASS ${item.name}`);
    } else {
      failed += 1;
      lines.push(
        `FAIL ${item.name}: expected ${item.expect.effect}/${item.expect.ruleId ?? "-"}, got ${actual.effect}/${actual.ruleId ?? "-"}`,
      );
    }
  }
  lines.push(`${passed} passed, ${failed} failed`);
  return { passed, failed, output: lines.join("\n") };
}
