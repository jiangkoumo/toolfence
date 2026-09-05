import { isAbsolute, join } from "node:path";
import { canonicalizePath } from "./paths.js";
import { ACTION_MODEL_VERSION, type NormalizedAction, type Operation } from "./types.js";

const filesystemOperations: Record<string, Operation> = {
  read_file: "fs.read",
  read_text_file: "fs.read",
  read_media_file: "fs.read",
  read_multiple_files: "fs.read",
  list_directory: "fs.read",
  list_directory_with_sizes: "fs.read",
  directory_tree: "fs.read",
  search_files: "fs.read",
  get_file_info: "fs.read",
  list_allowed_directories: "fs.read",
  write_file: "fs.write",
  edit_file: "fs.write",
  create_directory: "fs.write",
  move_file: "fs.write",
  delete_file: "fs.delete",
  remove_file: "fs.delete",
  remove_directory: "fs.delete",
};

const agentTapeServers = new Set(["agenttape", "agenttape-fenced", "agenttape_fenced"]);
const agentTapeReadTools = new Set(["list_tapes", "inspect_tape", "fork_run"]);
const agentTapeFilename = /^[A-Za-z0-9._-]+\.tape$/;

const shellTools = new Set([
  "execute_command",
  "run_command",
  "run_shell_command",
  "shell",
  "exec",
  "execute",
]);

const gitTools = new Set(["git", "git_command", "execute_git", "run_git"]);
const httpTools = new Set([
  "fetch",
  "http_request",
  "request",
  "get_url",
  "download",
]);

const gitReadCommands = new Set(["status", "diff", "log", "show", "branch"]);
const gitWriteCommands = new Set([
  "add",
  "commit",
  "checkout",
  "switch",
  "merge",
  "rebase",
  "reset",
  "restore",
  "clean",
  "tag",
]);
const gitRemoteCommands = new Set(["fetch", "pull", "push", "clone"]);

const resourceKeys = new Set([
  "path",
  "paths",
  "file",
  "file_path",
  "directory",
  "root",
  "source",
  "destination",
  "target",
]);

function baseToolName(tool: string): string {
  return tool.toLowerCase().split(/[/:.]/).at(-1) ?? tool.toLowerCase();
}

function objectArguments(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function agentTapeWorkspaceRoot(args: Record<string, unknown>, workspace: string): string | undefined {
  const requestedRoot = args.workspaceRoot;
  if (requestedRoot === undefined) return workspace;
  return typeof requestedRoot === "string" && isAbsolute(requestedRoot)
    ? requestedRoot
    : undefined;
}

function normalizeAgentTape(
  server: string,
  tool: string,
  name: string,
  rawArguments: unknown,
  workspace: string,
): NormalizedAction | undefined {
  const args = objectArguments(rawArguments);
  const workspaceRoot = agentTapeWorkspaceRoot(args, workspace);
  const argumentsAreObject = rawArguments !== null && typeof rawArguments === "object" &&
    !Array.isArray(rawArguments);

  if (agentTapeReadTools.has(name)) {
    return {
      actionModelVersion: ACTION_MODEL_VERSION,
      operation: "fs.read",
      normalization: argumentsAreObject && workspaceRoot ? "known" : "ambiguous",
      resources: workspaceRoot
        ? [canonicalizePath(join(workspaceRoot, ".agent-tape", "tapes"), workspace)]
        : [],
      server,
      tool,
      rawArguments,
    };
  }

  if (name !== "save_regression") return undefined;
  const filename = args.filename;
  const target = workspaceRoot && typeof filename === "string" && agentTapeFilename.test(filename)
    ? canonicalizePath(join(workspaceRoot, "tests", "agenttape", filename), workspace)
    : undefined;
  return {
    actionModelVersion: ACTION_MODEL_VERSION,
    operation: "fs.write",
    normalization: argumentsAreObject && target ? "known" : "ambiguous",
    resources: target ? [target] : [],
    server,
    tool,
    rawArguments,
  };
}

function collectResourceValues(args: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (!resourceKeys.has(key)) continue;
    if (typeof value === "string") values.push(value);
    if (Array.isArray(value)) {
      values.push(...value.filter((item): item is string => typeof item === "string"));
    }
  }
  return [...new Set(values)];
}

