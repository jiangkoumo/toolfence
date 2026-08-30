# Changelog

All notable changes to ToolFence are documented here. The project follows Semantic Versioning.

## [Unreleased]

## [0.3.3] - 2026-08-30

### Security

- Prevented a cancellation during Broker connection from creating a ghost approval that could later grant `allow-session` access.
- Recorded approval IDs and actual resolutions, proxy/client correlation, explicit `not-forwarded` evidence for deny and timeout paths, and MCP `isError` results without storing raw arguments or results.

### Changed

- Normalized the four AgentTape tools conservatively: list, inspect, and fork are scoped reads; regression saving is a scoped write; unknown aliases and tools remain unknown.
- Added direct zero-forward, pending-cleanup, result-error, audit-correlation, and approval-resolution regression coverage from five real AgentTape × ToolFence development scenarios.
- Added an installable npm package asset to each GitHub Release and enforced main ancestry plus production dependency audit in the tag workflow.

## [0.3.2] - 2026-08-28

### Security

- Prevented uncertain or malformed tool actions from inheriting `default: allow` unless an explicit rule matches; they now require approval.
- Replaced in-flight request tracking eviction with fail-closed capacity errors and rejected duplicate IDs before they can overwrite result-redaction and audit correlation state.

## [0.3.1] - 2026-08-24

Release reliability follow-up for v0.3.0.

### Fixed

- Increased the deterministic fuzz invariant timeout for slower macOS/Node.js CI runners.
- Made trusted publishing idempotent when npm reports an already staged version before it becomes visible through registry metadata.
- Restored immutable release sequencing by publishing follow-up changes under a new patch version instead of reusing `v0.3.0`.

## [0.3.0] - 2026-08-24

Policy recipes library, output secret redaction (DLP), and SSRF protection update.

### Added

- Built-in policy recipes for Filesystem, GitHub, Fetch, SQLite, PostgreSQL, and Git servers with CLI `--recipe` and `--list-recipes` support.
- Default-on output secret redaction for successful tool results, structured sensitive fields, and JSON-RPC errors, with audit redaction markers.

### Security

- Expanded the Fetch recipe's literal private-address protections to cover IPv4 private ranges and IPv6 loopback, unique-local, and link-local destinations.

## [0.2.4] - 2026-08-23

Cross-host initialization, path resolution hardening, and proxy memory safety update.

### Added

- `toolfence host init` and `toolfence init --host` commands for automated configuration generation and injection for Cursor, Claude Desktop, Claude Code, and Codex.
- Safe direct injection (`--write`), preview (`--dry-run` default), and machine-readable JSON output (`--json`) with automatic config backup creation (`.bak`).
- Comprehensive test suites covering host path mappings, snippet formatting, and multi-platform path resolutions.

### Changed

- Hardened path canonicalization (`canonicalizePath`) with standard `basename` resolution for non-existent paths across symbolic links and platforms.
- Bounded in-flight proxy request tracking to protect against unbounded memory growth from non-responsive upstream servers.
- Added unit tests for headless and aborted TTY approval flows, bringing overall line coverage to over 83%.

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
