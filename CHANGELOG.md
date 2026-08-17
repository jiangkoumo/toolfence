# Changelog

All notable changes to ToolFence are documented here. The project follows Semantic Versioning.

## [0.2.0] - 2026-08-17

First stable open-source release.

### Added

- A stdio MCP policy proxy with deterministic allow, deny, and approval decisions.
- Conservative Filesystem, Shell, Git, and HTTP action adapters.
- A local authenticated approval Broker with one-time and session decisions.
- Policy validation, explanation, declarative testing, and safe starter-policy generation.
- Privacy-conscious JSONL auditing that omits raw arguments and results.
- Real MCP integration tests and a macOS/Linux CI matrix for Node.js 20, 22, and 24.

### Security

- Deny rules override allows, multi-resource requests are evaluated as a unit, and unknown actions fail closed.
- Filesystem resources are canonicalized through existing symbolic links.
- Broker authentication, request expiry, cancellation, and disconnect paths fail closed.

### Known limitations

- ToolFence is a policy proxy, not a process sandbox for an untrusted MCP server.
- Transport is stdio-only, interactive Broker support is POSIX-only, and JSON-RPC batches are rejected.
- Upstream results are forwarded without secret redaction.
