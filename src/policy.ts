import { minimatch } from "minimatch";
import { canonicalizePath, resourceMatches } from "./paths.js";
import type {
  Decision,
  NormalizedAction,
  PolicyConfig,
  PolicyContext,
  PolicyRule,
} from "./types.js";

function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(value, pattern, { dot: true }));
}

function sameCommand(actual: string[] | undefined, expected: string[]): boolean {
  return (
    actual !== undefined &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function ruleMatches(
  rule: PolicyRule,
  action: NormalizedAction,
  context: PolicyContext,
): boolean {
  if (!rule.operations.includes(action.operation)) return false;
  if (rule.servers && !matchesAny(action.server, rule.servers)) return false;
  if (rule.tools && !matchesAny(action.tool, rule.tools)) return false;

  if (rule.resources) {
    if (action.resources.length === 0) return false;
    const matchResource = (resource: string) =>
      rule.resources?.some((pattern) => resourceMatches(pattern, resource, context)) ?? false;
    const resourcesMatch =
      rule.effect === "deny"
        ? action.resources.some(matchResource)
        : action.resources.every(matchResource);
    if (!resourcesMatch) return false;
  }

  if (rule.executables) {
    if (!action.executable || !rule.executables.includes(action.executable)) return false;
  }

  if (rule.commands) {
    if (!rule.commands.some((command) => sameCommand(action.argv, command))) return false;
  }

  if (rule.hosts) {
    if (!action.network || !matchesAny(action.network.host, rule.hosts)) return false;
  }

  if (rule.methods) {
    if (!action.network || !rule.methods.includes(action.network.method.toUpperCase())) return false;
  }

  return true;
}

export class PolicyEngine {
  private readonly context: PolicyContext;

  constructor(private readonly config: PolicyConfig, context: PolicyContext) {
    this.context = {
      workspace: canonicalizePath(context.workspace, context.workspace),
      home: canonicalizePath(context.home, context.home),
    };
  }

  get redactSecrets(): boolean {
    return this.config.redactSecrets !== false;
  }

  evaluate(action: NormalizedAction): Decision {
    const matches = this.config.rules.filter((rule) =>
      ruleMatches(rule, action, this.context),
    );
    const selected = matches.find((rule) => rule.effect === "deny") ?? matches[0];

    if (!selected) {
      const uncertain = action.operation === "unknown" ||
        action.normalization === "ambiguous" ||
        action.normalization === "unknown";
      if (uncertain && this.config.default === "allow") {
        return {
          effect: "ask",
          reason: "Uncertain action cannot inherit default allow; requiring approval",
        };
      }
      return {
        effect: this.config.default,
        reason: `No rule matched; using default ${this.config.default}`,
      };
    }

    return {
      effect: selected.effect,
      ruleId: selected.id,
      reason: `Matched rule ${selected.id}`,
    };
  }

  explain(action: NormalizedAction): { action: NormalizedAction; matches: string[]; decision: Decision } {
    const matches = this.config.rules
      .filter((rule) => ruleMatches(rule, action, this.context))
      .map((rule) => rule.id);
    return { action, matches, decision: this.evaluate(action) };
  }
}
