# Releasing ToolFence

Releases after the initial package creation are published from GitHub Actions with npm trusted publishing. No long-lived npm write token should be added to the repository.

## Trusted publisher state

The one-time npm bootstrap and GitHub Actions trust binding were completed during the v0.2.x release line. Do not repeat the interactive bootstrap publish. Future versions must be published only through `publish.yml`; keep release tags protected and restrict workflow changes to reviewed pull requests.

## Release checklist

1. Update `package.json`, `package-lock.json`, `CHANGELOG.md`, and the CLI-facing documentation.
2. Run `npm run conformance` and commit the regenerated `conformance/report.json` so the dated corpus evidence matches the release version.
3. Run `npm ci`, `npm run release:check`, `npm run verify`, and `npm audit --omit=dev` from a clean checkout. `release:check` fails unless every `supported` conformance matrix row has a passing dated report entry.
4. Confirm `node dist/cli.js --version` matches the package version.
5. Merge the release commit only after the full CI matrix passes.
6. Create and push an annotated `v<version>` tag. The `publish.yml` workflow validates the tag is on `main`, audits production dependencies, publishes through OIDC, and attaches the installable npm `.tgz` to a GitHub Release.
7. Verify the npm package contents, executable, provenance, GitHub Release asset, and installation from a clean temporary project.

ToolFence is declared as dual-use under npm's current content policy because it launches user-configured processes and mediates Shell, Git, and HTTP capabilities. Every release must retain `"contentPolicy": { "class": "dual-use" }` and the root `DISCLOSURE` text file. npm treats that declaration as permanent and requires 2FA-enforced publishing.

If publication fails, do not reuse or move the tag. Fix the issue, increment the version, and create a new release commit and tag.
