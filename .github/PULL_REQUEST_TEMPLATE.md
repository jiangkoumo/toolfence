## What changed

Describe the user-visible behavior and why the change is needed.

## Trust-boundary impact

Explain any effect on normalization, policy decisions, approvals, audit data, upstream execution, or package distribution. Write `None` when there is no impact.

## Verification

- [ ] I added or updated tests for affected success, denial, malformed-input, cancellation, timeout, or disconnect paths.
- [ ] `npm run verify` passes.
- [ ] I updated README, TESTING, and CHANGELOG when behavior or release guarantees changed.
- [ ] Stdout remains reserved for MCP JSON-RPC where applicable.
- [ ] Tests, logs, and examples contain no secrets, approval tokens, raw sensitive arguments, or raw upstream results.
