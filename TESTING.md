# ToolFence Test Strategy

The release gate is risk-based: a passing happy path is insufficient unless denial, cancellation, timeout, disconnect, and malformed-input paths are also exercised.

`npm run verify` enforces V8 coverage thresholds, packs the built package, installs it into a clean temporary project, exercises the installed npm binary through its real symlink, validates a generated policy, and imports the public ESM API.

`npm run conformance` is the protocol conformance gate: it validates `conformance/matrix.json`, runs the shared corpus against every `supported` matrix row, writes the dated `conformance/report.json`, and fails when any supported row is missing, failing, or stale relative to the package version.

`npm run release:check` is a separate publication gate. It enforces version, changelog, repository, package entry-point, conformance evidence (matrix plus a passing dated report for every supported row), Git cleanliness, tag, and dual-use disclosure consistency.

## Layers

1. Unit tests cover normalization, canonical paths, strict policy validation, deterministic rule priority, HTTP host/method matching, canonical Schema fingerprints, and fixed-seed fuzz/property invariants.
2. Component tests cover audit permissions and inspection, CLI argument boundaries and output, diagnostic Policy/Broker/upstream checks, declarative policy commands, Broker authentication/protocol/queue behavior, targeted non-interactive approvals, session grants, and invalidation.
3. Proxy lifecycle tests cover approval, rejection, cancellation, timeout, upstream exit, result correlation, and Schema propagation.
4. Real integration tests cover the official Filesystem MCP Server plus repeatable Shell, HTTP, and Git MCP fixtures.
5. Conformance tests run the shared corpus (`conformance/corpus.mjs`) against every supported row of `conformance/matrix.json` for every declared protocol revision: legacy `initialize` lifecycle (`2024-11-05`, `2025-06-18`) and MCP `2026-07-28` stateless lifecycle. They assert identical decisions across revisions, transparent pass-through of `server/discover`, per-request `_meta`, list cache metadata, and MRTR, protocol-revision metadata neutrality, and that a Schema change still invalidates approvals in every lifecycle style.
6. Coverage, packaging, and dependency gates cover enforced line/branch/function thresholds, typecheck, build, executable CLI mode, package contents, conformance evidence, and production dependency audit.

Compatibility claims use the `supported`/`experimental`/`unverified`/`unsupported` vocabulary. Every `supported` row passes the same corpus with a dated report entry; Doctor reports the same vocabulary, and unverified or unsupported combinations never expand permissions.

## Security cases

- A deny rule wins over an allow rule.
- A mixed multi-resource read cannot carry a protected file.
- Unmatched unknown, ambiguous, or malformed actions require approval even under `default: allow`; explicit matching rules retain their documented effect and deny still takes precedence.
- Existing and missing paths are canonicalized through existing symlink ancestors.
- Compound Shell input never matches exact argv authorization.
- Ambiguous Git input does not become `git.read`.
- HTTP authorization uses hostname without user info, port, or path; method is uppercase.
- Invalid URLs and explicit redirect destinations are re-evaluated or denied.
- Cancellation while awaiting approval never reaches upstream.
- Approval timeout, unavailable Broker, authentication failure, and disconnect fail closed.
- Session approval keys contain Server, Tool, operation, and Schema fingerprint.
- Broker and audit records omit raw arguments and raw results.
- Tracked successful results, structured sensitive fields, and tracked JSON-RPC errors are redacted before forwarding and audit hashing.
- Request-tracking capacity tests fill every slot, reject overflow before upstream execution, and prove the oldest tracked result is still redacted and audited. This `v0.3.2` repair closes the gap present in `v0.3.1`; output redaction still must not be treated as the only secret-control boundary.
- Built-in Fetch policy recipes deny common literal IPv4 and IPv6 local destinations before public read rules are considered.
- Runtime directory, Socket, Token, and audit modes are checked on POSIX.
- Doctor reports an unavailable optional Broker without weakening fail-closed proxy behavior and rejects insecure Broker permissions or a failed upstream startup probe.
- An unverified protocol revision in per-request `_meta` produces the same decision and forwarding as the verified revision (protocol metadata neutrality), and the payload still reaches the upstream verbatim.
- Cancellation while awaiting approval never forwards and leaves no audit decision, identically under the legacy and `2026-07-28` protocol styles.
- The same normalized action and policy produce identical decisions on every protocol revision declared by the supported legacy and `2026-07-28` stdio rows of the compatibility matrix; Schema fingerprints are identical across revisions and still change when the tool Schema changes.

## CI matrix

CI runs on macOS and Linux with Node.js 20, 22, and 24. Every cell runs:

```bash
npm ci
npm run verify
npm audit --omit=dev
```

`npm run verify` includes the conformance gate, so every CI cell regenerates `conformance/report.json` for its own OS × Node.js cell; the report records the generating environment and date. The release commit keeps the matrix and report synchronized with the package version.

Windows Broker transport is not implemented in the current release and remains fail-closed. Its security and CI gates are tracked in [`ROADMAP.md`](ROADMAP.md).
