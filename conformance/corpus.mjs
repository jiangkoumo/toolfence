// ToolFence conformance corpus (shared evidence definition).
//
// Used by the vitest suite (test/conformance.test.ts) and the release gate
// (scripts/conformance.mjs). The corpus proves three things:
//
//   1. The same normalized action and policy produce the same decision across
//      every protocol revision declared by a supported matrix row (the legacy
//      handshake revisions and MCP 2026-07-28) on the verified stdio fixtures.
//   2. Protocol revision metadata is neutral: an unverified protocol version in
//      per-request _meta changes neither the decision nor the forwarding, and
//      the payload still reaches the upstream verbatim.
//   3. ToolFence passes legitimate protocol content through transparently.
//
// The fixtures that exercise server/discover, per-request _meta, list cache
// metadata, and MRTR are pass-through evidence only: they never mean ToolFence
// implements or claims the corresponding higher-level capabilities. Unverified
// or unsupported combinations never expand permissions and remain fail-closed.

export const STATUSES = ["supported", "experimental", "unverified", "unsupported"];

export const MODERN_PROTOCOL = "2026-07-28";

export const MODERN_TRACE = {
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  tracestate: "congo=t61rcWkgMzE",
  baggage: "userId=alice",
};

// An unverified protocol revision used to prove metadata neutrality.
export const UNVERIFIED_PROTOCOL = "2999-01-01";

