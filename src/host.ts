import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { canonicalizePath } from "./paths.js";

export const supportedHosts = [
  "cursor",
  "claude",
  "claude-desktop",
  "claude-code",
  "codex",
] as const;

export type SupportedHost = (typeof supportedHosts)[number];

export interface HostNativeBypassTool {
  name: string;
  category: "shell" | "filesystem" | "mcp-direct";
  description: string;
  risk: "high" | "medium";
}

export interface HostSecurityProfile {
  host: SupportedHost;
  displayName: string;
  nativeBypassTools: HostNativeBypassTool[];
  bypassWarning: string;
}

export interface HostConfigOptions {
  host: SupportedHost;
  server?: string;
  policy?: string;
  workspace?: string;
  upstreamCommand?: string;
  args?: string[];
  scope?: "project" | "global";
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export interface HostSnippetResult {
  host: SupportedHost;
  server: string;
  configPath: string;
  format: "json" | "toml";
  snippet: Record<string, unknown> | string;
  rendered: string;
  securityProfile: HostSecurityProfile;
}

export interface HostInjectResult {
  host: SupportedHost;
  server: string;
  configPath: string;
  created: boolean;
  updated: boolean;
  backupPath?: string;
  content: string;
  securityProfile: HostSecurityProfile;
}

export function normalizeHost(input: string): SupportedHost {
  const normalized = input.trim().toLowerCase();
  if (normalized === "cursor") return "cursor";
  if (normalized === "claude" || normalized === "claude-desktop" || normalized === "desktop") return "claude-desktop";
  if (normalized === "claude-code" || normalized === "claudecode") return "claude-code";
  if (normalized === "codex") return "codex";
  throw new Error(`Unsupported host: ${input}. Supported hosts: ${supportedHosts.join(", ")}`);
}

const hostSecurityProfiles: Record<SupportedHost, HostSecurityProfile> = {
  codex: {
    host: "codex",
    displayName: "Codex CLI",
    nativeBypassTools: [
      {
        name: "exec",
        category: "shell",
        description: "Built-in shell command execution executed directly on the host system",
        risk: "high",
      },
      {
        name: "file_search / file_edit",
        category: "filesystem",
        description: "Built-in filesystem inspection and editing operated outside MCP",
        risk: "high",
      },
    ],
    bypassWarning:
      "Codex provides built-in tools (exec, file_search, file_edit) that operate directly on the host without passing through MCP. ToolFence only mediates MCP tool calls configured in config.toml.",
  },
  cursor: {
    host: "cursor",
    displayName: "Cursor IDE",
    nativeBypassTools: [
      {
        name: "Terminal / bash",
        category: "shell",
        description: "Integrated terminal and agent bash execution executed inside the workspace",
        risk: "high",
      },
      {
        name: "Composer / File Edit",
        category: "filesystem",
        description: "Native editor code generation and file modification operated by the IDE",
        risk: "high",
      },
    ],
    bypassWarning:
      "Cursor provides integrated terminal and Composer file-editing capabilities that bypass MCP proxies. ToolFence only mediates MCP tool calls configured in .cursor/mcp.json.",
  },
  "claude-code": {
    host: "claude-code",
    displayName: "Claude Code CLI",
    nativeBypassTools: [
      {
        name: "Bash",
        category: "shell",
        description: "Direct shell execution tool executing commands on the host system",
        risk: "high",
      },
      {
        name: "GlobTool / GrepTool / FileEditTool",
        category: "filesystem",
        description: "Built-in filesystem traversal, pattern search, and file modification",
        risk: "high",
      },
    ],
    bypassWarning:
      "Claude Code includes built-in tools (Bash, FileEditTool, GrepTool, GlobTool) that run directly on your machine outside MCP. ToolFence only mediates external MCP tool calls declared in .claude.json.",
  },
  "claude-desktop": {
    host: "claude-desktop",
    displayName: "Claude Desktop",
    nativeBypassTools: [
      {
        name: "Direct MCP Servers",
        category: "mcp-direct",
        description: "Any unmediated MCP servers listed in claude_desktop_config.json",
        risk: "medium",
      },
    ],
    bypassWarning:
      "Claude Desktop does not expose a native shell tool, but any MCP servers configured directly without ToolFence wrapping will run unmediated.",
  },
  claude: {
    host: "claude-desktop",
    displayName: "Claude Desktop",
    nativeBypassTools: [
      {
        name: "Direct MCP Servers",
        category: "mcp-direct",
        description: "Any unmediated MCP servers listed in claude_desktop_config.json",
        risk: "medium",
      },
    ],
    bypassWarning:
      "Claude Desktop does not expose a native shell tool, but any MCP servers configured directly without ToolFence wrapping will run unmediated.",
  },
};

export function getHostSecurityProfile(host: SupportedHost): HostSecurityProfile {
  const normalized = normalizeHost(host);
  return hostSecurityProfiles[normalized];
}

export function resolveHostConfigPath(
  host: SupportedHost,
  options: {
    workspace: string;
    home?: string;
    scope?: "project" | "global";
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  },
): string {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const scope = options.scope ?? (host === "claude-desktop" ? "global" : "project");

  switch (host) {
    case "cursor":
      return scope === "global"
        ? join(home, ".cursor", "mcp.json")
        : join(options.workspace, ".cursor", "mcp.json");

    case "claude":
    case "claude-desktop":
      if (platform === "darwin") {
        return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
      }
      if (platform === "win32") {
        const appData = env.APPDATA || join(home, "AppData", "Roaming");
        return join(appData, "Claude", "claude_desktop_config.json");
      }
      return join(env.XDG_CONFIG_HOME || join(home, ".config"), "Claude", "claude_desktop_config.json");

    case "claude-code":
      return scope === "global"
        ? join(home, ".claude.json")
        : join(options.workspace, ".claude.json");

    case "codex":
      return scope === "global"
        ? join(home, ".codex", "config.toml")
        : join(options.workspace, ".codex", "config.toml");
  }
}

export function generateHostSnippet(options: HostConfigOptions): HostSnippetResult {
  const host = normalizeHost(options.host);
  const workspace = canonicalizePath(options.workspace ?? process.cwd(), process.cwd());
  const home = options.home ?? homedir();
  const server = options.server ?? "filesystem";
  const policy = options.policy ? resolve(options.policy) : resolve(workspace, "toolfence.yaml");
  const upstreamCommand = options.upstreamCommand ?? "npx";
  const upstreamArgs = options.upstreamCommand
    ? (options.args ?? [])
    : ["-y", "@modelcontextprotocol/server-filesystem", workspace];

  const configPath = resolveHostConfigPath(host, {
    workspace,
    home,
    scope: options.scope,
    platform: options.platform,
    env: options.env,
  });

  const wrapArgs = [
    "wrap",
    "--policy",
    policy,
    "--server",
    server,
    "--workspace",
    workspace,
    "--",
    upstreamCommand,
    ...upstreamArgs,
  ];

  if (host === "codex") {
    const formattedArgs = wrapArgs.map((arg) => `  ${JSON.stringify(arg)},`).join("\n");
    const toml = [
      `[mcp_servers.${server}]`,
      `command = "toolfence"`,
      `args = [\n${formattedArgs}\n]`,
      `cwd = ${JSON.stringify(workspace)}`,
      `required = true`,
    ].join("\n");

    return {
      host,
      server,
      configPath,
      format: "toml",
      snippet: toml,
      rendered: toml,
      securityProfile: getHostSecurityProfile(host),
    };
  }

  const serverConfig = {
    command: "toolfence",
    args: wrapArgs,
  };

  const jsonSnippet = {
    mcpServers: {
      [server]: serverConfig,
    },
  };

  return {
    host,
    server,
    configPath,
    format: "json",
    snippet: jsonSnippet,
    rendered: JSON.stringify(jsonSnippet, null, 2),
    securityProfile: getHostSecurityProfile(host),
  };
}

export function injectHostConfig(options: HostConfigOptions): HostInjectResult {
  const snippetResult = generateHostSnippet(options);
  const { configPath, host, server } = snippetResult;

  mkdirSync(dirname(configPath), { recursive: true });

  const exists = existsSync(configPath);
  let backupPath: string | undefined;

  if (exists) {
    backupPath = `${configPath}.bak`;
    try {
      writeFileSync(backupPath, readFileSync(configPath));
    } catch {
      // Ignore backup failure if file cannot be copied
      backupPath = undefined;
    }
  }

  let finalContent: string;

  if (snippetResult.format === "toml") {
    const snippetToml = snippetResult.rendered;
    if (exists) {
      const existing = readFileSync(configPath, "utf8");
      const sectionHeader = `[mcp_servers.${server}]`;
      if (existing.includes(sectionHeader)) {
        // Replace existing section if present, or append
        const regex = new RegExp(`\\[mcp_servers\\.${server}\\][\\s\\S]*?(?=\\n\\[|$)`);
        finalContent = existing.replace(regex, snippetToml.trim());
      } else {
        finalContent = `${existing.trimEnd()}\n\n${snippetToml}\n`;
      }
    } else {
      finalContent = `${snippetToml}\n`;
    }
  } else {
    let existingJson: Record<string, unknown> = {};
    if (exists) {
      try {
        const raw = readFileSync(configPath, "utf8").trim();
        if (raw.length > 0) {
          existingJson = JSON.parse(raw) as Record<string, unknown>;
        }
      } catch {
        // If malformed, preserve existing backup and start with clean object
        existingJson = {};
      }
    }

    const mcpServers = (
      existingJson.mcpServers && typeof existingJson.mcpServers === "object" && !Array.isArray(existingJson.mcpServers)
        ? { ...(existingJson.mcpServers as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;

    const snippetObj = snippetResult.snippet as { mcpServers: Record<string, unknown> };
    mcpServers[server] = snippetObj.mcpServers[server];

    const merged = {
      ...existingJson,
      mcpServers,
    };

    finalContent = `${JSON.stringify(merged, null, 2)}\n`;
  }

  writeFileSync(configPath, finalContent, { encoding: "utf8" });

  return {
    host,
    server,
    configPath,
    created: !exists,
    updated: exists,
    backupPath,
    content: finalContent,
    securityProfile: snippetResult.securityProfile,
  };
}
