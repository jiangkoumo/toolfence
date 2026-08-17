# Releasing ToolFence

Releases after the initial package creation are published from GitHub Actions with npm trusted publishing. No long-lived npm write token should be added to the repository.

## One-time repository setup

1. Create the public GitHub repository and set `repository.url` in `package.json` to its exact `git+https` URL.
2. Push the repository and confirm every macOS/Linux CI cell passes.
3. Enable 2FA on the npm maintainer account. A trusted publisher cannot be configured until the package exists.
4. Run `npm run release:check`, then create `toolfence-mcp@0.2.0` once with an interactive `npm publish` that completes the 2FA challenge.
5. Using npm 11.15 or newer, bind future releases to GitHub Actions:

   ```bash
   npm trust github toolfence-mcp \
     --file publish.yml \
     --repo OWNER/REPOSITORY \
     --allow-publish \
     --yes
   ```

6. Protect release tags and restrict workflow changes to reviewed pull requests.

The initial interactive publish is the only bootstrap exception. After the trust relationship exists, publish future versions only through `publish.yml`. The workflow safely skips publication when a version already exists, so the `v0.2.0` tag can be pushed after the bootstrap publish without attempting to replace it.

## Release checklist

1. Update `package.json`, `package-lock.json`, `CHANGELOG.md`, and the CLI-facing documentation.
2. Run `npm ci`, `npm run release:check`, `npm run verify`, and `npm audit --omit=dev` from a clean checkout.
3. Confirm `node dist/cli.js --version` matches the package version.
4. Merge the release commit only after the full CI matrix passes.
5. Create and push an annotated `v<version>` tag. The `publish.yml` workflow validates and publishes through OIDC.
6. Verify the npm package contents, executable, provenance, and installation from a clean temporary project.

Before the first publish, review npm's current dual-use content policy. If ToolFence is classified as dual-use, add `"contentPolicy": { "class": "dual-use" }` and a root `DISCLOSURE` text file before publishing. That declaration is permanent for later versions and requires 2FA-enforced publishing, so do not add or remove it casually.

If publication fails, do not reuse or move the tag. Fix the issue, increment the version, and create a new release commit and tag.
