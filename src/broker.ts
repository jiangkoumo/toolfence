import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import type {
  ApprovalContext,
  ApprovalOutcome,
  ApprovalRequester,
  ApprovalResolution,
} from "./approval.js";
import type { Decision, JsonRpcId, NormalizedAction } from "./types.js";
import { operations } from "./types.js";

export const brokerProtocolVersion = 1;
export type BrokerDecision = ApprovalResolution;
export type BrokerCancelReason = "client-cancelled" | "timeout" | "proxy-closed";
export type BrokerTransportType = "unix" | "named-pipe";

export interface BrokerPaths {
  runtimeDir: string;
  socketPath: string;
  tokenPath: string;
  transport?: BrokerTransportType;
}

export interface BrokerStatusResult {
  protocolVersion: number;
  socketMode: number;
  transport: BrokerTransportType;
  platform: NodeJS.Platform;
}

export interface ApprovalRequestMessage {
  type: "approval.request";
  protocolVersion: 1;
  approvalId: string;
  sessionId: string;
  requestId: JsonRpcId;
  action: Omit<NormalizedAction, "rawArguments">;
  ruleId?: string;
  reason: string;
  expiresAt: string;
}

export function isNamedPipePath(path: string): boolean {
  const prefix = path.startsWith("\\\\.\\pipe\\")
    ? "\\\\.\\pipe\\"
    : path.startsWith("//./pipe/")
      ? "//./pipe/"
      : null;
  if (!prefix) return false;
  const name = path.slice(prefix.length);
  return name.length > 0 && !name.includes("..") && !name.includes("/") && !name.includes("\\");
}

export function verifyWindowsSecurity(paths: BrokerPaths, userHome = homedir()): void {
  if (!isNamedPipePath(paths.socketPath)) {
    throw new Error(
      `Insecure Windows configuration: socketPath must be a local named pipe (\\\\.\\pipe\\...), got ${paths.socketPath}`,
    );
  }
  const isWin = process.platform === "win32";
  const pathMod = isWin ? win32 : (paths.tokenPath.includes("\\") ? win32 : { resolve, relative, isAbsolute });
  const resolvedToken = pathMod.resolve(paths.tokenPath);
  const resolvedHome = pathMod.resolve(userHome);
  const rel = pathMod.relative(resolvedHome, resolvedToken);
  if (rel.startsWith("..") || pathMod.isAbsolute(rel)) {
    throw new Error(
      `Insecure Windows configuration: tokenPath ${paths.tokenPath} must be inside user home ${userHome}`,
    );
  }
}

export function defaultBrokerPaths(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
  platform: NodeJS.Platform = process.platform,
): BrokerPaths {
  if (platform === "win32") {
    const username = env.USERNAME || env.USER || "user";
    const userHash = createHash("sha256")
      .update(`${userHome}\0${username}`)
      .digest("hex")
      .slice(0, 16);
    return {
      transport: "named-pipe",
      runtimeDir: win32.join(userHome, ".toolfence", "runtime"),
      socketPath: `\\\\.\\pipe\\toolfence-${userHash}`,
      tokenPath: win32.join(userHome, ".toolfence", "broker.token"),
    };
  }

  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  const requested = {
    transport: "unix" as const,
    runtimeDir: join(env.XDG_RUNTIME_DIR || env.TMPDIR || tmpdir(), `toolfence-${uid}`),
    tokenPath: join(userHome, ".toolfence", "broker.token"),
  };
  return normalizeBrokerPaths({
    ...requested,
    socketPath: join(requested.runtimeDir, "broker.sock"),
  });
}

function normalizeBrokerPaths(paths: BrokerPaths): BrokerPaths {
  if (isNamedPipePath(paths.socketPath) || Buffer.byteLength(paths.socketPath) <= 96) return paths;
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  const suffix = createHash("sha256").update(paths.socketPath).digest("hex").slice(0, 12);
  const runtimeDir = join("/tmp", `toolfence-${uid}-${suffix}`);
  return {
    transport: paths.transport ?? "unix",
    runtimeDir,
    socketPath: join(runtimeDir, "broker.sock"),
    tokenPath: paths.tokenPath,
  };
}

async function socketIsLive(socketPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (live: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(live);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    setTimeout(() => finish(false), 100).unref();
  });
}

function send(socket: Socket, message: unknown): void {
  if (socket.destroyed || !socket.writable) return;
  try {
    socket.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error && !socket.destroyed) socket.destroy();
    });
  } catch {
    socket.destroy();
  }
}

function safeAction(action: NormalizedAction): Omit<NormalizedAction, "rawArguments"> {
  const { rawArguments: _omitted, ...safe } = action;
  return safe;
}

