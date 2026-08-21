import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "toolfence-package-smoke-"));
const packageDirectory = join(root, "package");
const installDirectory = join(root, "install");

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "ignore",
  });
}

try {
  mkdirSync(packageDirectory);
  mkdirSync(installDirectory);
  const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  run("npm", ["pack", "--pack-destination", packageDirectory]);
  const tarball = join(packageDirectory, `${packageJson.name}-${packageJson.version}.tgz`);

  run("npm", ["init", "-y"], { cwd: installDirectory });
  run("npm", ["install", tarball, "--ignore-scripts", "--no-package-lock", "--prefer-offline"], {
    cwd: installDirectory,
  });

  const executable = join(installDirectory, "node_modules", ".bin", "toolfence");
  const installedPackage = join(installDirectory, "node_modules", packageJson.name);
  for (const file of [
    "ROADMAP.md",
    "docs/assets/architecture.svg",
    "docs/assets/demo.gif",
    "docs/codex.md",
    "docs/cursor.md",
    "docs/claude-desktop.md",
  ]) {
    if (!existsSync(join(installedPackage, file))) {
      throw new Error(`Installed package is missing ${file}`);
    }
  }
  const version = run(executable, ["--version"], { cwd: installDirectory, capture: true }).trim();
  if (version !== packageJson.version) {
    throw new Error(`Installed CLI version ${JSON.stringify(version)} does not match ${packageJson.version}`);
  }

  run(executable, ["policy", "init", "--policy", "policy.yaml"], { cwd: installDirectory });
  run(executable, ["policy", "check", "--policy", "policy.yaml"], { cwd: installDirectory });
  const doctor = JSON.parse(run(
    executable,
    ["doctor", "--policy", "policy.yaml", "--json", "--", process.execPath, "--version"],
    { cwd: installDirectory, capture: true },
  ));
  if (!doctor.ok || !doctor.checks?.some((check) => check.check === "upstream" && check.status === "pass")) {
    throw new Error("Installed doctor command did not pass its startup probe");
  }
  run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { initPolicy, PolicyEngine, readAudit, startProxy, summarizeAudit, tailAudit } from 'toolfence-mcp'; if (![initPolicy, PolicyEngine, readAudit, startProxy, summarizeAudit, tailAudit].every(Boolean)) process.exit(1)",
    ],
    { cwd: installDirectory },
  );

  process.stdout.write(`Package smoke test passed: toolfence-mcp@${packageJson.version}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
