#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { readFileSync, realpathSync } from "node:fs";
import { stdin as input, stdout as output } from "node:process";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TtyApprovalRequester } from "./approval.js";
import { AuditLogger } from "./audit.js";
import {
  BrokerApprovalRequester,
  brokerStatus,
  defaultBrokerPaths,
  listApprovals,
  resolveApproval,
  startBroker,
  type BrokerDecision,
} from "./broker.js";
import { initPolicy, loadPolicy } from "./config.js";
import { canonicalizePath } from "./paths.js";
import { PolicyEngine } from "./policy.js";
import { checkPolicy, explainPolicy, testPolicy } from "./policy-tools.js";
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

export type CliOptions =
  | WrapOptions
  | { command: "broker" }
  | { command: "status" }
  | { command: "approvals" }
  | { command: "policy-init"; policy: string }
  | { command: "policy-check"; policy: string }
  | { command: "policy-explain"; policy: string; action: string; workspace: string }
  | { command: "policy-test"; policy: string; cases: string };

function usage(): string {
  return `ToolFence ${version}

Usage:
  toolfence wrap --policy <file> [options] -- <command> [args...]
  toolfence broker
  toolfence status
  toolfence approvals
  toolfence policy init [--policy <file>]
  toolfence policy check --policy <file>
  toolfence policy explain --policy <file> --action <file> [--workspace <path>]
  toolfence policy test --policy <file> --cases <file>

Wrap options:
  --policy <file>       YAML policy file (required)
  --server <name>       Server identity used by policy rules
  --workspace <path>    Working directory and relative-path root (default: cwd)
  --audit <file>        JSONL audit path (default: .toolfence/audit.jsonl)
  --approval <mode>     broker (default) or tty
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

export function parseCli(argv: string[]): CliOptions | "help" | "version" {
  const separator = argv.indexOf("--");
  const toolFenceArgs = separator === -1 ? argv : argv.slice(0, separator);
  if (toolFenceArgs.includes("--help") || toolFenceArgs.includes("-h")) return "help";
  if (toolFenceArgs.includes("--version") || toolFenceArgs.includes("-v")) return "version";

  const command = argv[0];
  if (command === "broker" || command === "status" || command === "approvals") {
    if (argv.length !== 1) throw new Error(`${command} does not accept arguments`);
    return { command };
  }
  if (command === "policy") {
    const subcommand = argv[1];
    const allowedBySubcommand = new Map<string, Set<string>>([
      ["init", new Set(["--policy"])],
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
    if (subcommand === "init") {
      return { command: "policy-init", policy: resolve(options.get("--policy") ?? "toolfence.yaml") };
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
  if (command !== "wrap") throw new Error("Expected wrap, broker, status, approvals, or policy");
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

async function runApprovals(): Promise<void> {
  const { socket, requests } = await listApprovals();
  if (requests.length === 0) {
    process.stdout.write("No pending approvals.\n");
    socket.end();
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
    socket.end();
  }
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
    if (options.command === "approvals") return await runApprovals();
    if (options.command === "policy-init") {
      process.stdout.write(`Created policy: ${initPolicy(options.policy)}\n`);
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
