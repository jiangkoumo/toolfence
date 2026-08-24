#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { readFileSync, realpathSync } from "node:fs";
import { stdin as input, stdout as output } from "node:process";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TtyApprovalRequester } from "./approval.js";
import { AuditLogger, readAudit, summarizeAudit, tailAudit, type AuditSummary } from "./audit.js";
import {
  BrokerApprovalRequester,
  brokerStatus,
  defaultBrokerPaths,
  listApprovals,
  resolveApproval,
  startBroker,
  type BrokerDecision,
  type BrokerPaths,
} from "./broker.js";
import { initPolicy, loadPolicy } from "./config.js";
import { diagnose, formatDoctorReport, type DoctorOptions } from "./doctor.js";
import { generateHostSnippet, injectHostConfig, normalizeHost, type SupportedHost } from "./host.js";
import { canonicalizePath } from "./paths.js";
import { PolicyEngine } from "./policy.js";
import { checkPolicy, explainPolicy, testPolicy } from "./policy-tools.js";
import { listRecipes } from "./recipes.js";
import { startProxy } from "./proxy.js";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

export interface WrapOptions {
  command: "wrap";
  policy: string;
  server?: string;
  workspace: string;
  audit: string;
  approval: "broker" | "tty";
  upstreamCommand: string;
  args: string[];
}

export interface ApprovalOptions {
  command: "approvals";
  json: boolean;
  approvalId?: string;
  decision?: BrokerDecision;
}

export interface HostInitOptions {
  command: "host-init";
  host: SupportedHost;
  policy?: string;
  server?: string;
  workspace: string;
  write: boolean;
  json: boolean;
  scope?: "project" | "global";
  upstreamCommand?: string;
  args: string[];
}

export type CliOptions =
  | WrapOptions
  | { command: "broker" }
  | { command: "status" }
  | (DoctorOptions & { command: "doctor"; json: boolean })
  | ApprovalOptions
  | HostInitOptions
  | { command: "audit-summary"; audit: string; json: boolean }
  | { command: "audit-tail"; audit: string; json: boolean; lines: number }
  | { command: "policy-init"; policy: string; recipe?: string; listRecipes?: boolean }
  | { command: "policy-check"; policy: string }
  | { command: "policy-explain"; policy: string; action: string; workspace: string }
  | { command: "policy-test"; policy: string; cases: string };

function usage(): string {
  return `ToolFence ${version}

Usage:
  toolfence wrap --policy <file> [options] -- <command> [args...]
  toolfence broker
  toolfence status
  toolfence doctor [--policy <file>] [--workspace <path>] [--json] [-- <command> [args...]]
  toolfence host init --host <name> [--write] [--policy <file>] [--server <name>] [--workspace <path>] [--scope <project|global>] [-- <command> [args...]]
  toolfence init --host <name> [--write] [--policy <file>] [--server <name>] [--workspace <path>] [--scope <project|global>] [-- <command> [args...]]
  toolfence approvals [--json]
  toolfence approvals --id <approval-id> --decision <allow-once|allow-session|deny>
  toolfence audit summary [--audit <file>] [--json]
  toolfence audit tail [--audit <file>] [--lines <count>] [--json]
  toolfence policy init [--policy <file>] [--recipe <name>] [--list-recipes]
  toolfence policy check --policy <file>
  toolfence policy explain --policy <file> --action <file> [--workspace <path>]
  toolfence policy test --policy <file> --cases <file>

Wrap options:
  --policy <file>       YAML policy file (required)
  --server <name>       Server identity used by policy rules
  --workspace <path>    Working directory and relative-path root (default: cwd)
  --audit <file>        JSONL audit path (default: .toolfence/audit.jsonl)
  --approval <mode>     broker (default) or tty

Host options:
  --host <name>         cursor, claude, claude-desktop, claude-code, or codex (required)
  --write               Write/merge configuration directly to host config file
  --policy <file>       Policy path (default: ./toolfence.yaml)
  --server <name>       Server name in host config (default: filesystem)
  --workspace <path>    Workspace path (default: cwd)
  --scope <type>        project (default) or global
  --json                Print snippet as JSON

Approval options:
  --json                Print the privacy-safe pending queue as JSON
  --id <approval-id>    Resolve exactly one pending approval
  --decision <value>    allow-once, allow-session, or deny

Audit options:
  --audit <file>        JSONL audit path (default: .toolfence/audit.jsonl)
  --lines <count>       Tail record count, 1-10000 (default: 20)
  --json                Print summary or tail output as JSON

Policy options:
  --policy <file>       Policy YAML path (default: toolfence.yaml for init)
  --recipe <name>       Starter recipe (filesystem, github, fetch, sqlite, postgres, git)
  --list-recipes        List all available built-in policy recipes

Doctor options:
  --policy <file>       Validate a policy file
  --workspace <path>    Working directory for the startup probe (default: cwd)
  --json                Print the diagnostic report as JSON

  --help                Show this help
  --version             Show the version
`;
}