function parseApprovalRequest(message: Record<string, unknown>): ApprovalRequestMessage | undefined {
  const requestId = message.requestId;
  const action = message.action;
  if (
    message.type !== "approval.request" ||
    message.protocolVersion !== brokerProtocolVersion ||
    typeof message.approvalId !== "string" ||
    typeof message.sessionId !== "string" ||
    !(typeof requestId === "string" || typeof requestId === "number" || requestId === null) ||
    typeof message.reason !== "string" ||
    typeof message.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(message.expiresAt)) ||
    action === null ||
    typeof action !== "object" ||
    Array.isArray(action)
  ) {
    return undefined;
  }
  const candidate = action as Record<string, unknown>;
  if (
    "rawArguments" in candidate ||
    !operations.includes(candidate.operation as (typeof operations)[number]) ||
    !Array.isArray(candidate.resources) ||
    !candidate.resources.every((resource) => typeof resource === "string") ||
    typeof candidate.server !== "string" ||
    typeof candidate.tool !== "string"
  ) {
    return undefined;
  }
  return {
    type: "approval.request",
    protocolVersion: 1,
    approvalId: message.approvalId,
    sessionId: message.sessionId,
    requestId,
    action: candidate as unknown as ApprovalRequestMessage["action"],
    ruleId: typeof message.ruleId === "string" ? message.ruleId : undefined,
    reason: message.reason,
    expiresAt: message.expiresAt,
  };
}

interface AuthenticatedSocket extends Socket {
  brokerRole?: "proxy" | "approvals" | "status";
}

export interface BrokerController {
  server: Server;
  paths: BrokerPaths;
  token: string;
  pendingCount(): number;
  close(): Promise<void>;
}

