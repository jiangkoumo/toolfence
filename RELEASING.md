# Releasing ToolFence

Releases are published from GitHub Actions with npm trusted publishing. No long-lived npm write token should be added to the repository.

## One-time repository setup

1. Create the public GitHub repository and set `repository.url` in `package.json` to its exact URL.
2. Push the repository and confirm every macOS/Linux CI cell passes.
3. Create the `toolfence-mcp` package on npm if it does not already exist.
4. In the npm package settings, add a GitHub Actions trusted publisher for the exact repository and workflow filename `publish.yml`. Allow `npm publish`.
5. Protect release tags and restrict workflow changes to reviewed pull requests.

## Release checklist

1. Update `package.json`, `package-lock.json`, `CHANGELOG.md`, and the CLI-facing documentation.
2. Run `npm ci`, `npm run verify`, and `npm audit --omit=dev` from a clean checkout.
3. Confirm `node dist/cli.js --version` matches the package version.
4. Merge the release commit only after the full CI matrix passes.
5. Create and push an annotated `v<version>` tag. The `publish.yml` workflow validates and publishes through OIDC.
6. Verify the npm package contents, executable, provenance, and installation from a clean temporary project.

If publication fails, do not reuse or move the tag. Fix the issue, increment the version, and create a new release commit and tag.
