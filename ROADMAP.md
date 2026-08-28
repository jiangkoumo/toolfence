# ToolFence roadmap

Last reviewed: 2026-08-28. Current release: `v0.3.2`.

ToolFence is an early-stage security project. This roadmap communicates priorities and release gates, not dates. Security invariants, fail-closed behavior, and evidence-backed compatibility claims take precedence over feature count.

## Product direction

ToolFence is a local-first, deterministic policy enforcement and audit layer for MCP tool calls. It complements host-native approval prompts and operating-system isolation; it does not replace either one.

The next releases are ordered around four observations:

- The shipped policy engine, POSIX approval Broker, policy recipes, output redaction, host configuration helpers, diagnostics, and release pipeline form a credible local stdio baseline.
- MCP `2026-07-28` introduced a new stateless lifecycle, per-request metadata, `server/discover`, and revised Streamable HTTP semantics. ToolFence must prove compatibility across protocol eras before broadening its transport surface.
- Codex, Claude Code, and Cursor increasingly provide their own tool approval controls. ToolFence should differentiate through portable policy semantics, conservative normalization, and privacy-preserving evidence rather than another general-purpose prompt UI.
- Streamable HTTP and agent identity are important ecosystem directions, but they introduce authorization, token-audience, redirect, DNS-rebinding, and proxy-topology risks. They require a separate threat-model gate.

