# Security Policy

## Supported versions

Security fixes are provided for the latest published 0.2.x release. Users should upgrade to the newest patch before reporting an issue that may already be fixed.

## Reporting a vulnerability

Please use the repository's private GitHub vulnerability-reporting or Security Advisory flow. Do not include exploit details, credentials, approval tokens, policy files containing sensitive paths, or audit records in a public issue.

Include the affected ToolFence and Node.js versions, operating system, MCP client/server pair, a minimal reproduction, and the expected versus observed policy decision. Redact all secrets and personal paths.

You should receive an acknowledgement within seven days. Publication and remediation timing depend on severity and the availability of a safe fix.

## Security boundary

ToolFence mediates MCP calls that cross its stdio proxy. It does not sandbox the upstream server process or prevent that process from directly using its operating-system permissions. See the security boundary in [README.md](README.md) before deployment.