export async function startBroker(
  paths = defaultBrokerPaths(),
  platform: NodeJS.Platform = process.platform,
  userHome = homedir(),
): Promise<BrokerController> {
  const isWindows = platform === "win32" || isNamedPipePath(paths.socketPath);
  if (isWindows) {
    verifyWindowsSecurity(paths, userHome);
  }
  const actualPaths = isWindows ? paths : normalizeBrokerPaths(paths);
  if (isWindows) {
    mkdirSync(actualPaths.runtimeDir, { recursive: true });
    mkdirSync(dirname(actualPaths.tokenPath), { recursive: true });
  } else {
    mkdirSync(actualPaths.runtimeDir, { recursive: true, mode: 0o700 });
    chmodSync(actualPaths.runtimeDir, 0o700);
    mkdirSync(dirname(actualPaths.tokenPath), { recursive: true, mode: 0o700 });
  }

  if (await socketIsLive(actualPaths.socketPath)) {
    throw new Error(`a ToolFence Broker is already listening at ${actualPaths.socketPath}`);
  }
  if (!isWindows && existsSync(actualPaths.socketPath)) {
    unlinkSync(actualPaths.socketPath);
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(actualPaths.tokenPath, `${token}\n`, { mode: 0o600 });
  if (!isWindows) {
    chmodSync(actualPaths.tokenPath, 0o600);
  }

  const pending = new Map<string, {
    request: ApprovalRequestMessage;
    owner: Socket;
    timeout: NodeJS.Timeout;
  }>();
  const clients = new Set<AuthenticatedSocket>();
  const server = createServer((rawSocket) => {
    const socket = rawSocket as AuthenticatedSocket;
    clients.add(socket);
    socket.on("error", () => undefined);
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        send(socket, { type: "broker.error", message: "invalid JSON" });
        return;
      }
      if (!socket.brokerRole) {
        if (
          message.type !== "auth" ||
          message.protocolVersion !== brokerProtocolVersion ||
          message.token !== token ||
          !["proxy", "approvals", "status"].includes(String(message.role))
        ) {
          send(socket, { type: "broker.error", message: "authentication failed" });
          socket.end();
          return;
        }
        socket.brokerRole = message.role as AuthenticatedSocket["brokerRole"];
        send(socket, { type: "broker.ready", protocolVersion: brokerProtocolVersion });
        return;
      }
      if (message.type === "approval.request" && socket.brokerRole === "proxy") {
        const request = parseApprovalRequest(message);
        if (!request) {
          send(socket, { type: "broker.error", message: "invalid approval request" });
          return;
        }
        if (pending.has(request.approvalId)) {
          send(socket, { type: "broker.error", message: "duplicate approval id" });
          return;
        }
        const timeout = setTimeout(() => {
          const expired = pending.get(request.approvalId);
          if (!expired) return;
          pending.delete(request.approvalId);
          send(expired.owner, {
            type: "approval.resolve",
            protocolVersion: brokerProtocolVersion,
            approvalId: request.approvalId,
            decision: "deny",
          });
        }, Math.max(0, Date.parse(request.expiresAt) - Date.now()));
        pending.set(request.approvalId, { request, owner: socket, timeout });
        for (const client of clients) {
          if (client.brokerRole === "approvals") send(client, request);
        }
        send(socket, { type: "approval.queued", approvalId: request.approvalId });
        return;
      }
      if (message.type === "approval.cancel" && socket.brokerRole === "proxy") {
        const item = pending.get(String(message.approvalId));
        if (item) clearTimeout(item.timeout);
        pending.delete(String(message.approvalId));
        return;
      }
      if (message.type === "approval.list" && socket.brokerRole === "approvals") {
        send(socket, { type: "approval.snapshot", requests: [...pending.values()].map((item) => item.request) });
        return;
      }
      if (message.type === "approval.resolve" && socket.brokerRole === "approvals") {
        const approvalId = String(message.approvalId);
        const item = pending.get(approvalId);
        const decision = message.decision;
        if (item && ["allow-once", "allow-session", "deny"].includes(String(decision))) {
          clearTimeout(item.timeout);
          pending.delete(approvalId);
          send(item.owner, {
            type: "approval.resolve",
            protocolVersion: brokerProtocolVersion,
            approvalId,
            decision,
          });
        }
      }
    });
    socket.once("close", () => {
      clients.delete(socket);
      for (const [id, item] of pending) {
        if (item.owner !== socket) continue;
        clearTimeout(item.timeout);
        pending.delete(id);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(actualPaths.socketPath, () => {
      server.off("error", reject);
      if (!isWindows) {
        try {
          chmodSync(actualPaths.socketPath, 0o600);
          resolve();
        } catch (error) {
          server.close();
          reject(error);
        }
      } else {
        resolve();
      }
    });
  });

  return {
    server,
    paths: actualPaths,
    token,
    pendingCount: () => pending.size,
    close: () => new Promise<void>((resolve, reject) => {
      for (const item of pending.values()) clearTimeout(item.timeout);
      pending.clear();
      for (const client of clients) client.destroy();
      server.close((error) => {
        if (!isWindows && existsSync(actualPaths.socketPath)) unlinkSync(actualPaths.socketPath);
        error ? reject(error) : resolve();
      });
    }),
  };
}

async function connectAuthenticated(
  role: "proxy" | "approvals" | "status",
  paths: BrokerPaths,
  userHome = homedir(),
): Promise<Socket> {
  const isWindows = process.platform === "win32" || isNamedPipePath(paths.socketPath);
  if (isWindows) {
    verifyWindowsSecurity(paths, userHome);
  }
  const token = readFileSync(paths.tokenPath, "utf8").trim();
  const socket = createConnection(paths.socketPath);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    socket.once("error", onError);
    socket.once("connect", () => {
      const lines = createInterface({ input: socket, crlfDelay: Infinity });
      lines.once("line", (line) => {
        socket.off("error", onError);
        let response: { type?: string; protocolVersion?: number };
        try {
          response = JSON.parse(line) as { type?: string; protocolVersion?: number };
        } catch {
          socket.destroy();
          reject(new Error("Broker returned invalid JSON during authentication"));
          return;
        }
        if (response.type !== "broker.ready" || response.protocolVersion !== brokerProtocolVersion) {
          socket.destroy();
          reject(new Error("Broker authentication or protocol negotiation failed"));
          return;
        }
        lines.close();
        resolve();
      });
      send(socket, { type: "auth", protocolVersion: brokerProtocolVersion, token, role });
    });
  });
  return socket;
}

export class BrokerApprovalRequester implements ApprovalRequester {
  private readonly grants = new Map<string, string>();
  private readonly fingerprints = new Map<string, string>();
  private readonly active = new Map<string, { socket: Socket; approvalId: string }>();

  constructor(
    private readonly paths = defaultBrokerPaths(),
    private readonly timeoutMs = 60_000,
    private readonly userHome = homedir(),
  ) {}

  updateToolFingerprint(server: string, tool: string, fingerprint: string): void {
    const id = `${server}\0${tool}`;
    const previous = this.fingerprints.get(id);
    this.fingerprints.set(id, fingerprint);
    if (previous && previous !== fingerprint) {
      for (const grant of this.grants.keys()) {
        if (grant.startsWith(`${id}\0`)) this.grants.delete(grant);
      }
    }
  }

  async request(action: NormalizedAction, decision: Decision, context?: ApprovalContext): Promise<boolean> {
    return (await this.requestWithOutcome(action, decision, context)).approved;
  }