Planning inputs include the [MCP `2026-07-28` release](https://blog.modelcontextprotocol.io/posts/2026-07-28/), the [current MCP transport specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports), and the [August 2026 MCP roadmap](https://blog.modelcontextprotocol.io/posts/mcp-roadmap/).

## Shipped baseline: v0.3.2

The current release includes:

- deterministic `allow`, `ask`, and `deny` policy evaluation with conservative Filesystem, Shell, Git, and HTTP normalization;
- uncertain or malformed actions require approval instead of inheriting `default: allow`, unless an explicit matching rule authorizes them;
- in-flight request tracking fails closed at capacity, rejects duplicate IDs, and preserves accepted tool-result redaction and audit correlation until terminal response;
- authenticated POSIX approval Broker, one-time and session decisions, cancellation, timeout, and Schema-fingerprint invalidation;
- six curated policy recipes (`filesystem`, `github`, `fetch`, `sqlite`, `postgres`, `git`);
- default output secret redaction without storing raw arguments or raw results in audit logs;
- Codex, Cursor, Claude Desktop, and Claude Code configuration helpers, `toolfence doctor`, reproducible demos, coverage gates, package smoke tests, and trusted publishing;
- macOS/Linux CI on supported Node.js releases and real Filesystem, Shell, HTTP, and Git fixtures.

The current boundary remains intentionally narrow:

- MCP proxy transport is stdio only;
- interactive Broker transport is POSIX only, while Windows remains non-interactive and fail-closed;
- the upstream MCP Server keeps the operating-system permissions and environment of the ToolFence process;
- cross-Host end-to-end evidence, an explicitly versioned action model, and a versioned audit evidence contract are not yet shipped.

## Now: v0.3.3 protocol conformance evidence

**Outcome:** make every compatibility claim precise, reproducible, and release-gated before adding a new trust boundary.

**Starting point:** `v0.3.2` shipped the two security-contract repairs with regression coverage. Protocol conformance and compatibility evidence remain open.

Planned work:

- Publish a machine-readable stdio protocol matrix covering ToolFence, Node.js, MCP protocol revision, transport, and fixture/Server evidence. Record operating system and Host as evidence context without claiming the full Host × OS matrix in this phase.
- Add legacy initialization fixtures and MCP `2026-07-28` fixtures covering `server/discover`, per-request `_meta`, `tools/list`, `tools/call`, cancellation, cache metadata, and Multi Round-Trip Requests. These fixtures prove transparent pass-through; they do not mean ToolFence implements or claims the corresponding higher-level capabilities.
- Prove that the same normalized action and policy produce the same decision across supported protocol revisions and currently verified stdio configurations.
- Extend `toolfence doctor` and release checks so unsupported or unverified combinations are reported clearly without weakening fail-closed execution.
- Synchronize README, security policy, testing strategy, development guide, release instructions, and runtime version strings with the actual supported release.

Release gates:

1. Unknown, malformed, tracking-overflow, cancellation, timeout, disconnect, and redaction-failure paths have deterministic regression tests and cannot execute or return an unfiltered result.
2. Supported legacy and `2026-07-28` stdio fixtures produce identical policy decisions for equivalent tool calls. Every `supported` matrix row passes the same conformance corpus covering `allow`/`ask`/`deny`, unknown or ambiguous actions, mixed resources, cancellation, and Schema changes.
3. The compatibility matrix distinguishes `supported`, `experimental`, `unverified`, and `unsupported`, with evidence dates and no implied support.
4. `npm run verify`, the full CI matrix, package smoke tests, production dependency audit, and release preflight pass from a clean tree.

Non-goals for v0.3.3: new policy semantics, new recipes without demonstrated demand, Windows interactive approval, Streamable HTTP, OAuth, process isolation, or a remote service.

## Next: v0.4 cross-platform enforcement baseline

**Outcome:** provide the same safe approval and evidence contract across supported local Hosts and operating systems.

Planned work:

- Introduce a platform-neutral Broker transport abstraction and a Windows implementation using a user-scoped Named Pipe only after access-control and lifecycle review.
- Add Windows CI and exercise authentication, owner-only access, startup races, cancellation, timeout, disconnect, session invalidation, and cleanup.
- Keep Windows fail-closed if the runtime cannot prove private IPC and credential storage; do not emulate POSIX permission checks with misleading success.
- Version the normalized action model independently from the policy Schema and document compatibility and conservative downgrade rules.
- Version the audit evidence Schema and correlate the configured Host, MCP protocol revision, Server, tool and Schema fingerprint, action-model version, policy identity, rule ID, decision, and privacy-safe result summary.
- Maintain tested Codex, Claude Code, Cursor, and Claude Desktop setup paths, while explicitly reporting Host-native tools that can bypass the MCP proxy.

Release gates:

1. `ask` works through private local IPC on macOS, Linux, and supported native Windows environments; every IPC failure path denies the call.
2. Every `supported` Host × OS matrix row passes the same conformance corpus covering `allow`/`ask`/`deny`, unknown or ambiguous actions, mixed resources, cancellation, and Schema changes, with identical decisions for equivalent actions.
3. Audit records are migratable, validate strictly, omit raw arguments/results/credentials, and fully explain the supported decision path.
4. A new user can complete the first protected stdio tool call in under ten minutes using documented steps and `toolfence doctor`.

Non-goals for v0.4: cloud approval, a team console, remote policy distribution, automatic permanent policy edits, or a general operating-system sandbox.

## Then: v0.5-alpha constrained Streamable HTTP

**Outcome:** validate one narrowly defined remote-transport topology without turning ToolFence into a generic HTTP proxy or credential broker.

An architecture decision record and threat-model review are release prerequisites. They must define who owns OAuth credentials, which endpoint is the token audience, where policy is enforced, and how client/server identity survives the proxy boundary.

The alpha scope should include:

- MCP `2026-07-28` Streamable HTTP request/response and request-scoped SSE handling, with documented fallback boundaries for earlier supported revisions;
- strict Body/Header consistency for mirrored Streamable HTTP fields—protocol version, method, tool name, and applicable parameters—while client `_meta` is validated and propagated separately with the Body as the source of truth;
- TLS requirements, Origin validation, loopback binding rules, DNS and IP resolution checks, redirect re-evaluation, bounded responses, cancellation, timeout, and disconnect handling;
- credential-free local fixtures first; no authentication mode is called supported until issuer, audience, scope, storage, and token-forwarding rules have passed security review;
- the same normalization, policy, approval, redaction, and audit semantics as the stdio path.

Release gates:

1. Real Streamable HTTP fixtures cover JSON and SSE responses, cancellation, timeout, disconnect, redirects, DNS-rebinding/SSRF negatives, malformed headers, and oversized output.
2. Credentials and authorization metadata never enter Broker payloads, raw audit fields, diagnostics, or error messages.
3. An authenticated mode, if included, follows the current MCP authorization model and rejects token passthrough or audience ambiguity.
4. The feature remains explicitly `alpha` unless at least two independent Servers each pass every declared topology matrix row on two target Hosts.

Legacy HTTP+SSE, a public multi-tenant gateway, full OAuth provider hosting, and transparent proxying of arbitrary HTTP traffic are not targets for this phase.

## Decision gates after v0.5

These tracks are research candidates, not release promises:

- **Process isolation:** start with environment minimization, then prototype file, network, and resource controls per operating system. Promote only after an attack-oriented test suite proves the expanded boundary.
- **Tamper-evident evidence:** consider hash chains, signatures, retention/rotation, and OpenTelemetry export only after the local audit Schema and privacy model are stable in real deployments.
- **Packaging:** consider Desktop Extension or similar packaging only when it preserves the same policy, approval, update, and trust-boundary guarantees.
- **Team workflows:** do not build a cloud control plane until design partners demonstrate a need for shared policy distribution or centralized evidence that local export cannot satisfy.

## v1.0 readiness

ToolFence is ready for a stable `v1.0` commitment only when:

1. Policy, action-model, Broker, and audit Schemas have documented compatibility and migration rules.
2. Every claimed Host, operating system, protocol revision, transport, and Server class has repeatable conformance evidence.
3. Security boundaries and bypass paths are accurate, test-backed, and independently reviewed.
4. Release provenance, dependency auditing, vulnerability response, and supported-version policy are operational.
5. At least five design partners have used ToolFence in real workflows, including more than one Host or operating system, and the core cross-platform policy value is validated.

## Product and quality measures

- 100% fail-closed behavior for deny, unknown, malformed, cancellation, timeout, disconnect, capacity, and internal-error cases in the supported matrix.
- 100% decision consistency for equivalent normalized actions across supported Hosts, protocol revisions, and transports.
- Less than ten minutes from install to the first verified protected call.
- Compatibility claims carry a reproducible fixture or a dated manual verification record.
- New adapters, recipes, transports, and packaging formats require user evidence and must not silently broaden policy authority.

## Good first contribution candidates

- Add a protocol-era regression fixture or improve the compatibility-matrix generator.
- Improve a fail-closed error message while preserving stdout for JSON-RPC.
- Verify one Host setup guide on a supported operating system and record the evidence date.
- Add a malformed-input, cancellation, or lifecycle regression test described in [`TESTING.md`](TESTING.md).

Open a feature request before implementing a change that affects the trust boundary, protocol support contract, or policy semantics. Suspected vulnerabilities must follow [`SECURITY.md`](SECURITY.md), not a public issue.