export function modernMeta(protocolVersion = MODERN_PROTOCOL) {
  return {
    "io.modelcontextprotocol/protocolVersion": protocolVersion,
    "io.modelcontextprotocol/clientInfo": { name: "conformance-client", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
    ...MODERN_TRACE,
  };
}

// The tool surface implemented by both conformance fixtures.
export const TOOLS = ["read_file", "read_multiple_files", "run_command", "fetch", "ask_user"];

// Protocol setup requests that precede corpus tool calls. `protocolVersion` is
// the matrix row revision being exercised, so every declared revision runs the
// full lifecycle instead of one representative version.
export function preamble(style, firstId = 1, protocolVersion = MODERN_PROTOCOL) {
  if (style === "legacy") {
    return [
      {
        jsonrpc: "2.0",
        id: firstId,
        method: "initialize",
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "conformance-client", version: "1.0.0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ];
  }
  return [{ jsonrpc: "2.0", id: firstId, method: "server/discover", params: { _meta: modernMeta(protocolVersion) } }];
}

// Build a tools/call message in the given protocol style. `metaOverride`
// replaces the entire per-request _meta for the modern style and is ignored for
// legacy requests; it lets the corpus exercise unverified protocol versions.
export function toolCall({ style, id, name, args = {}, metaOverride }) {
  const params = { name, arguments: args };
  if (style === "modern") params._meta = metaOverride ?? modernMeta();
  return { jsonrpc: "2.0", id, method: "tools/call", params };
}

// The decision corpus. Every case runs against every supported matrix row and
// every declared protocol revision; the runner then asserts that equivalent
// calls produce identical decisions across all of them.
//
// approval: "reject" | "approve" | "hang" selects the ApprovalRequester used
// for the case. `expect.effect` is the final decision recorded in the audit
// (after approval for ask paths); `askPath` marks cases that must first enter
// approval; `noAudit` marks cancellation paths that must never leave a record.
// `neutralMeta` marks the case that additionally runs once with an unverified
// protocol version in per-request _meta and must produce the same decision.
export const DECISION_CASES = [
  {
    id: "allow-known-read",
    tool: "read_file",
    args: { path: "safe.txt" },
    policy: () => ({
      version: 1,
      default: "deny",
      rules: [
        { id: "allow-workspace", effect: "allow", operations: ["fs.read"], resources: ["${workspace}/**"] },
      ],
    }),
    approval: "reject",
    expect: { effect: "allow", forwarded: true },
  },
  {
    id: "deny-secret-env",
    tool: "read_file",
    args: { path: ".env" },
    policy: () => ({
      version: 1,
      default: "deny",
      rules: [
        { id: "deny-env", effect: "deny", operations: ["fs.read"], resources: ["**/.env"] },
      ],
    }),
    approval: "reject",
    expect: { effect: "deny", forwarded: false },
  },
  {
    id: "deny-no-rule",
    tool: "read_file",
    args: { path: "safe.txt" },
    policy: () => ({ version: 1, default: "deny", rules: [] }),
    approval: "reject",
    expect: { effect: "deny", forwarded: false },
  },
  {
    id: "ask-then-approve",
    tool: "read_file",
    args: { path: "safe.txt" },
    policy: () => ({ version: 1, default: "ask", rules: [] }),
    approval: "approve",
    expect: { effect: "allow", forwarded: true, askPath: true, resolution: "allow-once" },
  },
  {
    id: "ask-then-reject",
    tool: "read_file",
    args: { path: "safe.txt" },
    policy: () => ({ version: 1, default: "ask", rules: [] }),
    approval: "reject",
    expect: { effect: "deny", forwarded: false, askPath: true, resolution: "deny" },
  },
  {
    id: "unknown-uncertain-default-allow",
    tool: "mystery_tool",
    args: {},
    policy: () => ({ version: 1, default: "allow", rules: [] }),
    approval: "reject",
    expect: { effect: "deny", forwarded: false, askPath: true },
  },
  {
    id: "ambiguous-uncertain-default-allow",
    tool: "read_file",
    args: { path: 42 },
    policy: () => ({ version: 1, default: "allow", rules: [] }),
    approval: "reject",
    expect: { effect: "deny", forwarded: false, askPath: true },
  },
  {
    id: "mixed-resources-deny",
    tool: "read_multiple_files",
    args: { paths: ["safe.txt", ".env"] },
    policy: () => ({
      version: 1,
      default: "deny",
      rules: [
        { id: "deny-env", effect: "deny", operations: ["fs.read"], resources: ["**/.env"] },
        { id: "allow-workspace", effect: "allow", operations: ["fs.read"], resources: ["${workspace}/**"] },
      ],
    }),
    approval: "reject",
    expect: { effect: "deny", forwarded: false },
  },
  {
    id: "shell-exact-argv-allow",
    tool: "run_command",
    args: { command: "ls -la" },
    policy: () => ({
      version: 1,
      default: "deny",
      rules: [{ id: "allow-shell", effect: "allow", operations: ["shell.exec"] }],
    }),
    approval: "reject",
    expect: { effect: "allow", forwarded: true },
  },
  {
    id: "net-host-deny",
    tool: "fetch",
    args: { url: "http://127.0.0.1:9/secret" },
    policy: () => ({
      version: 1,
      default: "deny",
      rules: [{ id: "deny-loopback", effect: "deny", operations: ["net.request"], hosts: ["127.0.0.1"] }],
    }),
    approval: "reject",
    expect: { effect: "deny", forwarded: false },
  },
  {
    // Protocol revision metadata must be neutral: the same known action is
    // allowed and forwarded identically whether per-request _meta advertises
    // the verified revision or an unverified one, and the unverified payload
    // still reaches the upstream verbatim. The runner performs the extra
    // unverified-variant run for the modern style.
    id: "unverified-protocol-version-neutral",
    tool: "read_file",
    args: { path: "safe.txt" },
    policy: () => ({
      version: 1,
      default: "deny",
      rules: [
        { id: "allow-workspace", effect: "allow", operations: ["fs.read"], resources: ["${workspace}/**"] },
      ],
    }),
    approval: "reject",
    neutralMeta: true,
    expect: { effect: "allow", forwarded: true },
  },
  {
    id: "ask-cancel-never-forwards",
    tool: "read_file",
    args: { path: "safe.txt" },
    policy: () => ({ version: 1, default: "ask", rules: [] }),
    approval: "hang",
    expect: { effect: undefined, forwarded: false, noAudit: true },
  },
];

// MRTR (Multi Round-Trip Requests) pass-through scenario: a server answers a
// tool call with `resultType: "input_required"` plus a requestState, and the
// client retries the same call with inputResponses. ToolFence only proves it
// forwards both directions without changing them; the expected literals below
// are the exact fixture payloads used for deep comparison.
export const MRTR_CALL = { name: "ask_user", args: {} };
export const MRTR_RETRY = {
  name: "ask_user",
  args: { requestState: "rs-1", inputResponses: [{ id: "q1", response: "yes" }] },
};
export const MRTR_INPUT_REQUIRED = {
  resultType: "input_required",
  requestState: "rs-1",
  requests: [{ id: "q1", type: "input/confirmation", prompt: "Continue?" }],
};
export const MRTR_COMPLETE = { resultType: "complete", content: [{ type: "text", text: "answered" }] };
