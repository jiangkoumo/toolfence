# Contributing to ToolFence

Thank you for helping improve ToolFence. Security-sensitive changes should be small, explicit, and backed by denial-path tests.

## Development setup

ToolFence requires Node.js 20 or newer.

```bash
npm ci
npm run verify
```

`verify` runs the TypeScript checker, complete test suite, production build, a clean tarball installation smoke test, and package dry run. Before opening a pull request, also run:

```bash
npm audit --omit=dev
```

Maintainers preparing a release must also run `npm run release:check`; it validates stable version alignment, public package metadata, changelog coverage, Git state, and any required dual-use disclosure.

## Pull requests

- Explain the user-facing behavior and any trust-boundary impact.
- Add tests for success, denial, malformed input, cancellation, timeout, or disconnect paths that the change affects.
- Keep stdout reserved for MCP JSON-RPC when changing proxy or CLI behavior.
- Do not log raw tool arguments, command arguments, approval tokens, or raw upstream results.
- Update README, TESTING, and CHANGELOG when behavior or release guarantees change.

For architecture, invariants, and detailed test expectations, read [DEVELOPMENT.md](DEVELOPMENT.md) and [TESTING.md](TESTING.md).

## Security reports

Do not open a public issue for a suspected vulnerability. Follow [SECURITY.md](SECURITY.md).
