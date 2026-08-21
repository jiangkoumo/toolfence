# Use ToolFence with Codex

This guide wraps a local Filesystem MCP server with ToolFence. Codex launches ToolFence over stdio; ToolFence then launches the upstream server.

## 1. Install and create a policy

```bash
npm install -g toolfence-mcp
cd /absolute/path/project
toolfence policy init
toolfence policy check --policy ./toolfence.yaml
```

Review the generated policy before connecting it to a host. It is conservative and will not overwrite an existing file.

## 2. Configure Codex

Add the following to `~/.codex/config.toml`, or to `.codex/config.toml` in a trusted project:

```toml
[mcp_servers.filesystem]
command = "toolfence"
args = [
  "wrap",
  "--policy", "/absolute/path/project/toolfence.yaml",
  "--server", "filesystem",
  "--workspace", "/absolute/path/project",
  "--",
  "npx", "-y", "@modelcontextprotocol/server-filesystem", "/absolute/path/project",
]
cwd = "/absolute/path/project"
required = true
```

Codex supports `command`, `args`, and `cwd` for stdio MCP servers. Project-scoped configuration is loaded only after the project is trusted. See the [Codex configuration reference](https://developers.openai.com/codex/config-file/config-reference).

Use absolute paths. If Codex cannot find `toolfence`, replace the command with the absolute path printed by `which toolfence`.

## 3. Run approvals

ToolFence uses its local Broker for `ask` decisions:

```bash
toolfence broker
```

In a second terminal:

```bash
toolfence approvals
```

Restart Codex after changing MCP configuration. Run `toolfence doctor --policy /absolute/path/to/toolfence.yaml -- <the configured upstream command>` to validate the Policy, Broker permissions, and upstream startup before reconnecting.

## Troubleshooting

- An unavailable or disconnected Broker causes `ask` decisions to fail closed.
- ToolFence writes diagnostics to stderr and reserves stdout for MCP JSON-RPC.
- ToolFence policies supplement the host's own approvals; keep both layers enabled when you want defense in depth.
- ToolFence currently wraps local stdio servers. It does not wrap Codex HTTP MCP connections.
