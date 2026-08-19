# ToolFence v0.2.x Test Strategy

The release gate is risk-based: a passing happy path is insufficient unless denial, cancellation, timeout, disconnect, and malformed-input paths are also exercised.

`npm run verify` enforces V8 coverage thresholds, packs the built package, installs it into a clean temporary project, exercises the installed npm binary through its real symlink, validates a generated policy, and imports the public ESM API.

`npm run release:check` is a separate publication gate because it intentionally fails until the final public GitHub repository URL is recorded. It also enforces version, changelog, package entry-point, Git cleanliness, tag, and dual-use disclosure consistency.

## Layers

1. Unit tests cover normalization, canonical paths, strict policy validation, deterministic rule priority, HTTP host/method matching, canonical Schema fingerprints, and fixed-seed fuzz/property invariants.
2. Component tests cover audit permissions and inspection, CLI argument boundaries and output, declarative policy commands, Broker authentication/protocol/queue behavior, targeted non-interactive approvals, session grants, and invalidation.
3. Proxy lifecycle tests cover approval, rejection, cancellation, timeout, upstream exit, result correlation, and Schema propagation.
4. Real integration tests cover the official Filesystem MCP Server plus repeatable Shell, HTTP, and Git MCP fixtures.
5. Coverage, packaging, and dependency gates cover enforced line/branch/function thresholds, typecheck, build, executable CLI mode, package contents, and production dependency audit.

## Security cases

- A deny rule wins over an allow rule.
- A mixed multi-resource read cannot carry a protected file.
- Existing and missing paths are canonicalized through existing symlink ancestors.
- Compound Shell input never matches exact argv authorization.
- Ambiguous Git input does not become `git.read`.
- HTTP authorization uses hostname without user info, port, or path; method is uppercase.
- Invalid URLs and explicit redirect destinations are re-evaluated or denied.
- Cancellation while awaiting approval never reaches upstream.
- Approval timeout, unavailable Broker, authentication failure, and disconnect fail closed.
- Session approval keys contain Server, Tool, operation, and Schema fingerprint.
- Broker and audit records omit raw arguments and raw results.
- Runtime directory, Socket, Token, and audit modes are checked on POSIX.

## CI matrix

CI runs on macOS and Linux with Node.js 20, 22, and 24. Every cell runs:

```bash
npm ci
npm run verify
npm audit --omit=dev
```

Windows Broker transport is explicitly out of scope for v0.2 and remains fail-closed.