  async requestWithOutcome(
    action: NormalizedAction,
    decision: Decision,
    context?: ApprovalContext,
  ): Promise<ApprovalOutcome> {
    if (!context || context.signal?.aborted) {
      return { approved: false, approvalId: context?.approvalId, resolution: "deny" };
    }
    const fingerprint = context.schemaFingerprint ?? "unknown";
    const grantKey = `${action.server}\0${action.tool}\0${action.operation}\0${fingerprint}`;
    const grantApprovalId = this.grants.get(grantKey);
    if (grantApprovalId !== undefined) {
      return {
        approved: true,
        approvalId: grantApprovalId,
        resolution: "allow-session",
      };
    }

    let socket: Socket;
    try {
      socket = await connectAuthenticated("proxy", this.paths, this.userHome);
    } catch {
      return { approved: false, approvalId: context.approvalId, resolution: "deny" };
    }
    if (context.signal?.aborted) {
      socket.destroy();
      return { approved: false, approvalId: context.approvalId, resolution: "deny" };
    }
    const approvalId = context.approvalId ?? randomUUID();
    const requestKey = `${typeof context.requestId}:${String(context.requestId)}`;
    this.active.set(requestKey, { socket, approvalId });
    const expiresAt = new Date(Date.now() + this.timeoutMs).toISOString();

    return await new Promise<ApprovalOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: ApprovalOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        context.signal?.removeEventListener("abort", onAbort);
        this.active.delete(requestKey);
        socket.destroy();
        resolve(outcome);
      };
      const cancel = (reason: BrokerCancelReason) => {
        send(socket, { type: "approval.cancel", protocolVersion: 1, approvalId, reason });
        finish({ approved: false, approvalId, resolution: "deny" });
      };
      const onAbort = () => cancel("client-cancelled");
      const timer = setTimeout(() => cancel("timeout"), this.timeoutMs);
      context.signal?.addEventListener("abort", onAbort, { once: true });
      if (context.signal?.aborted) {
        onAbort();
        return;
      }
      const lines = createInterface({ input: socket, crlfDelay: Infinity });
      lines.on("line", (line) => {
        let message: { type?: string; approvalId?: string; decision?: BrokerDecision };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          finish({ approved: false, approvalId, resolution: "deny" });
          return;
        }
        if (message.type !== "approval.resolve" || message.approvalId !== approvalId) return;
        if (message.decision === "allow-session") this.grants.set(grantKey, approvalId);
        finish({
          approved: message.decision === "allow-once" || message.decision === "allow-session",
          approvalId,
          resolution: message.decision ?? "deny",
        });
      });
      socket.once("close", () => finish({ approved: false, approvalId, resolution: "deny" }));
      socket.once("error", () => finish({ approved: false, approvalId, resolution: "deny" }));
      send(socket, {
        type: "approval.request",
        protocolVersion: 1,
        approvalId,
        sessionId: context.sessionId,
        requestId: context.requestId,
        action: safeAction(action),
        ruleId: decision.ruleId,
        reason: decision.reason,
        expiresAt,
      } satisfies ApprovalRequestMessage);
    });
  }

  cancel(requestId: JsonRpcId, reason: BrokerCancelReason): void {
    const key = `${typeof requestId}:${String(requestId)}`;
    const active = this.active.get(key);
    if (!active) return;
    send(active.socket, { type: "approval.cancel", protocolVersion: 1, approvalId: active.approvalId, reason });
    active.socket.destroy();
    this.active.delete(key);
  }
}

export async function brokerStatus(
  paths = defaultBrokerPaths(),
  platform: NodeJS.Platform = process.platform,
  userHome = homedir(),
): Promise<BrokerStatusResult> {
  const isWindows = platform === "win32" || isNamedPipePath(paths.socketPath);
  if (isWindows) {
    verifyWindowsSecurity(paths, userHome);
  }
  const socket = await connectAuthenticated("status", paths, userHome);
  socket.end();
  const socketMode = isWindows
    ? 0
    : statSync(paths.socketPath).mode & 0o777;
  return {
    protocolVersion: brokerProtocolVersion,
    socketMode,
    transport: isWindows ? "named-pipe" : "unix",
    platform,
  };
}

export async function listApprovals(
  paths = defaultBrokerPaths(),
  userHome = homedir(),
): Promise<{ socket: Socket; requests: ApprovalRequestMessage[] }> {
  const socket = await connectAuthenticated("approvals", paths, userHome);
  return await new Promise((resolve, reject) => {
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    socket.once("error", reject);
    lines.on("line", (line) => {
      let message: { type?: string; requests?: ApprovalRequestMessage[] };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        socket.destroy();
        reject(new Error("Broker returned invalid JSON"));
        return;
      }
      if (message.type === "approval.snapshot") resolve({ socket, requests: message.requests ?? [] });
    });
    send(socket, { type: "approval.list", protocolVersion: 1 });
  });
}

export function resolveApproval(socket: Socket, approvalId: string, decision: BrokerDecision): void {
  send(socket, { type: "approval.resolve", protocolVersion: 1, approvalId, decision });
}
