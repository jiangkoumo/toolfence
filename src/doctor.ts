import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { brokerStatus, defaultBrokerPaths, type BrokerPaths } from "./broker.js";
import { loadPolicy } from "./config.js";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  check: "node" | "policy" | "broker" | "upstream";
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
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
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
