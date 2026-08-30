import { closeSync, createReadStream, createWriteStream, openSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import type { Decision, JsonRpcId, NormalizedAction } from "./types.js";

export type ApprovalResolution = "allow-once" | "allow-session" | "deny";

export interface ApprovalOutcome {
  approved: boolean;
  approvalId?: string;
  resolution: ApprovalResolution;
}

export interface ApprovalContext {
  requestId: JsonRpcId;
  sessionId: string;
  approvalId?: string;
  schemaFingerprint?: string;
  signal?: AbortSignal;
}

export interface ApprovalRequester {
  request(action: NormalizedAction, decision: Decision, context?: ApprovalContext): Promise<boolean>;
  requestWithOutcome?(
    action: NormalizedAction,
    decision: Decision,
    context?: ApprovalContext,
  ): Promise<ApprovalOutcome>;
  cancel?(requestId: JsonRpcId, reason: "client-cancelled" | "timeout" | "proxy-closed"): void;
  updateToolFingerprint?(server: string, tool: string, fingerprint: string): void;
}

function describeAction(action: NormalizedAction): string {
  const details = action.resources.length
    ? action.resources.join(", ")
    : action.command ?? "no recognized resource";
  return `${action.operation} via ${action.server}/${action.tool}\n  ${details}`;
}

export class TtyApprovalRequester implements ApprovalRequester {
  private queue: Promise<unknown> = Promise.resolve();

  request(action: NormalizedAction, decision: Decision, context?: ApprovalContext): Promise<boolean> {
    const result = this.queue.then(() => this.ask(action, decision, context?.signal));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async ask(
    action: NormalizedAction,
    decision: Decision,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    let fd: number;
    try {
      fd = openSync("/dev/tty", "r+");
    } catch {
      process.stderr.write(
        "ToolFence: approval required but no controlling terminal is available; denying.\n",
      );
      return false;
    }

    const input = createReadStream("/dev/tty", { fd, autoClose: false });
    const output = createWriteStream("/dev/tty", { fd, autoClose: false });
    const readline = createInterface({ input, output });

    try {
      const prompt = `\nToolFence approval required\n${describeAction(action)}\n${decision.reason}\nAllow once? [y/N] `;
      const answer = signal
        ? await readline.question(prompt, { signal })
        : await readline.question(prompt);
      return answer.trim().toLowerCase() === "y";
    } catch (error) {
      if (signal?.aborted) return false;
      throw error;
    } finally {
      readline.close();
      input.destroy();
      output.destroy();
      closeSync(fd);
    }
  }
}
