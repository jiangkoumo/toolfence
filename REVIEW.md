# ToolFence v0.2.0 Review Record

## Review gates

- Protocol: request IDs remain correlated; notifications are not answered; cancellation cannot race into forwarding; upstream exit resolves outstanding calls.
- Authorization: deny precedence is unchanged; unknown or ambiguous actions do not receive a lower-risk classification; session grants are Schema-bound.
- Local IPC: authentication is mandatory; protocol version is checked; pending requests are owner-scoped; disconnect removes pending approvals; raw arguments are excluded.
- Filesystem safety: symlink-aware canonicalization precedes policy matching; mixed resources use all/any semantics appropriate to allow/deny.
- Data minimization: Broker and audit payloads contain normalized metadata only; upstream result bodies are represented by SHA-256.
- Failure behavior: policy, YAML, Schema, audit, Broker, Socket, and upstream startup errors are summarized without default stacks and fail closed.
- Packaging: executable CLI, example policy, README, development manual, test plan, and review record are included.

## Acceptance evidence

Verified on 2026-08-17:

- `npm run verify`: passed (typecheck, 50 tests, build, and package dry run).
- Real integrations: official Filesystem MCP Server plus Shell, HTTP, and Git fixtures passed.
- macOS runtime matrix: Node.js 20.20.2, 22.22.2, and 24.19.0 all passed typecheck, tests, and build during Alpha review; the final 50-test suite passed on the active runtime.
- Package inspection: 37 intended files, executable CLI and public TypeScript declarations included.
- CLI smoke tests: version succeeded; a missing policy returned one actionable line with no stack.
- `npm audit --omit=dev`: zero production vulnerabilities.
- CI workflow: macOS/Linux × Node.js 20/22/24 is configured; Linux cells run when the repository is pushed to CI.

Review findings fixed before sign-off:

- Unified long Unix Socket path derivation between Broker and clients.
- Prevented a second Broker from replacing a live Socket.
- Corrected mutating `git branch` classification and read-only `git remote -v`.
- Converted approval transport exceptions into explicit fail-closed responses.
- Added strict Broker request validation and Broker-side expiry.
- Added safe starter-policy generation that cannot overwrite an existing file.
- Made package metadata the CLI version source of truth and exposed the documented library entry point.

Status: passed local implementation, security, test, audit, and package review. Remote CI and npm trusted-publisher configuration remain the pre-publication gates.
