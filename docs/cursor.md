# Use ToolFence with Cursor

This guide adds a ToolFence-wrapped Filesystem MCP server to one Cursor project.

## 1. Install and create a policy

```bash
npm install -g toolfence-mcp
cd /absolute/path/project
toolfence policy init
toolfence policy check --policy ./toolfence.yaml
```

## 2. Configure the project

Create or update `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "toolfence",
      "args": [
        "wrap",
        "--policy", "/absolute/path/project/toolfence.yaml",
        "--server", "filesystem",
        "--workspace", "/absolute/path/project",
        "--",
        "npx", "-y", "@modelcontextprotocol/server-filesystem", "/absolute/path/project"
      ]
    }
  }
}
```

See Cursor's [MCP documentation](https://docs.cursor.com/context/model-context-protocol) for the current host configuration interface.

Use absolute paths. GUI applications may have a smaller `PATH` than your shell; if necessary, replace `toolfence` and `npx` with the absolute paths printed by `which toolfence` and `which npx`.

## 3. Run approvals

Start the Broker and approval terminal before asking Cursor to call a tool that resolves to `ask`:

```bash
toolfence broker
```

```bash
toolfence approvals
```

Reload Cursor after changing `.cursor/mcp.json`. Run `toolfence doctor --policy /absolute/path/to/toolfence.yaml -- <the configured upstream command>` if the wrapped server fails to connect.

## Troubleshooting

- A missing Broker does not silently allow a request; `ask` fails closed.
- Check that the policy and workspace paths are absolute and exist.
- ToolFence currently supports stdio MCP servers, not remote HTTP servers configured directly in Cursor.
