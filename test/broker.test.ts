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

async function waitForNoPending(count: () => number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (count() === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("approval was not removed after timeout");
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
      const result = requester.requestWithOutcome(action, { effect: "ask", reason: "test" }, {
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
      await expect(result).resolves.toEqual({
        approved: true,
        approvalId: listed.requests[0].approvalId,
        resolution: "allow-once",
      });
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
      const first = requester.requestWithOutcome(action, { effect: "ask", reason: "test" }, context);
      await waitForPending(broker.pendingCount);
      const listed = await listApprovals(broker.paths);
      resolveApproval(listed.socket, listed.requests[0].approvalId, "allow-session");
      await expect(first).resolves.toEqual({
        approved: true,
        approvalId: listed.requests[0].approvalId,
        resolution: "allow-session",
      });
      listed.socket.end();
      await expect(requester.requestWithOutcome(action, { effect: "ask", reason: "test" }, {
        ...context,
        requestId: 2,
      })).resolves.toEqual({
        approved: true,
        approvalId: listed.requests[0].approvalId,
        resolution: "allow-session",
      });
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

  it("does not enqueue an approval cancelled during Broker connection", async () => {
    const broker = await startBroker(paths(mkdtempSync(join(tmpdir(), "toolfence-broker-"))));
    try {
      const requester = new BrokerApprovalRequester(broker.paths, 2_000);
      const abort = new AbortController();
      const outcome = requester.requestWithOutcome(action, { effect: "ask", reason: "test" }, {
        requestId: "cancel-during-connect",
        sessionId: "session-a",
        approvalId: "approval-connect-race",
        schemaFingerprint: "schema-a",
        signal: abort.signal,
      });
      abort.abort();
      await expect(Promise.race([
        outcome,
        new Promise((_, reject) => setTimeout(() => reject(new Error("cancellation was not prompt")), 500)),
      ])).resolves.toEqual({
        approved: false,
        approvalId: "approval-connect-race",
        resolution: "deny",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(broker.pendingCount()).toBe(0);

      const followup = requester.requestWithOutcome(action, { effect: "ask", reason: "test" }, {
        requestId: "after-cancel",
        sessionId: "session-a",
        schemaFingerprint: "schema-a",
      });
      await waitForPending(broker.pendingCount);
      const listed = await listApprovals(broker.paths);
      expect(listed.requests).toHaveLength(1);
      resolveApproval(listed.socket, listed.requests[0].approvalId, "deny");
      await expect(followup).resolves.toMatchObject({ approved: false, resolution: "deny" });
      listed.socket.end();
    } finally {
      await broker.close();
    }
  });

  it("removes a timed-out approval from the Broker pending queue", async () => {
    const broker = await startBroker(paths(mkdtempSync(join(tmpdir(), "toolfence-broker-"))));
    try {
      const requester = new BrokerApprovalRequester(broker.paths, 20);
      const outcome = requester.requestWithOutcome(action, { effect: "ask", reason: "test" }, {
        requestId: "timeout",
        sessionId: "session-a",
        approvalId: "approval-timeout",
        schemaFingerprint: "schema-a",
      });
      await waitForPending(broker.pendingCount);
      await expect(outcome).resolves.toEqual({
        approved: false,
        approvalId: "approval-timeout",
        resolution: "deny",
      });
      await waitForNoPending(broker.pendingCount);
    } finally {
      await broker.close();
    }
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
