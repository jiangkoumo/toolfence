import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BrokerApprovalRequester,
  brokerStatus,
  defaultBrokerPaths,
  isNamedPipePath,
  startBroker,
  verifyWindowsSecurity,
  type BrokerPaths,
} from "../src/broker.js";
import { diagnose } from "../src/doctor.js";

describe("cross-platform Broker transport & security invariants", () => {
  it("derives user-scoped Named Pipe paths on Windows platform", () => {
    const fakeHome = "C:\\Users\\alice";
    const paths = defaultBrokerPaths(
      { USERNAME: "alice" },
      fakeHome,
      "win32",
    );

    expect(paths.transport).toBe("named-pipe");
    expect(paths.socketPath).toMatch(/^\\\\\.\\pipe\\toolfence-[a-f0-9]{16}$/);
    expect(paths.tokenPath).toBe("C:\\Users\\alice\\.toolfence\\broker.token");
    expect(isNamedPipePath(paths.socketPath)).toBe(true);
  });

  it("verifies Windows security constraints and enforces fail-closed boundary", () => {
    const userHome = "/Users/testuser";
    const validPaths: BrokerPaths = {
      transport: "named-pipe",
      runtimeDir: join(userHome, ".toolfence", "runtime"),
      socketPath: "\\\\.\\pipe\\toolfence-12345678abcdef01",
      tokenPath: join(userHome, ".toolfence", "broker.token"),
    };

    // Valid configuration succeeds
    expect(() => verifyWindowsSecurity(validPaths, userHome)).not.toThrow();

    // Insecure non-pipe socket path fails closed
    const nonPipePaths: BrokerPaths = {
      ...validPaths,
      socketPath: "/tmp/insecure-broker.sock",
    };
    expect(() => verifyWindowsSecurity(nonPipePaths, userHome)).toThrow(
      /Insecure Windows configuration: socketPath must be a local named pipe/,
    );

    // Token path escaping user home fails closed
    const escapingTokenPaths: BrokerPaths = {
      ...validPaths,
      tokenPath: "/tmp/global-shared/broker.token",
    };
    expect(() => verifyWindowsSecurity(escapingTokenPaths, userHome)).toThrow(
      /Insecure Windows configuration: tokenPath .* must be inside user home/,
    );

    const relativeEscapePaths: BrokerPaths = {
      ...validPaths,
      tokenPath: join(userHome, "..", "attacker", "broker.token"),
    };
    expect(() => verifyWindowsSecurity(relativeEscapePaths, userHome)).toThrow(
      /Insecure Windows configuration: tokenPath .* must be inside user home/,
    );
  });

  it("returns platform-neutral BrokerStatusResult from live Broker", async () => {
    const root = mkdtempSync(join(tmpdir(), "toolfence-status-test-"));
    const paths: BrokerPaths = {
      runtimeDir: join(root, "run"),
      socketPath: join(root, "run", "broker.sock"),
      tokenPath: join(root, "home", ".toolfence", "broker.token"),
    };

    const broker = await startBroker(paths);
    try {
      const status = await brokerStatus(broker.paths);
      expect(status.protocolVersion).toBe(1);
      expect(status.transport).toBe("unix");
      expect(status.platform).toBe(process.platform);
      expect(status.socketMode).toBe(0o600);
    } finally {
      await broker.close();
    }
  });

  it("evaluates Windows Broker security in Doctor and fails on insecure paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "toolfence-doc-win-"));

    // Insecure Windows configuration: non-pipe socket
    const insecureReport = await diagnose(
      { workspace: root, args: [] },
      {
        platform: "win32",
        userHome: root,
        brokerPaths: {
          transport: "unix",
          runtimeDir: join(root, "run"),
          socketPath: join(root, "run", "not-a-pipe.sock"),
          tokenPath: join(root, ".toolfence", "broker.token"),
        },
        conformanceRoot: join(root, "no-conformance"),
      },
    );
    const insecureCheck = insecureReport.checks.find((c) => c.check === "broker");
    expect(insecureCheck?.status).toBe("fail");
    expect(insecureCheck?.message).toContain("Insecure Windows configuration");

    // Legitimate Named Pipe path, not running yet -> reports warn (not fail)
    const validPipeReport = await diagnose(
      { workspace: root, args: [] },
      {
        platform: "win32",
        userHome: root,
        brokerPaths: {
          transport: "named-pipe",
          runtimeDir: join(root, "runtime"),
          socketPath: "\\\\.\\pipe\\toolfence-testpipe1234",
          tokenPath: join(root, ".toolfence", "broker.token"),
        },
        conformanceRoot: join(root, "no-conformance"),
      },
    );
    const validPipeCheck = validPipeReport.checks.find((c) => c.check === "broker");
    expect(validPipeCheck?.status).toBe("warn");
    expect(validPipeCheck?.message).toContain("start it with 'toolfence broker'");
  });

  it("strictly validates named pipe format and rejects empty names or path traversals", () => {
    expect(isNamedPipePath("\\\\.\\pipe\\toolfence-valid123")).toBe(true);
    expect(isNamedPipePath("//./pipe/toolfence-valid123")).toBe(true);

    // Empty pipe name
    expect(isNamedPipePath("\\\\.\\pipe\\")).toBe(false);
    expect(isNamedPipePath("//./pipe/")).toBe(false);

    // Path traversal in pipe name
    expect(isNamedPipePath("\\\\.\\pipe\\..\\escape")).toBe(false);
    expect(isNamedPipePath("\\\\.\\pipe\\sub/dir")).toBe(false);
    expect(isNamedPipePath("\\\\.\\pipe\\sub\\dir")).toBe(false);

    // Non-pipe prefix
    expect(isNamedPipePath("C:\\Windows\\Temp\\pipe")).toBe(false);
    expect(isNamedPipePath("/var/run/broker.sock")).toBe(false);
  });

  it("enforces verifyWindowsSecurity on BrokerApprovalRequester client connection", async () => {
    const root = mkdtempSync(join(tmpdir(), "toolfence-client-sec-"));
    const invalidPaths: BrokerPaths = {
      transport: "named-pipe",
      runtimeDir: join(root, "runtime"),
      socketPath: "\\\\.\\pipe\\toolfence-test",
      tokenPath: "/tmp/insecure-token-outside-home",
    };

    const requester = new BrokerApprovalRequester(invalidPaths, 1000, root);
    const outcome = await requester.requestWithOutcome(
      {
        actionModelVersion: "1.0",
        operation: "fs.read",
        resources: ["/workspace/test"],
        server: "fs",
        tool: "read",
        rawArguments: {},
      },
      { effect: "ask", reason: "testing client security check" },
      { requestId: 1, sessionId: "sess-1" },
    );

    // Client fails closed on insecure configuration
    expect(outcome.approved).toBe(false);
    expect(outcome.resolution).toBe("deny");
  });
});
