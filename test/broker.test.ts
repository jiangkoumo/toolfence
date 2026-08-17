import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BrokerApprovalRequester,
  defaultBrokerPaths,
  listApprovals,
  resolveApproval,
  startBroker,
} from "../src/broker.js";
import type { NormalizedAction } from "../src/types.js";

function paths(root: string) {
  return {
    runtimeDir: join(root, "run"),
    socketPath: join(root, "run", "broker.sock"),
    tokenPath: join(root, "home", ".toolfence", "broker.token"),
  };
}

const action: NormalizedAction = {
  operation: "fs.read",
  resources: ["/workspace/README.md"],
  server: "filesystem",
  tool: "read_file",
  rawArguments: { path: "/workspace/README.md", secret: "do-not-send" },
};

async function waitForPending(count: () => number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (count() > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("approval was not queued");
}

describe("local approval Broker", () => {
  it("derives the same safe short Socket path for every default client", () => {
    const env = { TMPDIR: `/tmp/${"very-long-directory/".repeat(8)}` };
    const first = defaultBrokerPaths(env, "/tmp/home");
    const second = defaultBrokerPaths(env, "/tmp/home");
    expect(first).toEqual(second);
    expect(Buffer.byteLength(first.socketPath)).toBeLessThanOrEqual(96);
    expect(first.socketPath).toContain("/tmp/toolfence-");
  });

  it("approves without a controlling terminal and never sends raw arguments", async () => {
    const broker = await startBroker(paths(mkdtempSync(join(tmpdir(), "toolfence-broker-"))));
    try {
      expect(statSync(broker.paths.runtimeDir).mode & 0o777).toBe(0o700);
      expect(statSync(broker.paths.socketPath).mode & 0o777).toBe(0o600);
      expect(statSync(broker.paths.tokenPath).mode & 0o777).toBe(0o600);
      const requester = new BrokerApprovalRequester(broker.paths, 1_000);
      const result = requester.request(action, { effect: "ask", reason: "test" }, {
        requestId: 1,
        sessionId: "session-a",
        schemaFingerprint: "schema-a",
      });
      await waitForPending(broker.pendingCount);
      const listed = await listApprovals(broker.paths);
      expect(listed.requests).toHaveLength(1);
      expect(JSON.stringify(listed.requests)).not.toContain("rawArguments");
      expect(JSON.stringify(listed.requests)).not.toContain("do-not-send");
      resolveApproval(listed.socket, listed.requests[0].approvalId, "allow-once");
      expect(await result).toBe(true);
      listed.socket.end();
    } finally {
      await broker.close();
    }
  });

  it("caches allow-session only for the exact schema fingerprint", async () => {
    const broker = await startBroker(paths(mkdtempSync(join(tmpdir(), "toolfence-broker-"))));
    try {
      const requester = new BrokerApprovalRequester(broker.paths, 1_000);
      requester.updateToolFingerprint("filesystem", "read_file", "schema-a");
      const context = { requestId: 1, sessionId: "session-a", schemaFingerprint: "schema-a" };
      const first = requester.request(action, { effect: "ask", reason: "test" }, context);
      await waitForPending(broker.pendingCount);
      const listed = await listApprovals(broker.paths);
      resolveApproval(listed.socket, listed.requests[0].approvalId, "allow-session");
      expect(await first).toBe(true);
      listed.socket.end();
      expect(await requester.request(action, { effect: "ask", reason: "test" }, {
        ...context,
        requestId: 2,
      })).toBe(true);
      expect(broker.pendingCount()).toBe(0);

      requester.updateToolFingerprint("filesystem", "read_file", "schema-b");
      const changed = requester.request(action, { effect: "ask", reason: "test" }, {
        ...context,
        requestId: 3,
        schemaFingerprint: "schema-b",
      });
      await waitForPending(broker.pendingCount);
      const changedList = await listApprovals(broker.paths);
      resolveApproval(changedList.socket, changedList.requests[0].approvalId, "deny");
      expect(await changed).toBe(false);
      changedList.socket.end();
    } finally {
      await broker.close();
    }
  });

  it("fails closed on cancellation and Broker unavailability", async () => {
    const brokerPaths = paths(mkdtempSync(join(tmpdir(), "toolfence-broker-")));
    const broker = await startBroker(brokerPaths);
    const requester = new BrokerApprovalRequester(broker.paths, 1_000);
    const abort = new AbortController();
    const result = requester.request(action, { effect: "ask", reason: "test" }, {
      requestId: "cancel-me",
      sessionId: "session-a",
      schemaFingerprint: "schema-a",
      signal: abort.signal,
    });
    await waitForPending(broker.pendingCount);
    abort.abort();
    expect(await result).toBe(false);
    await broker.close();
    expect(await requester.request(action, { effect: "ask", reason: "test" }, {
      requestId: "offline",
      sessionId: "session-a",
      schemaFingerprint: "schema-a",
    })).toBe(false);
  });

  it("rejects a second Broker instead of replacing a live Socket", async () => {
    const brokerPaths = paths(mkdtempSync(join(tmpdir(), "toolfence-broker-")));
    const broker = await startBroker(brokerPaths);
    try {
      await expect(startBroker(brokerPaths)).rejects.toThrow(/already listening/);
    } finally {
      await broker.close();
    }
  });
});