function optionMap(args: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--")) throw new Error(`Unexpected argument: ${flag ?? ""}`);
    if (!value) throw new Error(`Missing value for ${flag}`);
    options.set(flag, value);
  }
  return options;
}

function takeBooleanFlag(args: string[], flag: string): { present: boolean; args: string[] } {
  const matches = args.filter((argument) => argument === flag).length;
  if (matches > 1) throw new Error(`Duplicate option: ${flag}`);
  return { present: matches === 1, args: args.filter((argument) => argument !== flag) };
}

export function parseCli(argv: string[]): CliOptions | "help" | "version" {
  const separator = argv.indexOf("--");
  const toolFenceArgs = separator === -1 ? argv : argv.slice(0, separator);
  if (toolFenceArgs.includes("--help") || toolFenceArgs.includes("-h")) return "help";
  if (toolFenceArgs.includes("--version") || toolFenceArgs.includes("-v")) return "version";

  const command = argv[0];
  if (command === "broker" || command === "status") {
    if (argv.length !== 1) throw new Error(`${command} does not accept arguments`);
    return { command };
  }
  if (command === "doctor") {
    const jsonFlag = takeBooleanFlag(toolFenceArgs.slice(1), "--json");
    const options = optionMap(jsonFlag.args);
    for (const flag of options.keys()) {
      if (flag !== "--policy" && flag !== "--workspace") throw new Error(`Unknown option for doctor: ${flag}`);
    }
    if (separator === argv.length - 1) throw new Error("Expected an upstream command after '--'");
    const upstream = separator === -1 ? [] : argv.slice(separator + 1);
    return {
      command: "doctor",
      json: jsonFlag.present,
      policy: options.has("--policy") ? resolve(options.get("--policy")!) : undefined,
      workspace: canonicalizePath(options.get("--workspace") ?? process.cwd(), process.cwd()),
      upstreamCommand: upstream[0],
      args: upstream.slice(1),
    };
  }
  if (command === "approvals") {
    const jsonFlag = takeBooleanFlag(argv.slice(1), "--json");
    const options = optionMap(jsonFlag.args);
    for (const flag of options.keys()) {
      if (flag !== "--id" && flag !== "--decision") throw new Error(`Unknown option for approvals: ${flag}`);
    }
    const approvalId = options.get("--id");
    const rawDecision = options.get("--decision");
    if ((approvalId === undefined) !== (rawDecision === undefined)) {
      throw new Error("--id and --decision must be used together");
    }
    if (
      rawDecision !== undefined &&
      rawDecision !== "allow-once" &&
      rawDecision !== "allow-session" &&
      rawDecision !== "deny"
    ) {
      throw new Error("--decision must be allow-once, allow-session, or deny");
    }
    if (jsonFlag.present && approvalId) throw new Error("--json cannot be combined with --id");
    return {
      command: "approvals",
      json: jsonFlag.present,
      approvalId,
      decision: rawDecision as BrokerDecision | undefined,
    };
  }
  if (command === "audit") {
    const subcommand = argv[1];
    if (subcommand !== "summary" && subcommand !== "tail") {
      throw new Error("Expected audit subcommand: summary or tail");
    }
    const jsonFlag = takeBooleanFlag(argv.slice(2), "--json");
    const options = optionMap(jsonFlag.args);
    const allowed = subcommand === "tail" ? new Set(["--audit", "--lines"]) : new Set(["--audit"]);
    for (const flag of options.keys()) {
      if (!allowed.has(flag)) throw new Error(`Unknown option for audit ${subcommand}: ${flag}`);
    }
    const audit = resolve(options.get("--audit") ?? resolve(process.cwd(), ".toolfence/audit.jsonl"));
    if (subcommand === "summary") return { command: "audit-summary", audit, json: jsonFlag.present };
    const rawLines = options.get("--lines") ?? "20";
    const lines = Number(rawLines);
    if (!Number.isSafeInteger(lines) || lines < 1 || lines > 10_000) {
      throw new Error("--lines must be between 1 and 10000");
    }
    return { command: "audit-tail", audit, json: jsonFlag.present, lines };
  }
  if (command === "policy") {
    const subcommand = argv[1];
    if (subcommand === "init") {
      const listFlag = takeBooleanFlag(argv.slice(2), "--list-recipes");
      const options = optionMap(listFlag.args);
      for (const flag of options.keys()) {
        if (flag !== "--policy" && flag !== "--recipe") {
          throw new Error(`Unknown option for policy init: ${flag}`);
        }
      }
      return {
        command: "policy-init",
        policy: resolve(options.get("--policy") ?? "toolfence.yaml"),
        recipe: options.get("--recipe"),
        listRecipes: listFlag.present,
      };
    }
    const allowedBySubcommand = new Map<string, Set<string>>([
      ["check", new Set(["--policy"])],
      ["explain", new Set(["--policy", "--action", "--workspace"])],
      ["test", new Set(["--policy", "--cases"])],
    ]);
    const allowed = subcommand ? allowedBySubcommand.get(subcommand) : undefined;
    if (!allowed) throw new Error("Expected policy subcommand: init, check, explain, or test");
    const options = optionMap(argv.slice(2));
    for (const flag of options.keys()) {
      if (!allowed.has(flag)) throw new Error(`Unknown option for policy ${subcommand}: ${flag}`);
    }
    const policy = options.get("--policy");
    if (!policy) throw new Error("--policy is required");
    if (subcommand === "check") return { command: "policy-check", policy: resolve(policy) };
    if (subcommand === "explain") {
      const action = options.get("--action");
      if (!action) throw new Error("--action is required");
      return {
        command: "policy-explain",
        policy: resolve(policy),
        action: resolve(action),
        workspace: canonicalizePath(options.get("--workspace") ?? process.cwd(), process.cwd()),
      };
    }
    if (subcommand === "test") {
      const cases = options.get("--cases");
      if (!cases) throw new Error("--cases is required");
      return { command: "policy-test", policy: resolve(policy), cases: resolve(cases) };
    }
    throw new Error("Unreachable policy subcommand");
  }
  if (command === "host" || (command === "init" && toolFenceArgs.includes("--host"))) {
    const isHostCommand = command === "host";
    const subcommand = isHostCommand ? argv[1] : "init";
    const subArgs = isHostCommand ? toolFenceArgs.slice(2) : toolFenceArgs.slice(1);
    if (subcommand !== "init" && subcommand !== "snippet") {
      throw new Error("Expected host subcommand: init or snippet");
    }
    const writeFlag = takeBooleanFlag(subArgs, "--write");
    const jsonFlag = takeBooleanFlag(writeFlag.args, "--json");
    const options = optionMap(jsonFlag.args);
    const allowed = new Set(["--host", "--policy", "--server", "--workspace", "--scope"]);
    for (const flag of options.keys()) {
      if (!allowed.has(flag)) throw new Error(`Unknown option for host ${subcommand}: ${flag}`);
    }
    const rawHost = options.get("--host");
    if (!rawHost) throw new Error("--host is required (e.g. cursor, claude, claude-desktop, claude-code, or codex)");
    const host = normalizeHost(rawHost);
    const scope = options.get("--scope");
    if (scope && scope !== "project" && scope !== "global") {
      throw new Error("--scope must be project or global");
    }
    const upstream = separator === -1 ? [] : argv.slice(separator + 1);
    const workspace = canonicalizePath(options.get("--workspace") ?? process.cwd(), process.cwd());

    return {
      command: "host-init",
      host,
      policy: options.get("--policy") ? resolve(options.get("--policy")!) : undefined,
      server: options.get("--server"),
      workspace,
      scope: scope as "project" | "global" | undefined,
      write: subcommand === "init" && writeFlag.present,
      json: jsonFlag.present,
      upstreamCommand: upstream[0],
      args: upstream.slice(1),
    };
  }
  if (command !== "wrap") throw new Error("Expected wrap, broker, status, doctor, approvals, audit, policy, or host");
  if (separator === -1 || separator === argv.length - 1) {
    throw new Error("Expected an upstream command after '--'");
  }

  const options = optionMap(argv.slice(1, separator));
  const allowed = new Set(["--policy", "--server", "--workspace", "--audit", "--approval"]);
  for (const flag of options.keys()) if (!allowed.has(flag)) throw new Error(`Unknown option: ${flag}`);
  const policy = options.get("--policy");
  if (!policy) throw new Error("--policy is required");
  const workspace = canonicalizePath(options.get("--workspace") ?? process.cwd(), process.cwd());
  const approval = options.get("--approval") ?? "broker";
  if (approval !== "broker" && approval !== "tty") throw new Error("--approval must be broker or tty");
  const upstream = argv.slice(separator + 1);
  return {
    command: "wrap",
    policy: resolve(policy),
    server: options.get("--server"),
    workspace,
    audit: resolve(options.get("--audit") ?? resolve(workspace, ".toolfence/audit.jsonl")),
    approval,
    upstreamCommand: upstream[0],
    args: upstream.slice(1),
  };
}

