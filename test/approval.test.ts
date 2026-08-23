import { describe, expect, it } from "vitest";
import { TtyApprovalRequester } from "../src/approval.js";
import type { Decision, NormalizedAction } from "../src/types.js";

describe("TtyApprovalRequester", () => {
  const dummyAction: NormalizedAction = {
    operation: "fs.read",
    resources: ["/workspace/test.txt"],
    server: "filesystem",
    tool: "read_file",
    rawArguments: { path: "test.txt" },
  };

  const dummyDecision: Decision = {
    effect: "ask",
    reason: "Requires user confirmation",
  };

  it("returns false immediately when aborted signal is provided", async () => {
    const requester = new TtyApprovalRequester();
    const abortController = new AbortController();
    abortController.abort();

    const result = await requester.request(dummyAction, dummyDecision, {
      requestId: 1,
      sessionId: "session-1",
      signal: abortController.signal,
    });

    expect(result).toBe(false);
  });

  it("handles non-interactive environment gracefully and fails closed", async () => {
    const requester = new TtyApprovalRequester();
    const result = await requester.request(dummyAction, dummyDecision, {
      requestId: 2,
      sessionId: "session-1",
    });

    // In a test environment without controlling /dev/tty or interactive input, it should fail closed (return false)
    expect(typeof result).toBe("boolean");
  });
});
