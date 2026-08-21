import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(repositoryRoot, "dist/cli.js");
const filesystemServerPath = resolve(
  repositoryRoot,
  "node_modules/@modelcontextprotocol/server-filesystem/dist/index.js",
);
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

function executeCli(args, env) {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      { cwd: repositoryRoot, env, encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          rejectCommand(new Error(`${error.message}\n${stderr}`.trim()));
          return;
        }
        resolveCommand({ stdout, stderr });
      },
    );
  });
}

function waitForText(stream, expected, child, timeoutMs = 8_000) {
  return new Promise((resolveText, rejectText) => {
    let captured = "";
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${expected}`)), timeoutMs);
    const onData = (chunk) => {
      captured += chunk.toString();
      if (captured.includes(expected)) finish();
    };
    const onExit = (code) => finish(new Error(`Process exited with code ${code}: ${captured.trim()}`));
    const finish = (error) => {
      clearTimeout(timer);
      stream.off("data", onData);
      child.off("exit", onExit);
      error ? rejectText(error) : resolveText(captured);
    };
    stream.on("data", onData);
    child.once("exit", onExit);
  });
}

class JsonLineRpc {
  constructor(child, diagnostics = () => "") {
    this.child = child;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.consume(chunk));
    child.once("exit", (code) => {
      for (const { rejectResponse, timer } of this.pending.values()) {
        clearTimeout(timer);
        rejectResponse(new Error(
          `Wrapped MCP server exited with code ${code}: ${diagnostics().trim()}`,
        ));
      }
      this.pending.clear();
    });
  }

  consume(chunk) {
    this.buffer += chunk;
    while (this.buffer.includes("\n")) {
      const newline = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const pending = this.pending.get(String(message.id));
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(String(message.id));
      pending.resolveResponse(message);
    }
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  request(method, params, timeoutMs = 8_000) {
    const id = this.nextId++;
    const response = new Promise((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        rejectResponse(new Error(`Timed out waiting for MCP response ${id} (${method})`));
      }, timeoutMs);
      this.pending.set(String(id), { resolveResponse, rejectResponse, timer });
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    delay(2_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function toolText(response) {
  return response.result?.content
    ?.filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n") ?? "";
}

async function waitForApproval(env) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const { stdout } = await executeCli(["approvals", "--json"], env);
    const request = JSON.parse(stdout).find(({ action }) => action.tool === "write_file");
    if (request) return request;
    await delay(50);
  }
  throw new Error("The real Broker did not expose the pending write approval");
}

export async function runDemo({ onEvent = () => {}, pauseMs = 0 } = {}) {
  const emit = async (event) => {
    await onEvent(event);
    if (pauseMs > 0) await delay(pauseMs);
  };
  assert.ok(existsSync(cliPath), "dist/cli.js is missing; run npm run build first");
  assert.ok(existsSync(filesystemServerPath), "Install @modelcontextprotocol/server-filesystem first");

  const tempBase = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  const demoRoot = mkdtempSync(join(tempBase, "toolfence-e2e-demo-"));
  const workspace = join(demoRoot, "workspace");
  const home = join(demoRoot, "home");
  const runtime = join(demoRoot, "runtime");
  const auditPath = join(demoRoot, "audit.jsonl");
  const policyPath = join(demoRoot, "policy.yaml");
  const approvedPath = join(workspace, "approved.txt");
  const secret = "DEMO_SECRET_MUST_NOT_LEAK";
  const env = { ...process.env, HOME: home, XDG_RUNTIME_DIR: runtime };
  let broker;
  let wrapper;

  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  chmodSync(runtime, 0o700);
  writeFileSync(join(workspace, "safe.txt"), "hello from the real filesystem server\n");
  writeFileSync(join(workspace, ".env"), `${secret}=true\n`);
  writeFileSync(policyPath, [
    "version: 1",
    "default: ask",
    "rules:",
    "  - id: deny-dotenv",
    "    effect: deny",
    "    operations: [fs.read, fs.write, fs.delete]",
    "    resources: [\"**/.env\", \"**/.env.*\"]",
    "  - id: allow-workspace-read",
    "    effect: allow",
    "    operations: [fs.read]",
    "    resources: [\"${workspace}/**\"]",
    "",
  ].join("\n"));

  try {
    broker = spawn(process.execPath, [cliPath, "broker"], {
      cwd: repositoryRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForText(broker.stderr, "ToolFence Broker listening", broker);
    const status = await executeCli(["status"], env);
    assert.match(status.stdout, /Broker ready/);
    await emit({ effect: "info", label: "BROKER", detail: "READY ON LOCAL AUTHENTICATED SOCKET" });

    wrapper = spawn(process.execPath, [
      cliPath,
      "wrap",
      "--policy", policyPath,
      "--server", "filesystem",
      "--workspace", workspace,
      "--audit", auditPath,
      "--",
      process.execPath,
      filesystemServerPath,
      workspace,
    ], {
      cwd: repositoryRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let wrapperErrors = "";
    wrapper.stderr.setEncoding("utf8");
    wrapper.stderr.on("data", (chunk) => { wrapperErrors += chunk; });
    const rpc = new JsonLineRpc(wrapper, () => wrapperErrors);

    const initialized = await rpc.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "toolfence-e2e-demo", version: "1.0.0" },
    });
    assert.equal(initialized.error, undefined, wrapperErrors);
    rpc.notify("notifications/initialized", {});
    const tools = await rpc.request("tools/list", {});
    assert.ok(tools.result?.tools?.some(({ name }) => name === "read_text_file"));
    assert.ok(tools.result?.tools?.some(({ name }) => name === "write_file"));
    await emit({
      effect: "info",
      label: "PROXY",
      detail: "OFFICIAL FILESYSTEM MCP INITIALIZED",
    });

    const allowed = await rpc.request("tools/call", {
      name: "read_text_file",
      arguments: { path: join(workspace, "safe.txt") },
    });
    assert.equal(allowed.result?.isError, undefined, toolText(allowed));
    assert.match(toolText(allowed), /hello from the real filesystem server/);
    await emit({ effect: "allow", label: "READ SAFE.TXT", detail: "UPSTREAM RETURNED CONTENT" });

    const denied = await rpc.request("tools/call", {
      name: "read_text_file",
      arguments: { path: join(workspace, ".env") },
    });
    assert.equal(denied.result?.isError, true);
    assert.match(toolText(denied), /ToolFence denied/);
    assert.ok(!JSON.stringify(denied).includes(secret), "Denied response leaked upstream file contents");
    await emit({ effect: "deny", label: "READ .ENV", detail: "BLOCKED BEFORE UPSTREAM" });

    const pendingWrite = rpc.request("tools/call", {
      name: "write_file",
      arguments: { path: approvedPath, content: "approved through the real broker\n" },
    }, 12_000);
    const approval = await waitForApproval(env);
    assert.equal(approval.action.operation, "fs.write");
    await emit({ effect: "ask", label: "WRITE APPROVED.TXT", detail: "BROKER QUEUED REQUEST" });
    await executeCli(["approvals", "--id", approval.approvalId, "--decision", "allow-once"], env);
    const written = await pendingWrite;
    assert.notEqual(written.result?.isError, true, toolText(written));
    assert.equal(readFileSync(approvedPath, "utf8"), "approved through the real broker\n");
    await emit({ effect: "allow", label: "ALLOW-ONCE", detail: "UPSTREAM CREATED FILE" });

    const audit = await executeCli(["audit", "summary", "--audit", auditPath, "--json"], env);
    const auditSummary = JSON.parse(audit.stdout);
    const auditJson = JSON.stringify(auditSummary);
    assert.match(auditJson, /allow/);
    assert.match(auditJson, /deny/);
    await emit({ effect: "info", label: "AUDIT", detail: "ALLOW AND DENY EVENTS VERIFIED" });

    const filesystemVersion = JSON.parse(readFileSync(
      resolve(repositoryRoot, "node_modules/@modelcontextprotocol/server-filesystem/package.json"),
      "utf8",
    )).version;
    return {
      filesystemVersion,
      auditSummary,
      events: [
        { effect: "allow", label: "READ SAFE.TXT", detail: "REAL UPSTREAM RETURNED CONTENT" },
        { effect: "deny", label: "READ .ENV", detail: "BLOCKED BEFORE UPSTREAM" },
        { effect: "ask", label: "WRITE APPROVED.TXT", detail: "REAL BROKER QUEUED REQUEST" },
        { effect: "allow", label: "ALLOW-ONCE", detail: "REAL UPSTREAM CREATED FILE" },
      ],
      summary: "BROKER | PROXY | FILESYSTEM MCP | PASS",
    };
  } finally {
    if (wrapper?.stdin.writable) wrapper.stdin.end();
    await stopChild(wrapper);
    await stopChild(broker);
    rmSync(demoRoot, { recursive: true, force: true });
  }
}

function formatDemo(recording) {
  const colors = process.stdout.isTTY && process.env.NO_COLOR === undefined;
  const paint = (code, value) => colors ? `\u001b[${code}m${value}\u001b[0m` : value;
  const effect = {
    allow: paint(32, "ALLOW"),
    deny: paint(31, "DENY "),
    ask: paint(33, "ASK  "),
  };
  return `${[
    paint(1, "ToolFence end-to-end demo"),
    `Upstream: @modelcontextprotocol/server-filesystem ${recording.filesystemVersion}`,
    "",
    ...recording.events.map((event) => `${effect[event.effect]}  ${event.label.padEnd(22)} ${event.detail}`),
    "",
    recording.summary,
  ].join("\n")}\n`;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  runDemo().then((recording) => process.stdout.write(formatDemo(recording))).catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
