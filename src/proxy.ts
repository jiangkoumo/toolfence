import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { normalizeToolCall } from "./adapters.js";
import type { ApprovalOutcome, ApprovalRequester } from "./approval.js";
import type { AuditCorrelation, AuditDecisionContext, AuditEvidenceContext, AuditLogger } from "./audit.js";
import type { PolicyEngine } from "./policy.js";
import { redactToolResult } from "./redact.js";
import { fingerprintToolList } from "./schema.js";
import type { Decision, JsonRpcId, JsonRpcRequest, NormalizedAction } from "./types.js";

export interface ProxyOptions {
  command: string;
  args: string[];
  cwd: string;
  server: string;
  policy: PolicyEngine;
  approval: ApprovalRequester;
  audit: AuditLogger;
  input: Readable;
  output: Writable;
  errorOutput: Writable;
  env?: NodeJS.ProcessEnv;
  approvalTimeoutMs?: number;
  host?: string;
  policyHash?: string;
  protocolRevision?: string;
}

export interface ProxyController {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<number | null>;
  stop(): void;
}

interface ToolCallParams {
  name: string;
  arguments?: unknown;
}

interface AwaitingApproval {
  id: JsonRpcId;
  approvalId: string;
  abort: AbortController;
  reason?: "client-cancelled" | "timeout" | "proxy-closed";
}

interface ForwardedRequest {
  id: JsonRpcId;
  method: string;
  action?: NormalizedAction;
  auditCorrelation?: AuditCorrelation;
}

const MAX_IN_FLIGHT_REQUESTS = 2_000;

function requestKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<JsonRpcRequest>;
  return candidate.jsonrpc === "2.0" && typeof candidate.method === "string";
}

function toolCallParams(value: unknown): ToolCallParams | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const params = value as Partial<ToolCallParams>;
  return typeof params.name === "string"
    ? { name: params.name, arguments: params.arguments }
    : undefined;
}

function isMcpToolError(value: unknown): boolean {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as { isError?: unknown }).isError === true;
}

function cancelledRequestId(value: unknown): JsonRpcId | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const id = (value as { requestId?: unknown }).requestId;
  return typeof id === "string" || typeof id === "number" || id === null ? id : undefined;
}

function toolErrorResponse(id: JsonRpcId, message: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: message }], isError: true },
  });
}

function deniedResponse(id: JsonRpcId, decision: Decision): string {
  const rule = decision.ruleId ? ` (rule: ${decision.ruleId})` : "";
  return toolErrorResponse(id, `ToolFence denied this tool call${rule}: ${decision.reason}`);
}

