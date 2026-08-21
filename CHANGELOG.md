# Changelog

All notable changes to ToolFence are documented here. The project follows Semantic Versioning.

## [0.2.3] - 2026-08-21

Adoption and diagnostics update on the stable v0.2 security baseline.

### Added

- A reproducible end-to-end Broker/proxy/official Filesystem MCP demo and generated terminal animation.
- Copy-ready Codex, Cursor, and Claude Desktop setup guides.
- A public roadmap, issue forms, discussion forms, and pull request template.
- A compact architecture diagram and product-layer comparison.
- A `toolfence doctor` command with text and JSON reports for Node.js, Policy, Broker permissions, and explicit upstream startup probes.

### Changed

- Reworked the README around a three-minute first run and the current v0.2.3 release.
- Extended package smoke and release checks to cover the distributed guides, visual assets, and installed diagnostic command.

## [0.2.2] - 2026-08-19

Recovery release for the 0.2.1 artifact after npm trusted publishing setup was completed.

### Changed

- Republished the 0.2.1 feature set as 0.2.2 after binding GitHub Actions to npm trusted publishing.
- Retained the failed `v0.2.1` tag instead of moving or reusing it.

## [0.2.1] - 2026-08-19

Usability and release-quality update on the v0.2 security baseline.

### Added

- Machine-readable approval queue output through `toolfence approvals --json`.
- Non-interactive, approval-ID-scoped Broker decisions with explicit `allow-once`, `allow-session`, or `deny` values.
- Audit `summary` and `tail` commands with text and JSON output.
- Copy-ready local MCP configuration examples for Codex, Cursor, and Claude Desktop.
- Enforced V8 coverage thresholds in the standard verification gate.
- Fixed-seed fuzz/property tests for Normalizer totality and deny-rule precedence.

### Changed

- The public ESM API now exports audit reading, tailing, and summary helpers and their record types.
- Vitest and its coverage provider were upgraded to 3.2.6.

### Security

- Scriptable approval output continues to exclude raw tool arguments and results.
- Audit inspection rejects malformed records with a precise line number instead of silently skipping them.
- The test-runner upgrade removes the development dependency vulnerability affecting Vitest versions before 3.2.6.

## [0.2.0] - 2026-08-17

First stable open-source release.

### Added

- A stdio MCP policy proxy with deterministic allow, deny, and approval decisions.
- Conservative Filesystem, Shell, Git, and HTTP action adapters.
- A local authenticated approval Broker with one-time and session decisions.
- Policy validation, explanation, declarative testing, and safe starter-policy generation.
- Clean-install package verification covering the npm binary symlink and public ESM API.
- A release preflight that validates version, changelog, repository, package exports, Git state, tag alignment, and dual-use disclosure requirements.
- Privacy-conscious JSONL auditing that omits raw arguments and results.
- Real MCP integration tests and a macOS/Linux CI matrix for Node.js 20, 22, and 24.

### Security

- Deny rules override allows, multi-resource requests are evaluated as a unit, and unknown actions fail closed.
- Filesystem resources are canonicalized through existing symbolic links.
- Broker authentication, request expiry, cancellation, and disconnect paths fail closed.
- The npm package declares its process-launching and Shell/Git/HTTP mediation capabilities as dual-use and includes the required disclosure.

### Known limitations

- ToolFence is a policy proxy, not a process sandbox for an untrusted MCP server.
- Transport is stdio-only, interactive Broker support is POSIX-only, and JSON-RPC batches are rejected.
- Upstream results are forwarded without secret redaction.
