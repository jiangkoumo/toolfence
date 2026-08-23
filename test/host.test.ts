import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCli } from "../src/cli.js";
import {
  generateHostSnippet,
  injectHostConfig,
  normalizeHost,
  resolveHostConfigPath,
  supportedHosts,
} from "../src/host.js";

describe("host normalization and paths", () => {
  it("normalizes supported host aliases", () => {
    expect(normalizeHost("cursor")).toBe("cursor");
    expect(normalizeHost("Cursor ")).toBe("cursor");
    expect(normalizeHost("claude")).toBe("claude-desktop");
    expect(normalizeHost("claude-desktop")).toBe("claude-desktop");
    expect(normalizeHost("desktop")).toBe("claude-desktop");
    expect(normalizeHost("claude-code")).toBe("claude-code");
    expect(normalizeHost("claudecode")).toBe("claude-code");
    expect(normalizeHost("codex")).toBe("codex");

    expect(() => normalizeHost("unsupported-host")).toThrow(
      /Unsupported host: unsupported-host/,
    );
  });

  it("resolves host configuration paths across platforms and scopes", () => {
    const workspace = "/test/workspace";
    const home = "/home/testuser";

    // Cursor
    expect(resolveHostConfigPath("cursor", { workspace, home, scope: "project" })).toBe(
      "/test/workspace/.cursor/mcp.json",
    );
    expect(resolveHostConfigPath("cursor", { workspace, home, scope: "global" })).toBe(
      "/home/testuser/.cursor/mcp.json",
    );

    // Claude Desktop (macOS, Windows, Linux)
    expect(
      resolveHostConfigPath("claude-desktop", {
        workspace,
        home,
        platform: "darwin",
      }),
    ).toBe("/home/testuser/Library/Application Support/Claude/claude_desktop_config.json");

    expect(
      resolveHostConfigPath("claude-desktop", {
        workspace,
        home,
        platform: "win32",
        env: { APPDATA: "C:\\Users\\testuser\\AppData\\Roaming" },
      }),
    ).toBe("C:\\Users\\testuser\\AppData\\Roaming/Claude/claude_desktop_config.json");

    expect(
      resolveHostConfigPath("claude-desktop", {
        workspace,
        home,
        platform: "linux",
        env: { XDG_CONFIG_HOME: "/home/testuser/.config" },
      }),
    ).toBe("/home/testuser/.config/Claude/claude_desktop_config.json");

    // Claude Code
    expect(resolveHostConfigPath("claude-code", { workspace, home, scope: "project" })).toBe(
      "/test/workspace/.claude.json",
    );
    expect(resolveHostConfigPath("claude-code", { workspace, home, scope: "global" })).toBe(
      "/home/testuser/.claude.json",
    );

    // Codex
    expect(resolveHostConfigPath("codex", { workspace, home, scope: "project" })).toBe(
      "/test/workspace/.codex/config.toml",
    );
    expect(resolveHostConfigPath("codex", { workspace, home, scope: "global" })).toBe(
      "/home/testuser/.codex/config.toml",
    );
  });
});

describe("generateHostSnippet", () => {
  it("generates valid JSON snippet with default filesystem server for Cursor", () => {
    const workspace = mkdtempSync(join(tmpdir(), "toolfence-host-"));
    const result = generateHostSnippet({
      host: "cursor",
      workspace,
    });

    expect(result.host).toBe("cursor");
    expect(result.server).toBe("filesystem");
    expect(result.format).toBe("json");

    const parsed = result.snippet as { mcpServers: { filesystem: { command: string; args: string[] } } };
    expect(parsed.mcpServers.filesystem.command).toBe("toolfence");
    expect(parsed.mcpServers.filesystem.args).toContain("wrap");
    expect(parsed.mcpServers.filesystem.args.some((arg) => arg.endsWith("toolfence.yaml"))).toBe(true);
    expect(parsed.mcpServers.filesystem.args).toContain("@modelcontextprotocol/server-filesystem");
  });

  it("generates TOML snippet for Codex with custom upstream command", () => {
    const workspace = mkdtempSync(join(tmpdir(), "toolfence-host-"));
    const result = generateHostSnippet({
      host: "codex",
      server: "custom-srv",
      policy: join(workspace, "custom-policy.yaml"),
      workspace,
      upstreamCommand: "node",
      args: ["./custom-server.js"],
    });

    expect(result.host).toBe("codex");
    expect(result.server).toBe("custom-srv");
    expect(result.format).toBe("toml");
    expect(result.rendered).toContain("[mcp_servers.custom-srv]");
    expect(result.rendered).toContain(`command = "toolfence"`);
    expect(result.rendered).toContain(`"node",`);
    expect(result.rendered).toContain(`"./custom-server.js",`);
  });
});

