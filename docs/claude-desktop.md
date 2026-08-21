# Use ToolFence with Claude Desktop

ToolFence can wrap a local stdio MCP server configured for Claude Desktop development. Anthropic now recommends Desktop Extensions for broad end-user distribution; this manual configuration remains useful while developing or evaluating a local wrapper.

## 1. Install and create a policy

```bash
npm install -g toolfence-mcp
cd /absolute/path/project
toolfence policy init
toolfence policy check --policy ./toolfence.yaml
```

## 2. Configure the local server

Open Claude Desktop's developer settings and edit its local MCP configuration. Add:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "/absolute/path/to/toolfence",
      "args": [
        "wrap",
        "--policy", "/absolute/path/project/toolfence.yaml",
        "--server", "filesystem",
        "--workspace", "/absolute/path/project",
        "--",
        "/absolute/path/to/npx", "-y", "@modelcontextprotocol/server-filesystem", "/absolute/path/project"
      ]
    }
  }
}
```

Find the launcher paths with `which toolfence` and `which npx`. Absolute executable paths avoid the reduced `PATH` commonly seen by GUI applications.

Anthropic documents local servers and its current Desktop Extension workflow in [Getting Started with Local MCP Servers](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop).

## 3. Run approvals

On macOS or Linux, start the Broker and approval terminal:

```bash
toolfence broker
```

```bash
toolfence approvals
```

Restart Claude Desktop after changing the configuration. The connected server should appear in Developer settings or under Connectors.

If it does not appear, run `toolfence doctor --policy /absolute/path/to/toolfence.yaml -- <the configured upstream command>` in a terminal to validate the local setup.

## Platform note

ToolFence enforcement works fail-closed on every supported Node.js platform, but the interactive local Broker is currently POSIX-only. Windows users should use policies that resolve calls directly to `allow` or `deny`; unresolved `ask` decisions are denied.

ToolFence is not yet packaged as an `.mcpb` Desktop Extension.
