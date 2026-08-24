# ToolFence roadmap

ToolFence is an early-stage security project. This roadmap communicates priorities, not release promises. Security invariants and fail-closed behavior take precedence over dates.

## Now: adoption-ready v0.2.x & v0.3.0 baseline

- Built-in curated policy recipes (`filesystem`, `github`, `fetch`, `sqlite`, `postgres`, `git`) via `toolfence policy init --recipe <name>`.
- Automatic output secret redaction (DLP) for tool execution results without storing raw secret payloads in audit logs.
- Keep Codex, Cursor, and Claude Desktop setup guides tested and current.
- Maintain reproducible policy demos and concise security-boundary documentation.
- Improve issue triage, contribution guidance, and release notes.
- Keep the `toolfence doctor` installation, Policy, Broker, Socket, and upstream startup checks current.

## Next: safer and easier operation

- Track MCP protocol compatibility explicitly and expand integration fixtures as the protocol evolves.
- Improve interactive approval portability, including a Windows-compatible transport.

## Later: stronger isolation and broader transport support

- Evaluate process isolation, environment filtering, and network controls as a separate sandbox layer.
- Evaluate Streamable HTTP support without weakening redirect and destination checks.
- Consider signed or tamper-evident audit export after the local audit format stabilizes.
- Consider Desktop Extension packaging when the ToolFence security model maps cleanly to the host format.

## Good first contribution candidates

- Add a tested policy recipe for another common local MCP server.
- Improve an error message while preserving stdout for JSON-RPC.
- Add a malformed-input or lifecycle regression test described in [`TESTING.md`](TESTING.md).
- Verify one host setup guide on a new OS and document any path differences.

Open a feature request before implementing a change that affects the trust boundary or policy semantics. Suspected vulnerabilities must follow [`SECURITY.md`](SECURITY.md), not a public issue.
