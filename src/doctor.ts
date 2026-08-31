import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brokerStatus, defaultBrokerPaths, type BrokerPaths } from "./broker.js";
import { loadPolicy } from "./config.js";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  check: "node" | "policy" | "broker" | "upstream" | "conformance";
  status: DoctorStatus;
  message: string;
}

export interface DoctorOptions {
  policy?: string;
  workspace: string;
  upstreamCommand?: string;
  args: string[];
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

interface DoctorDependencies {
  brokerPaths?: BrokerPaths;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  startupTimeoutMs?: number;
  conformanceRoot?: string;
}

const CONFORMANCE_STATUSES = new Set(["supported", "experimental", "unverified", "unsupported"]);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

interface ConformanceMatrix {
  matrixVersion?: number;
  toolfenceVersion?: string;
  rows?: Array<{ id?: string; status?: string; mcpProtocol?: string[] }>;
}

interface ConformanceReport {
  matrixVersion?: number;
  generatedAt?: string;
  rows?: Array<{ id?: string; revision?: string; status?: string }>;
}

// The matrix/report use the supported/experimental/unverified/unsupported
// vocabulary. A supported row is verified only when every declared protocol
// revision has a passing dated report entry bound to the same matrix version;
// stale, undated, mismatched, or incomplete evidence downgrades to warn, and
// unsupported combinations never expand permissions (the proxy is fail-closed
// for every protocol shape).
export function conformanceCheck(root: string, packageVersion: string): DoctorCheck {
  const matrixPath = join(root, "conformance", "matrix.json");
  if (!existsSync(matrixPath)) {
    return {
      check: "conformance",
      status: "warn",
      message: "No conformance matrix is shipped; protocol compatibility claims are unverified and stay fail-closed",
    };
  }
  let matrix: ConformanceMatrix;
  try {
    matrix = JSON.parse(readFileSync(matrixPath, "utf8")) as ConformanceMatrix;
  } catch (error) {
    return { check: "conformance", status: "fail", message: `Conformance matrix is malformed: ${errorMessage(error)}` };
  }
  const rows = matrix.rows ?? [];
  if (!rows.every((row) => typeof row.id === "string" && CONFORMANCE_STATUSES.has(row.status ?? ""))) {
    return {
      check: "conformance",
      status: "fail",
      message: "Conformance matrix rows must each declare an id and a status in supported/experimental/unverified/unsupported",
    };
  }
  const reportPath = join(root, "conformance", "report.json");
  let report: ConformanceReport | undefined;
  if (existsSync(reportPath)) {
    try {
      report = JSON.parse(readFileSync(reportPath, "utf8")) as ConformanceReport;
    } catch (error) {
      return { check: "conformance", status: "warn", message: `Conformance report is malformed: ${errorMessage(error)}` };
    }
  }

  const supported = rows.filter((row) => row.status === "supported");
  const experimental = rows.filter((row) => row.status === "experimental").length;
  const unverified = rows.filter((row) => row.status === "unverified").length;
  const unsupported = rows.filter((row) => row.status === "unsupported").length;
  const evidenceOk = report !== undefined &&
    Number.isInteger(report.matrixVersion) &&
    Number.isInteger(matrix.matrixVersion) &&
    report.matrixVersion === matrix.matrixVersion &&
    typeof report.generatedAt === "string" && report.generatedAt.length > 0;

  const verified: string[] = [];
  const incomplete: string[] = [];
  for (const row of supported) {
    const revisions = (row.mcpProtocol ?? []).filter((value): value is string => typeof value === "string");
    const allPass = revisions.length > 0 && revisions.every((revision) =>
      report?.rows?.some((entry) => entry.id === row.id && entry.revision === revision && entry.status === "pass"),
    );
    if (evidenceOk && allPass) verified.push(row.id!);
    else incomplete.push(row.id!);
  }

  if (!(typeof matrix.toolfenceVersion === "string" && matrix.toolfenceVersion.length > 0)) {
    return {
      check: "conformance",
      status: "warn",
      message: "Conformance matrix has no toolfenceVersion; evidence is unverifiable and stays fail-closed",
    };
  }
  if (packageVersion && matrix.toolfenceVersion !== packageVersion) {
    return {
      check: "conformance",
      status: "warn",
      message: `Conformance matrix targets ${matrix.toolfenceVersion} but this package is ${packageVersion}; evidence is stale and stays fail-closed`,
    };
  }
  if (!existsSync(reportPath)) {
    return {
      check: "conformance",
      status: "warn",
      message: `Conformance matrix declares ${supported.length} supported row(s) but no report.json; run 'npm run conformance' to verify (unverified rows stay fail-closed)`,
    };
  }
  report = report ?? { matrixVersion: undefined, generatedAt: undefined, rows: [] };
  if (!Number.isInteger(matrix.matrixVersion)) {
    return {
      check: "conformance",
      status: "warn",
      message: "Conformance matrix has no integer matrixVersion; evidence is unverifiable and stays fail-closed",
    };
  }
  if (!Number.isInteger(report.matrixVersion)) {
    return {
      check: "conformance",
      status: "warn",
      message: "Conformance report has no integer matrixVersion; evidence is unverifiable and stays fail-closed",
    };
  }
  if (report.matrixVersion !== matrix.matrixVersion) {
    return {
      check: "conformance",
      status: "warn",
      message: `Conformance report is for matrix version ${report.matrixVersion} but the matrix is ${matrix.matrixVersion}; evidence is stale and stays fail-closed`,
    };
  }
  if (!(typeof report.generatedAt === "string" && report.generatedAt.length > 0)) {
    return {
      check: "conformance",
      status: "warn",
      message: "Conformance report has no generatedAt date; evidence is undated and stays fail-closed",
    };
  }
  if (incomplete.length > 0) {
    return {
      check: "conformance",
      status: "warn",
      message: `Conformance evidence is incomplete for supported rows: ${incomplete.join(", ")} (missing a passing dated run for every declared protocol revision); unverified rows stay fail-closed`,
    };
  }
  const generated = report.generatedAt.slice(0, 10);
  return {
    check: "conformance",
    status: verified.length > 0 && verified.length === supported.length ? "pass" : "warn",
    message:
      `${verified.length}/${supported.length} supported stdio row(s) verified by the conformance corpus (report ${generated}); ` +
      `experimental: ${experimental}, unverified: ${unverified}, unsupported: ${unsupported}; ` +
      "unverified or unsupported combinations never expand permissions and remain fail-closed",
  };
}

async function probeUpstream(command: string, args: string[], cwd: string, timeoutMs: number): Promise<DoctorCheck> {
  return await new Promise((resolveDone) => {
    const detached = process.platform !== "win32";
    const child = spawn(command, args, { cwd, stdio: "ignore", detached });
    let settled = false;
    const terminate = () => {
      try {
        if (detached && child.pid) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      child.unref();
    };
    const finish = (status: DoctorStatus, message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveDone({ check: "upstream", status, message });
    };
    const timer = setTimeout(() => {
      finish("pass", `${basename(command)} stayed running through the startup probe`);
      terminate();
    }, timeoutMs);
    child.once("error", (error) => finish("fail", `Could not start ${basename(command)}: ${error.message}`));
    child.once("exit", (code, signal) => {
      terminate();
      if (code === 0) {
        finish("pass", `${basename(command)} started and exited cleanly`);
      } else {
        finish("fail", `${basename(command)} exited during startup with ${signal ? `signal ${signal}` : `code ${code}`}`);
      }
    });
  });
}

export async function diagnose(
  options: DoctorOptions,
  dependencies: DoctorDependencies = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const nodeVersion = dependencies.nodeVersion ?? process.versions.node;
  const nodeMajor = Number(nodeVersion.split(".")[0]);
  checks.push(Number.isInteger(nodeMajor) && nodeMajor >= 20
    ? { check: "node", status: "pass", message: `Node.js ${nodeVersion} satisfies >=20` }
    : { check: "node", status: "fail", message: `Node.js ${nodeVersion} does not satisfy >=20` });

  if (!options.policy) {
    checks.push({ check: "policy", status: "warn", message: "No policy path supplied; pass --policy to validate one" });
  } else {
    try {
      const policy = loadPolicy(options.policy);
      checks.push({
        check: "policy",
        status: "pass",
        message: `Policy is valid with ${policy.rules.length} rule${policy.rules.length === 1 ? "" : "s"}`,
      });
    } catch (error) {
      checks.push({ check: "policy", status: "fail", message: `Policy validation failed: ${errorMessage(error)}` });
    }
  }

  const platform = dependencies.platform ?? process.platform;
  const paths = dependencies.brokerPaths ?? defaultBrokerPaths();
  if (platform === "win32") {
    checks.push({ check: "broker", status: "warn", message: "The local Broker is not supported on Windows" });
  } else if (!existsSync(paths.socketPath)) {
    checks.push({ check: "broker", status: "warn", message: "Broker is not running; start it with 'toolfence broker'" });
  } else {
    try {
      const status = await brokerStatus(paths);
      const insecure = [
        ["runtime directory", paths.runtimeDir, 0o700],
        ["socket", paths.socketPath, 0o600],
        ["token", paths.tokenPath, 0o600],
      ] as const;
      const invalid = insecure.filter(([, path, expected]) => mode(path) !== expected);
      checks.push(invalid.length === 0
        ? {
            check: "broker",
            status: "pass",
            message: `Broker protocol ${status.protocolVersion} is ready with private runtime permissions`,
          }
        : {
            check: "broker",
            status: "fail",
            message: `Insecure Broker permissions: ${invalid.map(([name, path, expected]) => `${name} ${path} must be ${expected.toString(8)}`).join(", ")}`,
          });
    } catch (error) {
      checks.push({ check: "broker", status: "fail", message: `Broker check failed: ${errorMessage(error)}` });
    }
  }

  if (!options.upstreamCommand) {
    checks.push({ check: "upstream", status: "warn", message: "No upstream command supplied; pass it after '--' to probe startup" });
  } else {
    checks.push(await probeUpstream(
      options.upstreamCommand,
      options.args,
      options.workspace,
      dependencies.startupTimeoutMs ?? 500,
    ));
  }

  let packageVersion = "";
  try {
    packageVersion = (JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: string }).version ?? "";
  } catch {
    // The package manifest is optional for the conformance evidence check.
  }
  checks.push(conformanceCheck(dependencies.conformanceRoot ?? packageRoot, packageVersion));

  return { ok: checks.every((check) => check.status !== "fail"), checks };
}

export function formatDoctorReport(report: DoctorReport): string {
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const check of report.checks) counts[check.status] += 1;
  return [
    "ToolFence doctor",
    ...report.checks.map((check) => `${check.status.toUpperCase().padEnd(4)} ${check.check.padEnd(8)} ${check.message}`),
    `Summary: ${counts.pass} passed, ${counts.warn} warning${counts.warn === 1 ? "" : "s"}, ${counts.fail} failed`,
  ].join("\n");
}
