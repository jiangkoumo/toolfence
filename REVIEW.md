# ToolFence v0.2.1 Review Record

## Review gates

- Protocol: request IDs remain correlated; notifications are not answered; cancellation cannot race into forwarding; upstream exit resolves outstanding calls.
- Authorization: deny precedence is unchanged; unknown or ambiguous actions do not receive a lower-risk classification; session grants are Schema-bound.
- Local IPC: authentication is mandatory; protocol version is checked; pending requests are owner-scoped; disconnect removes pending approvals; raw arguments are excluded.
- Filesystem safety: symlink-aware canonicalization precedes policy matching; mixed resources use all/any semantics appropriate to allow/deny.
- Data minimization: Broker and audit payloads contain normalized metadata only; upstream result bodies are represented by SHA-256.
- Operational CLI: JSON approval snapshots contain only the Broker's privacy-safe request shape; targeted decisions require an exact pending approval ID and an explicit bounded decision value.
- Audit inspection: summaries and tails are read-only, malformed JSONL fails with a line number, and no new audit data is created.
- Failure behavior: policy, YAML, Schema, audit, Broker, Socket, and upstream startup errors are summarized without default stacks and fail closed.
- Packaging: executable CLI, public audit helpers, example policy, README, development manual, test plan, and review record are included.

## Acceptance evidence

Verified on 2026-08-19:

- `npm run verify`: passed (typecheck, 60 tests, enforced coverage, build, clean-install package smoke, and package dry run).
- V8 coverage passed at 78.87% statements/lines, 76.23% branches, and 88.65% functions.
- Real integrations: official Filesystem MCP Server plus Shell, HTTP, and Git fixtures passed.
- The active macOS runtime passed the 60-test suite, typecheck, build, and clean-install package smoke; CI retains macOS/Linux coverage for Node.js 20, 22, and 24.
- Package inspection: 38 intended files, including executable CLI, public TypeScript declarations, and dual-use disclosure.
- CLI tests: audit summary/tail JSON output and a real non-interactive Broker approval both passed; version and installed binary smoke tests succeeded.
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

Status: passed local implementation, security, coverage, dependency audit, package, and release-preflight review. The release preflight reports only the expected dirty-worktree condition until these v0.2.1 changes are committed; the final CI matrix and trusted-publisher workflow remain publication gates.
