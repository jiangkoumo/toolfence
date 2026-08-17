import { createHash } from "node:crypto";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export function toolSchemaFingerprint(tool: ToolDefinition): string {
  return createHash("sha256")
    .update(canonicalJson({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema ?? {},
    }))
    .digest("hex");
}

export function fingerprintToolList(value: unknown): Map<string, string> {
  const result = new Map<string, string>();
  if (value === null || typeof value !== "object") return result;
  const tools = (value as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return result;
  for (const candidate of tools) {
    if (candidate !== null && typeof candidate === "object") {
      const tool = candidate as Partial<ToolDefinition>;
      if (typeof tool.name === "string") result.set(tool.name, toolSchemaFingerprint(tool as ToolDefinition));
    }
  }
  return result;
}
