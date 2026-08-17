import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Decision, JsonRpcId, NormalizedAction } from "./types.js";

type AuditEvent =
  | {
      event: "decision";
      requestId: JsonRpcId;
      action: Pick<
        NormalizedAction,
        "operation" | "resources" | "server" | "tool" | "executable"
      >;
      decision: Decision;
    }
  | {
      event: "result";
      requestId: JsonRpcId;
      resultHash: string;
      error: boolean;
    };

export class AuditLogger {
  readonly path: string;

  constructor(filePath: string) {
    this.path = resolve(filePath);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const fd = openSync(this.path, "a", 0o600);
    closeSync(fd);
    if (process.platform !== "win32") chmodSync(this.path, 0o600);
  }

  decision(requestId: JsonRpcId, action: NormalizedAction, decision: Decision): void {
    const safeAction = {
      operation: action.operation,
      resources: action.resources,
      server: action.server,
      tool: action.tool,
      executable: action.executable,
    };
    this.write({ event: "decision", requestId, action: safeAction, decision });
  }

  result(requestId: JsonRpcId, resultHash: string, error: boolean): void {
    this.write({ event: "result", requestId, resultHash, error });
  }

  private write(event: AuditEvent): void {
    appendFileSync(
      this.path,
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }
}
