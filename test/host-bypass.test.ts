import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  generateHostSnippet,
  getHostSecurityProfile,
  injectHostConfig,
  supportedHosts,
  type SupportedHost,
} from "../src/host.js";

describe("host-native tool bypass reporting", () => {
  it("provides comprehensive security profiles and bypass disclosure for all supported hosts", () => {
    for (const host of supportedHosts) {
      const profile = getHostSecurityProfile(host);
      expect(profile).toBeDefined();
      expect(profile.displayName).toBeTruthy();
      expect(profile.bypassWarning).toBeTruthy();
      expect(profile.nativeBypassTools.length).toBeGreaterThan(0);

      for (const tool of profile.nativeBypassTools) {
        expect(tool.name).toBeTruthy();
        expect(["shell", "filesystem", "mcp-direct"]).toContain(tool.category);
        expect(["high", "medium"]).toContain(tool.risk);
        expect(tool.description).toBeTruthy();
      }
    }
  });

  it("includes specific shell bypass disclosure for codex, cursor, and claude-code", () => {
    const codex = getHostSecurityProfile("codex");
    expect(codex.bypassWarning).toContain("exec");
    expect(codex.nativeBypassTools.some((t) => t.name === "exec" && t.risk === "high")).toBe(true);

    const cursor = getHostSecurityProfile("cursor");
    expect(cursor.bypassWarning).toContain("terminal");
    expect(cursor.nativeBypassTools.some((t) => t.category === "shell")).toBe(true);

    const claudeCode = getHostSecurityProfile("claude-code");
    expect(claudeCode.bypassWarning).toContain("Bash");
    expect(claudeCode.nativeBypassTools.some((t) => t.name === "Bash")).toBe(true);

    const desktop = getHostSecurityProfile("claude-desktop");
    expect(desktop.nativeBypassTools.some((t) => t.category === "mcp-direct")).toBe(true);
  });

  it("attaches securityProfile to snippet generation and config injection results", () => {
    const root = mkdtempSync(join(tmpdir(), "toolfence-host-bypass-"));
    const snippetResult = generateHostSnippet({
      host: "cursor",
      workspace: root,
    });
    expect(snippetResult.securityProfile).toBeDefined();
    expect(snippetResult.securityProfile.host).toBe("cursor");
    expect(snippetResult.securityProfile.nativeBypassTools).toHaveLength(2);

    const injectResult = injectHostConfig({
      host: "cursor",
      workspace: root,
    });
    expect(injectResult.securityProfile).toBeDefined();
    expect(injectResult.securityProfile.host).toBe("cursor");
  });
});