describe("injectHostConfig", () => {
  it("creates a new JSON config file when none exists", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "toolfence-inject-"));
    const workspace = join(tempDir, "proj");

    const result = injectHostConfig({
      host: "cursor",
      workspace,
    });

    expect(result.created).toBe(true);
    expect(result.updated).toBe(false);
    expect(result.backupPath).toBeUndefined();
    expect(existsSync(result.configPath)).toBe(true);

    const saved = JSON.parse(readFileSync(result.configPath, "utf8"));
    expect(saved.mcpServers.filesystem.command).toBe("toolfence");
  });

  it("merges into an existing JSON config and creates a backup", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "toolfence-inject-"));
    const workspace = join(tempDir, "proj");
    const configPath = join(workspace, ".cursor", "mcp.json");

    injectHostConfig({ host: "cursor", workspace, server: "first-srv" });
    expect(existsSync(configPath)).toBe(true);

    // Inject second server into existing config
    const result = injectHostConfig({
      host: "cursor",
      workspace,
      server: "second-srv",
    });

    expect(result.created).toBe(false);
    expect(result.updated).toBe(true);
    expect(result.backupPath).toBeDefined();
    expect(existsSync(result.backupPath!)).toBe(true);

    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    expect(saved.mcpServers["first-srv"]).toBeDefined();
    expect(saved.mcpServers["second-srv"]).toBeDefined();
  });

  it("merges into an existing TOML config for Codex", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "toolfence-inject-"));
    const workspace = join(tempDir, "proj");
    const configPath = join(workspace, ".codex", "config.toml");

    injectHostConfig({ host: "codex", workspace, server: "first-srv" });
    const result = injectHostConfig({ host: "codex", workspace, server: "second-srv" });

    expect(result.created).toBe(false);
    expect(result.updated).toBe(true);

    const saved = readFileSync(configPath, "utf8");
    expect(saved).toContain("[mcp_servers.first-srv]");
    expect(saved).toContain("[mcp_servers.second-srv]");
  });
});

describe("CLI host parsing", () => {
  it("parses toolfence host init flags", () => {
    const parsed = parseCli(["host", "init", "--host", "cursor", "--write"]);
    expect(parsed).toEqual({
      command: "host-init",
      host: "cursor",
      policy: undefined,
      server: undefined,
      workspace: expect.any(String),
      scope: undefined,
      write: true,
      json: false,
      upstreamCommand: undefined,
      args: [],
    });
  });

  it("parses toolfence init --host alias", () => {
    const parsed = parseCli(["init", "--host", "codex", "--json"]);
    expect(parsed).toEqual({
      command: "host-init",
      host: "codex",
      policy: undefined,
      server: undefined,
      workspace: expect.any(String),
      scope: undefined,
      write: false,
      json: true,
      upstreamCommand: undefined,
      args: [],
    });
  });

  it("parses explicit upstream command after --", () => {
    const parsed = parseCli([
      "host",
      "init",
      "--host",
      "claude-desktop",
      "--",
      "npx",
      "-y",
      "@modelcontextprotocol/server-postgres",
      "postgresql://localhost/db",
    ]);

    expect(parsed).toMatchObject({
      command: "host-init",
      host: "claude-desktop",
      upstreamCommand: "npx",
      args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/db"],
    });
  });

  it("executes runCli for host init preview and write", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "toolfence-host-cli-"));
    const stdoutChunks: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      stdoutChunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      // Preview
      await (await import("../src/cli.js")).runCli(["host", "init", "--host", "cursor", "--workspace", workspace]);
      expect(stdoutChunks.join("")).toContain("Target configuration");

      // Write
      stdoutChunks.length = 0;
      await (await import("../src/cli.js")).runCli(["host", "init", "--host", "cursor", "--workspace", workspace, "--write"]);
      expect(stdoutChunks.join("")).toContain("Created cursor config");
      expect(existsSync(join(workspace, ".cursor", "mcp.json"))).toBe(true);

      // JSON output
      stdoutChunks.length = 0;
      await (await import("../src/cli.js")).runCli(["host", "snippet", "--host", "cursor", "--workspace", workspace, "--json"]);
      const parsed = JSON.parse(stdoutChunks.join(""));
      expect(parsed.host).toBe("cursor");
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});

