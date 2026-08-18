# ToolFence

[![CI](https://github.com/jiangkoumo/toolfence/actions/workflows/ci.yml/badge.svg)](https://github.com/jiangkoumo/toolfence/actions/workflows/ci.yml)

**A local, fail-closed firewall for MCP tool calls.**

ToolFence puts least-privilege policies and human approval between AI agents and stdio MCP servers. It allows safe operations, blocks dangerous ones, and asks before forwarding calls that need a human decision—without requiring code changes to the MCP client or server.

```text
ALLOW  Read ./src/index.ts
DENY   Read ~/.ssh/id_rsa
ASK    Run npm install
DENY   Run sudo rm -rf ...
```

## Why ToolFence

- **Semantic policies:** normalize common Filesystem, Shell, Git, and HTTP tool calls into operations such as `fs.read`, `shell.exec`, `git.write`, and `net.request`, then match paths, exact command arguments, hosts, and HTTP methods.
- **Deterministic enforcement:** `deny` overrides other matches, multi-resource requests are evaluated as a unit, and unknown or ambiguous actions fail closed.
- **Human approval:** use an authenticated local Broker for one-time or session decisions; session approvals are bound to the tool Schema and are invalidated when that Schema changes.
- **Privacy-conscious auditing:** record tool identity, affected resources, policy decisions, and result hashes without storing raw arguments or results.
- **Policies you can test:** generate, validate, explain, and regression-test YAML policies from the CLI.

## Status

Version 0.2.0 is the first stable open-source release. It includes cancellable approvals through a local Broker, conservative Filesystem/Shell/Git/HTTP adapters, policy creation and development commands, Schema-bound session approvals, and real MCP integration tests.

ToolFence is **not a sandbox for a malicious MCP server process**: the upstream process still runs with the current user's operating-system permissions.

Because ToolFence launches user-configured processes and mediates Shell, Git, and HTTP capabilities, the npm package is transparently declared as dual-use. See [DISCLOSURE](DISCLOSURE) for the intended legitimate use and security boundary.

## Install

The npm package name is `toolfence-mcp`; the command is `toolfence`.

```bash
npm install -g toolfence-mcp
```

For local development:

```bash
npm install
npm run build
npm link
```

## Quick start

Create a conservative starter policy, review it, then wrap any stdio MCP server:

```bash
toolfence policy init
toolfence policy check --policy ./toolfence.yaml
```

The generated file never replaces an existing policy. For a broader annotated example, see [`examples/policy.yaml`](examples/policy.yaml).

```bash
toolfence wrap \
  --policy ./toolfence.yaml \
  --server filesystem \
  --workspace "$PWD" \
  -- npx -y @modelcontextprotocol/server-filesystem "$PWD"
```

An MCP client configuration looks like this:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "toolfence",
      "args": [
        "wrap",
        "--policy", "/absolute/path/policy.yaml",
        "--server", "filesystem",
        "--workspace", "/absolute/path/project",
        "--",
        "npx", "-y", "@modelcontextprotocol/server-filesystem", "/absolute/path/project"
      ]
    }
  }
}
```

ToolFence reserves stdout for MCP JSON-RPC messages. Diagnostics and upstream stderr stay on stderr. Start the per-user Broker and approval terminal in separate terminals:

```bash
toolfence broker
toolfence approvals
```

`wrap` uses the Broker by default. If it is missing, incompatible, unauthenticated, disconnected, or times out, an `ask` decision fails closed. Use `--approval tty` only when direct `/dev/tty` approval is desired. `toolfence status` verifies Broker connectivity, protocol version, and Socket permissions.

## Policy

```yaml
version: 1
default: ask

rules:
  - id: deny-dotenv
    effect: deny
    operations: [fs.read, fs.write]
    resources: ["**/.env", "**/.env.*"]

  - id: allow-workspace-read
    effect: allow
    operations: [fs.read]
    resources: ["${workspace}/**"]

  - id: allow-tests
    effect: allow
    operations: [shell.exec]
    commands:
      - [npm, test]

  - id: allow-git-inspection
    effect: allow
    operations: [git.read]

  - id: allow-read-api
    effect: allow
    operations: [net.request]
    hosts: ["api.example.com", "*.internal.example.com"]
    methods: [GET, HEAD]
```

Rules are evaluated deterministically:

1. Every matching `deny` rule overrides all other matches. A deny resource rule matches when any requested resource is protected.
2. Otherwise, the first matching rule wins.
3. If nothing matches, `default` is used.

Allow and ask resource rules require every requested resource to match, so a multi-file call cannot use one allowed path to carry an unauthorized path.

Filesystem paths are canonicalized before matching, including existing symbolic links. Exact argv matching is used for allowed commands; compound or quoted shell strings are not treated as safe argv and fall back to the default decision.

Supported v0.2 operations are `fs.read`, `fs.write`, `fs.delete`, `shell.exec`, `git.read`, `git.write`, `git.remote`, `net.request`, and `unknown`. Ambiguous Git commands, invalid URLs, and unrecognized tools fail closed through `shell.exec` or `unknown`.

## Policy development

```bash
toolfence policy init [--policy ./toolfence.yaml]
toolfence policy check --policy ./examples/policy.yaml
toolfence policy explain --policy ./examples/policy.yaml --action ./action.json
toolfence policy test --policy ./examples/policy.yaml --cases ./policy-cases.yaml
```

`init` creates a conservative policy without overwriting an existing file. `check` validates YAML, strict Schema rules, variables, duplicate IDs, and invalid network-field combinations. `explain` prints matched rules and the final decision. `test` runs declarative cases and exits non-zero on any mismatch.

## Audit log

The default audit file is `.toolfence/audit.jsonl` under the workspace. It records operation names, affected paths, tool identity, final policy decisions, and SHA-256 hashes of upstream results. Raw tool arguments, command arguments, and raw results are intentionally omitted to reduce secret leakage.

Use `--audit /path/to/audit.jsonl` to select a different path.

## Security boundary

ToolFence v0.2 reduces accidental or prompt-injected tool misuse when the tool call crosses this proxy. It does not prevent the upstream server process from directly reading files, environment variables, or the network. Process isolation, environment filtering, and network controls belong to a later sandbox phase.

Additional current limitations:

- stdio transport only
- local Broker support is POSIX-only; Windows remains non-interactive and fail-closed
- JSON-RPC batch messages are rejected
- no output secret redaction yet; raw results are forwarded unchanged
- an HTTP MCP adapter must expose a redirect destination (for example as `redirectUrl`) for ToolFence to re-evaluate it

## Development

The architecture, threat model, security invariants, and v0.2 implementation plan are maintained in the [development guide](DEVELOPMENT.md).

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
npm audit --omit=dev
```

The full validation strategy is in [TESTING.md](TESTING.md), and the release/security review record is in [REVIEW.md](REVIEW.md). See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CHANGELOG.md](CHANGELOG.md), and [RELEASING.md](RELEASING.md) before contributing, reporting a vulnerability, or publishing a release.

## License

MIT
