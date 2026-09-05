# ToolFence Code & Security Review Record

## Review gates

- Protocol: request IDs remain correlated; notifications are not answered; cancellation cannot race into forwarding; upstream exit resolves outstanding calls.
- Authorization: deny precedence is unchanged; unknown or ambiguous actions do not receive a lower-risk classification; session grants are Schema-bound.
- Local IPC: authentication is mandatory; protocol version is checked; pending requests are owner-scoped; disconnect removes pending approvals; raw arguments are excluded.
- Filesystem safety: symlink-aware canonicalization precedes policy matching; mixed resources use all/any semantics appropriate to allow/deny.
- Data minimization & zero leak: Broker and audit payloads contain normalized metadata only; upstream result bodies are represented by SHA-256; output redaction scrubs credentials before forwarding.
- Output Secret Redaction (DLP): tool outputs and JSON-RPC errors are scanned for credentials and masked with `[REDACTED_SECRET]`; redaction failure fails closed and terminates upstream.
- Policy Recipes: curated starter policies (`filesystem`, `github`, `fetch`, `sqlite`, `postgres`, `git`) strictly validate against the policy schema; `fetch` recipe blocks literal IPv4 and IPv6 private/local destinations.
- Operational CLI: JSON approval snapshots contain only the Broker's privacy-safe request shape; targeted decisions require an exact pending approval ID and an explicit bounded decision value; `policy init` supports `--recipe` and `--list-recipes`.
- Audit inspection: summaries and tails are read-only, malformed JSONL fails with a line number, result events track `redacted` count, and no raw data is logged.
- Diagnostics: Doctor checks do not expose Policy contents or upstream output; an explicit startup probe uses argv without a shell and terminates the probed process group.
- Host automation: host configuration snippets and file injections preserve existing servers, support dry-run previews, and back up modified configuration files.
- Failure behavior: policy, YAML, Schema, audit, Broker, Socket, redaction, and upstream startup errors are summarized without default stacks and fail closed.
- Packaging: executable CLI, public audit and recipe helpers, example policies, README, development manual, test plan, and review record are included.

## Acceptance evidence

Verified locally on 2026-08-24:

- `npm run verify`: passed (typecheck, 96 tests across 14 test suites, enforced coverage, end-to-end demo, build, clean-install package smoke, and package dry run).
- V8 coverage passed at 84.58% statements/lines, 78.21% branches, and 92.30% functions. `recipes.ts` and `redact.ts` passed at 100% coverage.
- Real integrations: official Filesystem MCP Server plus Shell, HTTP, and Git fixtures passed.
- Output secret redaction: validated on OpenAI keys, Anthropic keys, GitHub tokens, AWS keys, PEM private keys, JWTs, Slack tokens, and generic config assignments in results and errors.
- Policy recipes: verified all 6 built-in recipes against policy schema and confirmed exact match with `examples/recipes/*.yaml`.
- The active macOS runtime passed the 96-test suite, typecheck, build, end-to-end demo, and clean-install package smoke; CI retains macOS/Linux coverage for Node.js 20, 22, and 24.
- Package inspection: 60 intended files, including executable CLI, public TypeScript declarations, recipe examples, host guides, visual assets, and dual-use disclosure.
- CLI tests: audit summary/tail JSON output, non-interactive Broker approvals, recipe listing and initialization, host init/snippet commands, and Doctor checks passed.
- `npm audit` and `npm audit --omit=dev`: zero vulnerabilities.
- CI workflow: macOS/Linux × Node.js 20/22/24 is configured; Linux cells run when the repository is pushed to CI.

Review findings fixed before sign-off:

- Unified long Unix Socket path derivation between Broker and clients.
- Prevented a second Broker from replacing a live Socket.
- Corrected mutating `git branch` classification and read-only `git remote -v`.
- Converted approval transport exceptions into explicit fail-closed responses.
- Added strict Broker request validation and Broker-side expiry.
- Added safe starter-policy generation that cannot overwrite an existing file.
- Made package metadata the CLI version source of truth and exposed the documented library entry point.
- Fixed installed npm binaries silently exiting when invoked through the package-manager symlink, and added a clean-install tarball smoke gate.
- Added npm dual-use metadata and a permanent disclosure describing process launching, mediated capabilities, intended use, and security boundaries.
- Added machine-readable approval listing without expanding the Broker payload or exposing raw arguments.
- Required exact approval IDs for non-interactive decisions and verified the path against a live authenticated Broker.
- Added strict audit record parsing, deterministic summaries, bounded tailing, and public audit helper types.
- Added coverage thresholds to the standard verification gate.
- Added fixed-seed fuzz/property tests covering arbitrary JSON-shaped Normalizer inputs and randomized deny-rule ordering.
- Upgraded Vitest and its coverage provider to 3.2.6, removing the vulnerable pre-3.2.6 development dependency.
- Added reproducible documentation, host setup guides, issue/discussion templates, and an installed-package demo gate.
- Added text and JSON Doctor reports with explicit upstream startup probing and POSIX process-group cleanup.
- Implemented output secret redaction (DLP) covering tool results and errors with fail-closed termination on redaction failure.
- Implemented built-in Policy Recipes (`filesystem`, `github`, `fetch`, `sqlite`, `postgres`, `git`) with CLI `--recipe` and `--list-recipes` support and private IPv4/IPv6 address blocks for Fetch.
- Implemented platform-neutral Broker IPC abstraction supporting Windows user-scoped Named Pipes (`\\\\.\\pipe\\toolfence-<hash>`) with private credential storage enforcement without emulating misleading POSIX modes.
- Versioned Normalized Action Model (`ACTION_MODEL_VERSION = "1.0"`) with conservative downgrade rules in PolicyEngine ensuring unsupported versions never inherit default allow.
- Established versioned Audit Evidence Schema (`auditSchemaVersion: 1`) correlating Host, protocol revision, tool schema fingerprint, action-model version, policy hash, and non-forwarding evidence without logging raw arguments or raw results.
- Added Host native tool bypass disclosure (`HostSecurityProfile`) for Codex, Cursor, Claude Code, and Claude Desktop, explicitly detailing unmediated built-in tools (such as native shell `exec`/`Bash` and direct workspace editing) in CLI and JSON formats.

Status: passed local implementation, security, coverage, dependency audit, package, and patch review. The clean-tree release check, final CI matrix, and trusted-publisher workflow remain publication gates.
