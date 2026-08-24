import { describe, it } from "vitest";
import { normalizeToolCall } from "../src/adapters.js";
import { parsePolicy } from "../src/config.js";
import { PolicyEngine } from "../src/policy.js";
import { operations, type NormalizedAction } from "../src/types.js";

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function randomJson(next: () => number, depth = 0): unknown {
  const primitive = () => {
    const choice = Math.floor(next() * 5);
    if (choice === 0) return null;
    if (choice === 1) return next() > 0.5;
    if (choice === 2) return Math.floor(next() * 10_000) - 5_000;
    return `${next().toString(36).slice(2)}${choice === 4 ? "../.env" : ""}`;
  };
  if (depth >= 3 || next() < 0.45) return primitive();
  if (next() < 0.35) {
    return Array.from({ length: Math.floor(next() * 4) }, () => randomJson(next, depth + 1));
  }
  const value: Record<string, unknown> = {};
  for (let index = 0; index < Math.floor(next() * 5); index += 1) {
    value[`key_${Math.floor(next() * 20)}`] = randomJson(next, depth + 1);
  }
  return value;
}

describe("deterministic fuzz invariants", () => {
  it("normalizes arbitrary JSON-shaped tool arguments without throwing", () => {
    const next = random(0x544f4f4c);
    const toolNames = [
      "read_file",
      "write_file",
      "execute_command",
      "git",
      "fetch",
      "unknown/tool",
      "",
    ];
    for (let index = 0; index < 1_000; index += 1) {
      const rawArguments = randomJson(next);
      const tool = toolNames[Math.floor(next() * toolNames.length)];
      const action = normalizeToolCall("fuzz", tool, rawArguments, "/workspace");

      if (!operations.includes(action.operation)) throw new Error(`invalid operation at case ${index}`);
      if (action.rawArguments !== rawArguments) throw new Error(`raw argument identity changed at case ${index}`);
      if (!action.resources.every((resource) => typeof resource === "string")) {
        throw new Error(`non-string resource at case ${index}`);
      }
    }
  });

  it("keeps deny precedence for randomized operations and rule order", () => {
    const next = random(0x46454e43);
    for (let index = 0; index < 64; index += 1) {
      const operation = operations[Math.floor(next() * operations.length)];
      const rules = [
        { id: `allow-${index}`, effect: "allow" as const, operations: [operation] },
        { id: `deny-${index}`, effect: "deny" as const, operations: [operation] },
      ];
      if (next() > 0.5) rules.reverse();
      const policy = parsePolicy({ version: 1, default: "ask", rules });
      const engine = new PolicyEngine(policy, { workspace: "/workspace", home: "/home/user" });
      const action: NormalizedAction = {
        operation,
        resources: [],
        server: "fuzz",
        tool: "tool",
        rawArguments: {},
      };

      const decision = engine.evaluate(action);
      if (decision.effect !== "deny" || decision.ruleId !== `deny-${index}`) {
        throw new Error(`deny precedence failed at case ${index}`);
      }
    }
  }, 15_000);
});
