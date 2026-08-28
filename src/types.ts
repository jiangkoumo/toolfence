export const operations = [
  "fs.read",
  "fs.write",
  "fs.delete",
  "shell.exec",
  "git.read",
  "git.write",
  "git.remote",
  "net.request",
  "unknown",
] as const;

export type Operation = (typeof operations)[number];
export type Effect = "allow" | "deny" | "ask";
export type ActionNormalization = "known" | "ambiguous" | "unknown";

export interface NormalizedAction {
  operation: Operation;
  normalization?: ActionNormalization;
  resources: string[];
  server: string;
  tool: string;
  rawArguments: unknown;
  command?: string;
  executable?: string;
  argv?: string[];
  network?: {
    url: string;
    host: string;
    method: string;
    scheme: string;
  };
}

export interface PolicyRule {
  id: string;
  effect: Effect;
  operations: Operation[];
  resources?: string[];
  servers?: string[];
  tools?: string[];
  executables?: string[];
  commands?: string[][];
  hosts?: string[];
  methods?: string[];
}

export interface PolicyConfig {
  version: 1;
  default: Effect;
  redactSecrets?: boolean;
  rules: PolicyRule[];
}

export interface PolicyContext {
  workspace: string;
  home: string;
}

export interface Decision {
  effect: Effect;
  ruleId?: string;
  reason: string;
}

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}