async function runBroker(): Promise<void> {
  const broker = await startBroker();
  process.stderr.write(`ToolFence Broker listening at ${broker.paths.socketPath}\n`);
  await new Promise<void>((resolveDone) => {
    const close = () => void broker.close().finally(resolveDone);
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}

export async function runApprovals(options: ApprovalOptions, paths?: BrokerPaths): Promise<void> {
  const { socket, requests } = await listApprovals(paths);
  try {
    if (options.json) {
      process.stdout.write(`${JSON.stringify(requests)}\n`);
      return;
    }
    if (options.approvalId && options.decision) {
      if (!requests.some((request) => request.approvalId === options.approvalId)) {
        throw new Error(`Approval not found: ${options.approvalId}`);
      }
      resolveApproval(socket, options.approvalId, options.decision);
      process.stdout.write(`Resolved ${options.approvalId} as ${options.decision}.\n`);
      return;
    }
    if (requests.length === 0) {
      process.stdout.write("No pending approvals.\n");
      return;
    }
    const terminal = createInterface({ input, output });
    try {
      for (const request of requests) {
        const details = request.action.resources.length
          ? request.action.resources.join(", ")
          : request.action.command ?? request.action.network?.url ?? "no recognized resource";
        const answer = await terminal.question(
          `[${request.approvalId}] ${request.action.operation} via ${request.action.server}/${request.action.tool}\n  ${details}\nAllow once [y], session [s], or deny [N]? `,
        );
        const decision: BrokerDecision =
          answer.trim().toLowerCase() === "y"
            ? "allow-once"
            : answer.trim().toLowerCase() === "s"
              ? "allow-session"
              : "deny";
        resolveApproval(socket, request.approvalId, decision);
      }
    } finally {
      terminal.close();
    }
  } finally {
    socket.end();
  }
}

function formatAuditSummary(summary: AuditSummary): string {
  const operations = Object.entries(summary.operations)
    .map(([operation, count]) => `  ${operation}: ${count}`)
    .join("\n");
  return [
    `Events: ${summary.events}`,
    `Decisions: ${summary.decisions.total} (allow ${summary.decisions.allow}, ask ${summary.decisions.ask}, deny ${summary.decisions.deny})`,
    `Results: ${summary.results.total} (errors ${summary.results.errors})`,
    "Operations:",
    operations || "  none",
  ].join("\n");
}

async function runWrap(options: WrapOptions): Promise<void> {
  const policy = loadPolicy(options.policy);
  const engine = new PolicyEngine(policy, {
    workspace: options.workspace,
    home: canonicalizePath(homedir(), homedir()),
  });
  const audit = new AuditLogger(options.audit);
  const approval = options.approval === "tty"
    ? new TtyApprovalRequester()
    : new BrokerApprovalRequester();
  const controller = startProxy({
    command: options.upstreamCommand,
    args: options.args,
    cwd: options.workspace,
    server: options.server ?? basename(options.upstreamCommand),
    policy: engine,
    approval,
    audit,
    input: process.stdin,
    output: process.stdout,
    errorOutput: process.stderr,
  });
  const forwardSignal = (signal: NodeJS.Signals) => controller.child.kill(signal);
  process.once("SIGINT", () => forwardSignal("SIGINT"));
  process.once("SIGTERM", () => forwardSignal("SIGTERM"));
  const exitCode = await controller.closed;
  process.exitCode = exitCode ?? 1;
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  let options: CliOptions | "help" | "version";
  try {
    options = parseCli(argv);
    if (options === "help") {
      process.stdout.write(usage());
      return;
    }
    if (options === "version") {
      process.stdout.write(`${version}\n`);
      return;
    }
    if (options.command === "broker") return await runBroker();
    if (options.command === "status") {
      const status = await brokerStatus();
      process.stdout.write(`Broker ready: protocol ${status.protocolVersion}, socket mode ${status.socketMode.toString(8)}\n`);
      return;
    }
    if (options.command === "doctor") {
      const report = await diagnose(options);
      process.stdout.write(options.json ? `${JSON.stringify(report)}\n` : `${formatDoctorReport(report)}\n`);
      if (!report.ok) process.exitCode = 1;
      return;
    }
    if (options.command === "approvals") return await runApprovals(options);
    if (options.command === "audit-summary") {
      const summary = summarizeAudit(readAudit(options.audit));
      process.stdout.write(options.json ? `${JSON.stringify(summary)}\n` : `${formatAuditSummary(summary)}\n`);
      return;
    }
    if (options.command === "audit-tail") {
      const records = tailAudit(readAudit(options.audit), options.lines);
      process.stdout.write(options.json
        ? `${JSON.stringify(records)}\n`
        : records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""));
      return;
    }
    if (options.command === "policy-init") {
      if (options.listRecipes) {
        const recipes = listRecipes();
        const formatted = recipes
          .map((r) => `  ${r.name.padEnd(12)} ${r.description} (default server: ${r.defaultServer})`)
          .join("\n");
        process.stdout.write(`Available ToolFence Policy Recipes:\n${formatted}\n\nUse with: toolfence policy init --recipe <name>\n`);
        return;
      }
      process.stdout.write(`Created policy: ${initPolicy(options.policy, options.recipe)}\n`);
      return;
    }
    if (options.command === "policy-check") {
      process.stdout.write(`${checkPolicy(options.policy)}\n`);
      return;
    }
    if (options.command === "policy-explain") {
      process.stdout.write(`${explainPolicy(options.policy, options.action, options.workspace)}\n`);
      return;
    }
    if (options.command === "policy-test") {
      const result = testPolicy(options.policy, options.cases);
      process.stdout.write(`${result.output}\n`);
      if (result.failed) process.exitCode = 1;
      return;
    }
    if (options.command === "host-init") {
      if (options.write) {
        const result = injectHostConfig(options);
        if (options.json) {
          process.stdout.write(`${JSON.stringify(result)}\n`);
        } else {
          process.stdout.write(
            `${result.created ? "Created" : "Updated"} ${result.host} config: ${result.configPath}${result.backupPath ? ` (backup: ${result.backupPath})` : ""}\n\n${result.content}`,
          );
        }
        return;
      }
      const result = generateHostSnippet(options);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else {
        process.stdout.write(
          `Target configuration: ${result.configPath}\nTo write this configuration directly, pass --write.\n\n${result.rendered}\n`,
        );
      }
      return;
    }
    await runWrap(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ToolFence: ${message}. Check 'toolfence --help' and the referenced files.\n`);
    process.exitCode = 1;
  }
}

export function isMainModule(argvPath: string | undefined, moduleUrl = import.meta.url): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return moduleUrl === pathToFileURL(resolve(argvPath)).href;
  }
}

if (isMainModule(process.argv[1])) {
  await runCli();
}
