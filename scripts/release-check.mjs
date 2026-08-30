import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(resolve(root, file), "utf8");
const packageJson = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));
const failures = [];

function requireCondition(condition, message) {
  if (!condition) failures.push(message);
}

const repositoryUrl = typeof packageJson.repository === "string"
  ? packageJson.repository
  : packageJson.repository?.url;

requireCondition(/^\d+\.\d+\.\d+$/.test(packageJson.version), "package version must be a stable SemVer");
requireCondition(lock.version === packageJson.version, "package-lock top-level version must match package.json");
requireCondition(
  lock.packages?.[""]?.version === packageJson.version,
  "package-lock root package version must match package.json",
);
requireCondition(
  typeof repositoryUrl === "string" && /^git\+https:\/\/github\.com\/[^/]+\/[^/]+\.git$/.test(repositoryUrl),
  "package.json repository.url must be the exact public GitHub repository (git+https://github.com/OWNER/REPO.git)",
);
requireCondition(packageJson.publishConfig?.access === "public", "publishConfig.access must be public");
requireCondition(packageJson.bin?.toolfence === "dist/cli.js", "toolfence binary must point to dist/cli.js");
requireCondition(packageJson.exports?.["."]?.import === "./dist/index.js", "public ESM export is missing");
requireCondition(packageJson.exports?.["."]?.types === "./dist/index.d.ts", "public type export is missing");

for (const file of ["CHANGELOG.md", "CONTRIBUTING.md", "LICENSE", "README.md", "RELEASING.md", "ROADMAP.md", "SECURITY.md"]) {
  requireCondition(existsSync(resolve(root, file)), `${file} is missing`);
  requireCondition(packageJson.files?.includes(file), `${file} is not included in the npm package`);
}

requireCondition(packageJson.files?.includes("docs"), "docs are not included in the npm package");
for (const file of [
  "docs/assets/architecture.svg",
  "docs/assets/demo.gif",
  "docs/assets/env-leak-demo.gif",
  "docs/AGENTTAPE_TOOLFENCE_ALIGNMENT.md",
  "docs/codex.md",
  "docs/cursor.md",
  "docs/claude-desktop.md",
]) {
  requireCondition(existsSync(resolve(root, file)), `${file} is missing`);
}

requireCondition(
  read("CHANGELOG.md").includes(`## [${packageJson.version}]`),
  `CHANGELOG.md has no ${packageJson.version} release entry`,
);
requireCondition(
  read("README.md").includes(`Version ${packageJson.version}`),
  `README.md does not identify Version ${packageJson.version}`,
);
requireCondition(
  read("ROADMAP.md").includes(`Current release: \`v${packageJson.version}\``),
  `ROADMAP.md does not identify v${packageJson.version} as the current release`,
);
requireCondition(
  read("DEVELOPMENT.md").includes(`当前实现版本为 \`${packageJson.version}\``),
  `DEVELOPMENT.md does not identify ${packageJson.version} as the current implementation`,
);

if (packageJson.contentPolicy) {
  requireCondition(
    packageJson.contentPolicy.class === "dual-use",
    "contentPolicy.class must be dual-use when contentPolicy is declared",
  );
  requireCondition(existsSync(resolve(root, "DISCLOSURE")), "dual-use packages require a root DISCLOSURE file");
  requireCondition(packageJson.files?.includes("DISCLOSURE"), "DISCLOSURE is not included in the npm package");
}

if (process.env.GITHUB_REF_TYPE === "tag") {
  requireCondition(
    process.env.GITHUB_REF_NAME === `v${packageJson.version}`,
    `tag ${process.env.GITHUB_REF_NAME ?? "(missing)"} must equal v${packageJson.version}`,
  );
}

if (!process.env.GITHUB_ACTIONS) {
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
    requireCondition(branch === "main", `release must run from main, not ${branch || "detached HEAD"}`);
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    requireCondition(status === "", "working tree must be clean before release");
  } catch (error) {
    failures.push(`unable to inspect Git state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures.length) {
  process.stderr.write(`Release check failed (${failures.length}):\n${failures.map((item) => `- ${item}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Release check passed: ${packageJson.name}@${packageJson.version}\n`);
}
