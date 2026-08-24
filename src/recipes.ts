export interface PolicyRecipe {
  name: string;
  description: string;
  defaultServer: string;
  policy: string;
}

export const builtInRecipes: Record<string, PolicyRecipe> = {
  filesystem: {
    name: "filesystem",
    description: "Protection for local filesystem MCP servers (denies secrets, allows workspace)",
    defaultServer: "filesystem",
    policy: `# ToolFence policy for Filesystem MCP server
version: 1
default: ask

rules:
  - id: protect-secrets
    effect: deny
    operations: [fs.read, fs.write, fs.delete]
    resources:
      - "**/.env"
      - "**/.env.*"
      - "**/*.pem"
      - "\${home}/.ssh/**"

  - id: allow-workspace-read
    effect: allow
    operations: [fs.read]
    resources:
      - "\${workspace}/**"

  - id: allow-workspace-write
    effect: allow
    operations: [fs.write]
    resources:
      - "\${workspace}/**"

  - id: allow-git-read
    effect: allow
    operations: [git.read]
`,
  },
  github: {
    name: "github",
    description: "Policy for GitHub MCP server (allows repository and PR inspection, restricts modifications)",
    defaultServer: "github",
    policy: `# ToolFence policy for GitHub MCP server
version: 1
default: ask

rules:
  - id: allow-repo-read
    effect: allow
    operations: [git.read, net.request]
    hosts:
      - "api.github.com"
      - "github.com"
    methods: [GET, HEAD]

  - id: allow-local-git-read
    effect: allow
    operations: [git.read]

  - id: ask-git-write
    effect: ask
    operations: [git.write]

  - id: deny-uncontrolled-push
    effect: deny
    operations: [git.remote]
`,
  },
  fetch: {
    name: "fetch",
    description: "Policy for HTTP / Fetch MCP servers (blocks common literal private and metadata hosts)",
    defaultServer: "fetch",
    policy: `# ToolFence policy for Fetch / HTTP MCP servers
version: 1
default: ask

rules:
  - id: deny-private-networks-and-metadata
    effect: deny
    operations: [net.request]
    hosts:
      - "127.*"
      - "localhost"
      - "169.254.*"
      - "10.*"
      - "172.1[6-9].*"
      - "172.2[0-9].*"
      - "172.3[0-1].*"
      - "192.168.*"
      - "[[]::[]]"
      - "[[]::1[]]"
      - "[[]f[cd]*"
      - "[[]fe[89ab]*"
      - "*.local"
      - "*.internal"

  - id: allow-public-web-read
    effect: allow
    operations: [net.request]
    methods: [GET, HEAD]
`,
  },
  git: {
    name: "git",
    description: "Policy for Git MCP server (allows status/log/diff reads, prompts for commits, denies remotes)",
    defaultServer: "git",
    policy: `# ToolFence policy for Git MCP server
version: 1
default: ask

rules:
  - id: allow-git-inspection
    effect: allow
    operations: [git.read]

  - id: allow-git-safe-status
    effect: allow
    operations: [shell.exec]
    commands:
      - [git, status]
      - [git, diff]
      - [git, log]

  - id: deny-direct-remote-push
    effect: deny
    operations: [git.remote]
`,
  },
  sqlite: {
    name: "sqlite",
    description: "Policy for SQLite MCP server (allows read queries, protects database files and secrets)",
    defaultServer: "sqlite",
    policy: `# ToolFence policy for SQLite MCP server
version: 1
default: ask

rules:
  - id: protect-database-secrets
    effect: deny
    operations: [fs.read, fs.write, fs.delete]
    resources:
      - "**/.env"
      - "**/.env.*"
      - "**/*.pem"
      - "\${home}/.ssh/**"

  - id: allow-workspace-db-read
    effect: allow
    operations: [fs.read]
    resources:
      - "\${workspace}/**"
`,
  },
  postgres: {
    name: "postgres",
    description: "Policy for PostgreSQL MCP server (allows queries, protects system files and cloud metadata)",
    defaultServer: "postgres",
    policy: `# ToolFence policy for PostgreSQL MCP server
version: 1
default: ask

rules:
  - id: deny-cloud-metadata
    effect: deny
    operations: [net.request]
    hosts:
      - "169.254.169.254"
      - "127.0.0.1"
      - "localhost"

  - id: protect-host-credentials
    effect: deny
    operations: [fs.read, fs.write, fs.delete]
    resources:
      - "\${home}/.pgpass"
      - "\${home}/.ssh/**"
      - "**/.env"
      - "**/.env.*"
`,
  },
};

export function listRecipes(): Array<{ name: string; description: string; defaultServer: string }> {
  return Object.values(builtInRecipes).map(({ name, description, defaultServer }) => ({
    name,
    description,
    defaultServer,
  }));
}

export function getRecipe(name: string): PolicyRecipe | undefined {
  return builtInRecipes[name.toLowerCase().trim()];
}