function rpcError(id: JsonRpcId, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

function parseErrorResponse(): string {
  return rpcError(null, -32700, "ToolFence could not parse the JSON-RPC message");
}

function invalidRequestResponse(message = "ToolFence does not accept JSON-RPC batches"): string {
  return rpcError(null, -32600, message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function approvalReason(resolution: ApprovalOutcome["resolution"]): string {
  return resolution === "allow-session"
    ? "Approved for this session by user"
    : "Approved once by user";
}

export function startProxy(options: ProxyOptions): ProxyController {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const proxyRunId = randomUUID();
  const clientSessionId = randomUUID();
  const forwarded = new Map<string, ForwardedRequest>();
  const awaiting = new Map<string, AwaitingApproval>();
  const toolFingerprints = new Map<string, string>();
  let negotiatedProtocolRevision: string | undefined;
  const clientLines = createInterface({ input: options.input, crlfDelay: Infinity });
  const childLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let clientClosed = false;

  const writeOutput = (line: string) => {
    try {
      options.output.write(`${line}\n`);
    } catch (error) {
      options.errorOutput.write(`ToolFence: failed to write client response: ${errorMessage(error)}\n`);
      child.kill("SIGTERM");
    }
  };

  const abortAwaiting = (reason: AwaitingApproval["reason"]) => {
    for (const item of awaiting.values()) {
      item.reason = reason;
      options.approval.cancel?.(item.id, reason ?? "proxy-closed");
      item.abort.abort();
    }
  };

  child.stderr.on("data", (chunk: Buffer | string) => options.errorOutput.write(chunk));
  child.stdin.on("error", (error) => {
    options.errorOutput.write(`ToolFence: upstream input failed: ${errorMessage(error)}\n`);
    abortAwaiting("proxy-closed");
  });

  clientLines.on("line", (line) => {
    void handleClientLine(line).catch((error: unknown) => {
      options.errorOutput.write(`ToolFence: request failed: ${errorMessage(error)}\n`);
    });
  });

  clientLines.on("close", () => {
    clientClosed = true;
    abortAwaiting("proxy-closed");
    child.stdin.end();
  });

  childLines.on("line", (line) => {
    let suppress = false;
    try {
      const message = JSON.parse(line) as { id?: JsonRpcId; error?: unknown; result?: unknown };
      if (message.id !== undefined) {
        const key = requestKey(message.id);
        const tracked = forwarded.get(key);
        if (tracked) {
          if (tracked.method === "tools/list" && message.error === undefined) {
            for (const [tool, fingerprint] of fingerprintToolList(message.result)) {
              toolFingerprints.set(tool, fingerprint);
              options.approval.updateToolFingerprint?.(options.server, tool, fingerprint);
            }
          }
          if (tracked.action) {
            let redacted = false;
            try {
              if (options.policy.redactSecrets) {
                if (message.result !== undefined) {
                  const redaction = redactToolResult(message.result);
                  if (redaction.redacted) {
                    redacted = true;
                    message.result = redaction.result;
                  }
                }
                if (message.error !== undefined) {
                  const redaction = redactToolResult(message.error);
                  if (redaction.redacted) {
                    redacted = true;
                    message.error = redaction.result;
                  }
                }
                if (redacted) line = JSON.stringify(message);
              }
            } catch {
              suppress = true;
              writeOutput(rpcError(tracked.id, -32603, "ToolFence output redaction failed"));
              child.kill("SIGTERM");
            }
            if (!suppress) {
              try {
                options.audit.result(
                  tracked.id,
                  createHash("sha256").update(line).digest("hex"),
                  message.error !== undefined || isMcpToolError(message.result),
                  redacted,
                  tracked.auditCorrelation,
                );
              } catch (error) {
                suppress = true;
                writeOutput(rpcError(tracked.id, -32603, `ToolFence audit failed: ${errorMessage(error)}`));
                child.kill("SIGTERM");
              }
            }
          }
          forwarded.delete(key);
        }
      }
    } catch {
      // Preserve malformed upstream output; protocol validation belongs to the MCP client.
    }
    if (!suppress) writeOutput(line);
  });

  const closed = new Promise<number | null>((resolveClosed, rejectClosed) => {
    child.once("error", rejectClosed);
    child.once("close", (code) => {
      abortAwaiting("proxy-closed");
      if (!clientClosed) {
        for (const tracked of forwarded.values()) {
          writeOutput(rpcError(tracked.id, -32603, "ToolFence upstream server exited before responding"));
        }
      }
      forwarded.clear();
      resolveClosed(code);
    });
  });

  function forward(
    line: string,
    request?: JsonRpcRequest,
    action?: NormalizedAction,
    auditCorrelation?: AuditCorrelation,
  ): void {
    if (request?.id !== undefined) {
      const key = requestKey(request.id);
      if (awaiting.has(key) || forwarded.has(key)) {
        writeOutput(rpcError(request.id, -32600, "Duplicate in-flight request id"));
        return;
      }
      if (forwarded.size >= MAX_IN_FLIGHT_REQUESTS) {
        writeOutput(rpcError(request.id, -32000, "ToolFence has too many in-flight requests"));
        return;
      }
      forwarded.set(key, { id: request.id, method: request.method, action, auditCorrelation });
    }
    try {
      child.stdin.write(`${line}\n`);
    } catch (error) {
      if (request?.id !== undefined) forwarded.delete(requestKey(request.id));
      throw new Error(`could not write to upstream: ${errorMessage(error)}`);
    }
  }

  async function handleClientLine(line: string): Promise<void> {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      writeOutput(parseErrorResponse());
      return;
    }

    if (Array.isArray(message)) {
      writeOutput(invalidRequestResponse());
      return;
    }
    if (!isJsonRpcRequest(message)) {
      writeOutput(invalidRequestResponse("ToolFence received an invalid JSON-RPC request"));
      return;
    }

    if (message.method === "notifications/cancelled") {
      if (message.id !== undefined) {
        writeOutput(rpcError(
          message.id,
          -32600,
          "notifications/cancelled must not include a request id",
        ));
        return;
      }
      const requestId = cancelledRequestId(message.params);
      if (requestId !== undefined) {
        const key = requestKey(requestId);
        const pending = awaiting.get(key);
        if (pending) {
          pending.reason = "client-cancelled";
          options.approval.cancel?.(requestId, "client-cancelled");
          pending.abort.abort();
          return;
        }
        if (forwarded.has(key)) {
          forward(line);
          return;
        }
      }
      forward(line);
      return;
    }

    if (message.method !== "tools/call") {
      if (message.method === "initialize" && message.params !== null && typeof message.params === "object") {
        const initParams = message.params as Record<string, unknown>;
        if (typeof initParams.protocolVersion === "string") {
          negotiatedProtocolRevision = initParams.protocolVersion;
        }
      }
      forward(line, message);
      return;
    }
    if (message.id === undefined) {
      writeOutput(invalidRequestResponse("tools/call must include a request id"));
      return;
    }
    const key = requestKey(message.id);
    if (awaiting.has(key) || forwarded.has(key)) {
      writeOutput(rpcError(message.id, -32600, "Duplicate in-flight request id"));
      return;
    }

    const params = toolCallParams(message.params);
    const action = params
      ? normalizeToolCall(options.server, params.name, params.arguments ?? {}, options.cwd)
      : normalizeToolCall(options.server, "<invalid>", {}, options.cwd);
    let decision = options.policy.evaluate(action);
    let approvalContext: Pick<AuditDecisionContext, "approvalId" | "resolution"> | undefined;

    if (decision.effect === "ask") {
      const abort = new AbortController();
      const pending: AwaitingApproval = { id: message.id, approvalId: randomUUID(), abort };
      awaiting.set(key, pending);
      const timeout = setTimeout(() => {
        pending.reason = "timeout";
        options.approval.cancel?.(message.id as JsonRpcId, "timeout");
        abort.abort();
      }, options.approvalTimeoutMs ?? 60_000);
      const deniedOutcome: ApprovalOutcome = {
        approved: false,
        approvalId: pending.approvalId,
        resolution: "deny",
      };
      const aborted = new Promise<ApprovalOutcome>((resolve) =>
        abort.signal.addEventListener("abort", () => resolve(deniedOutcome), { once: true }),
      );
      let outcome = deniedOutcome;
      try {
        const context = {
          requestId: message.id,
          sessionId: clientSessionId,
          approvalId: pending.approvalId,
          schemaFingerprint: toolFingerprints.get(action.tool),
          signal: abort.signal,
        };
        outcome = await Promise.race([
          (options.approval.requestWithOutcome
            ? options.approval.requestWithOutcome(action, decision, context)
            : options.approval.request(action, decision, context).then((approved) => ({
                approved,
                approvalId: pending.approvalId,
                resolution: approved ? "allow-once" as const : "deny" as const,
              })))
            .catch((error: unknown) => {
              options.errorOutput.write(`ToolFence: approval failed: ${errorMessage(error)}\n`);
              return deniedOutcome;
            }),
          aborted,
        ]);
      } finally {
        clearTimeout(timeout);
        awaiting.delete(key);
      }
      if (pending.reason === "client-cancelled" || pending.reason === "proxy-closed") return;
      approvalContext = {
        approvalId: outcome.approvalId ?? pending.approvalId,
        resolution: outcome.resolution,
      };
      decision = outcome.approved
        ? { ...decision, effect: "allow", reason: approvalReason(outcome.resolution) }
        : {
            ...decision,
            effect: "deny",
            reason: pending.reason === "timeout" ? "Approval timed out" : "Rejected by user",
          };
    }

    const auditCorrelation: AuditCorrelation = { proxyRunId, clientSessionId };
    const metaProtocol = (message.params !== null && typeof message.params === "object")
      ? ((message.params as Record<string, unknown>)._meta as Record<string, unknown> | undefined)?.protocolVersion
      : undefined;
    const protocolRevision = (typeof metaProtocol === "string" ? metaProtocol : undefined)
      ?? negotiatedProtocolRevision
      ?? options.protocolRevision;

    const auditContext: AuditEvidenceContext = {
      ...auditCorrelation,
      ...approvalContext,
      ...(decision.effect === "deny" ? { dispatch: "not-forwarded" as const } : {}),
      host: options.host,
      protocolRevision,
      toolFingerprint: toolFingerprints.get(action.tool),
      actionModelVersion: action.actionModelVersion,
      policyHash: options.policyHash,
    };
    try {
      options.audit.decision(message.id, action, decision, auditContext);
    } catch (error) {
      writeOutput(toolErrorResponse(message.id, `ToolFence denied this tool call: audit failed: ${errorMessage(error)}`));
      return;
    }
    if (decision.effect === "deny") {
      writeOutput(deniedResponse(message.id, decision));
      return;
    }
    forward(line, message, action, auditCorrelation);
  }

  return { child, closed, stop: () => child.kill("SIGTERM") };
}