function filesystemArgumentsAreKnown(
  name: string,
  args: Record<string, unknown>,
  resources: string[],
): boolean {
  const resourceValues = Object.entries(args)
    .filter(([key]) => resourceKeys.has(key))
    .map(([, value]) => value);
  const wellFormed = resourceValues.every((value) =>
    (typeof value === "string" && value.length > 0) ||
    (Array.isArray(value) && value.length > 0 &&
      value.every((item) => typeof item === "string" && item.length > 0)),
  );
  if (!wellFormed) return false;
  if (name === "list_allowed_directories") return true;
  if (name === "move_file") return resources.length >= 2;
  return resources.length > 0;
}

function parseSimpleCommand(command: string): string[] | undefined {
  const trimmed = command.trim();
  if (!trimmed || /[;&|`$<>\\\n\r'\"]/.test(trimmed)) return undefined;
  const parts = trimmed.split(/\s+/);
  return parts.every((part) => /^[\w@%+=:,./-]+$/u.test(part)) ? parts : undefined;
}

function normalizeShell(
  server: string,
  tool: string,
  rawArguments: unknown,
): NormalizedAction {
  const args = objectArguments(rawArguments);
  const rawCommand = args.command ?? args.cmd;
  let argv: string[] | undefined;
  let command: string | undefined;

  if (Array.isArray(rawCommand) && rawCommand.every((item) => typeof item === "string")) {
    argv = rawCommand as string[];
    command = argv.join(" ");
  } else if (typeof rawCommand === "string") {
    command = rawCommand;
    argv = parseSimpleCommand(rawCommand);
  } else if (typeof args.executable === "string") {
    const extraArgs = Array.isArray(args.args)
      ? args.args.filter((item): item is string => typeof item === "string")
      : [];
    argv = [args.executable, ...extraArgs];
    command = argv.join(" ");
  }

  const gitOperation = argv?.[0] === "git" ? classifyGit(argv.slice(1)) : undefined;
  const argsAreKnown = args.args === undefined ||
    (Array.isArray(args.args) && args.args.every((item) => typeof item === "string"));
  const normalization = argv && argv.length > 0 && argv[0].length > 0 && argsAreKnown &&
    (argv[0] !== "git" || gitOperation !== undefined)
    ? "known"
    : "ambiguous";
  return {
    actionModelVersion: ACTION_MODEL_VERSION,
    operation: gitOperation ?? "shell.exec",
    normalization,
    resources: [],
    server,
    tool,
    rawArguments,
    command,
    executable: argv?.[0],
    argv,
  };
}

function classifyGit(args: string[]): Operation | undefined {
  const subcommandIndex = args.findIndex((arg) => !arg.startsWith("-"));
  const subcommand = args[subcommandIndex];
  if (!subcommand) return undefined;
  if (gitRemoteCommands.has(subcommand)) return "git.remote";
  if (subcommand === "remote") {
    const remoteMutation = args.slice(subcommandIndex + 1).find((arg) => !arg.startsWith("-"));
    return remoteMutation ? "git.remote" : "git.read";
  }
  if (gitWriteCommands.has(subcommand)) return "git.write";
  if (gitReadCommands.has(subcommand)) {
    if (subcommand === "branch") {
      const branchArgs = args.slice(subcommandIndex + 1);
      const mutationFlag = branchArgs.some((arg) =>
        ["-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "--copy",
          "--edit-description", "--unset-upstream"].includes(arg) ||
        arg.startsWith("--set-upstream-to"),
      );
      const positional = branchArgs.some((arg) => !arg.startsWith("-"));
      if (mutationFlag || positional) return "git.write";
    }
    return "git.read";
  }
  return undefined;
}

function normalizeGit(server: string, tool: string, rawArguments: unknown): NormalizedAction {
  const args = objectArguments(rawArguments);
  const raw = args.args ?? args.arguments ?? args.command;
  let argv: string[] | undefined;
  if (Array.isArray(raw) && raw.every((item) => typeof item === "string")) {
    argv = raw[0] === "git" ? raw as string[] : ["git", ...(raw as string[])];
  } else if (typeof raw === "string") {
    const parsed = parseSimpleCommand(raw);
    if (parsed) argv = parsed[0] === "git" ? parsed : ["git", ...parsed];
  }
  const operation = argv ? classifyGit(argv.slice(1)) : undefined;
  return {
    actionModelVersion: ACTION_MODEL_VERSION,
    operation: operation ?? "unknown",
    normalization: operation ? "known" : "unknown",
    resources: [],
    server,
    tool,
    rawArguments,
    command: argv?.join(" "),
    executable: argv?.[0],
    argv,
  };
}

function normalizeHttp(server: string, tool: string, rawArguments: unknown): NormalizedAction {
  const args = objectArguments(rawArguments);
  // HTTP MCP adapters that expose a redirect target must provide it here so the
  // destination is evaluated as a new action instead of inheriting the origin.
  const rawUrl = args.redirectUrl ?? args.redirect_url ?? args.url ?? args.uri ?? args.endpoint;
  if (typeof rawUrl !== "string") {
    return {
      actionModelVersion: ACTION_MODEL_VERSION,
      operation: "unknown",
      normalization: "unknown",
      resources: [],
      server,
      tool,
      rawArguments,
    };
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scheme");
    const method = typeof args.method === "string" ? args.method.toUpperCase() : "GET";
    return {
      actionModelVersion: ACTION_MODEL_VERSION,
      operation: "net.request",
      normalization: args.method === undefined || typeof args.method === "string"
        ? "known"
        : "ambiguous",
      resources: [],
      server,
      tool,
      rawArguments,
      network: {
        url: parsed.toString(),
        host: parsed.hostname.toLowerCase(),
        method,
        scheme: parsed.protocol.slice(0, -1),
      },
    };
  } catch {
    return {
      actionModelVersion: ACTION_MODEL_VERSION,
      operation: "unknown",
      normalization: "unknown",
      resources: [],
      server,
      tool,
      rawArguments,
    };
  }
}

export function normalizeToolCall(
  server: string,
  tool: string,
  rawArguments: unknown,
  workspace: string,
): NormalizedAction {
  const name = baseToolName(tool);
  if (agentTapeServers.has(server.toLowerCase())) {
    const agentTapeAction = normalizeAgentTape(server, tool, name, rawArguments, workspace);
    if (agentTapeAction) return agentTapeAction;
  }

  if (name in filesystemOperations) {
    const args = objectArguments(rawArguments);
    const resources = collectResourceValues(args).map((value) =>
      canonicalizePath(value, workspace),
    );
    return {
      actionModelVersion: ACTION_MODEL_VERSION,
      operation: filesystemOperations[name],
      normalization: filesystemArgumentsAreKnown(name, args, resources) ? "known" : "ambiguous",
      resources,
      server,
      tool,
      rawArguments,
    };
  }

  if (shellTools.has(name)) {
    return normalizeShell(server, tool, rawArguments);
  }

  if (gitTools.has(name)) return normalizeGit(server, tool, rawArguments);
  if (httpTools.has(name)) return normalizeHttp(server, tool, rawArguments);

  return {
    actionModelVersion: ACTION_MODEL_VERSION,
    operation: "unknown",
    normalization: "unknown",
    resources: [],
    server,
    tool,
    rawArguments,
  };
}
