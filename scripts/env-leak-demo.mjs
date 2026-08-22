import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
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
        rejectResponse(new Error(`MCP server exited with code ${code}: ${diagnostics().trim()}`));
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
  if (child.stdin.writable) child.stdin.end();
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

async function initialize(child, diagnostics, clientName) {
  const rpc = new JsonLineRpc(child, diagnostics);
  const initialized = await rpc.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: clientName, version: "1.0.0" },
  });
  assert.equal(initialized.error, undefined, diagnostics());
  rpc.notify("notifications/initialized", {});
  const tools = await rpc.request("tools/list", {});
  assert.ok(tools.result?.tools?.some(({ name }) => name === "read_text_file"));
  return rpc;
}

function spawnWithDiagnostics(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { errors += chunk; });
  return { child, diagnostics: () => errors };
}

export async function runEnvLeakDemo() {
  assert.ok(existsSync(cliPath), "dist/cli.js is missing; run npm run build first");
  assert.ok(existsSync(filesystemServerPath), "Install @modelcontextprotocol/server-filesystem first");

  const tempBase = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  const demoRoot = mkdtempSync(join(tempBase, "toolfence-env-demo-"));
  const workspace = join(demoRoot, "workspace");
  const envPath = join(workspace, ".env");
  const policyPath = join(demoRoot, "policy.yaml");
  const auditPath = join(demoRoot, "audit.jsonl");
  const syntheticSecret = "OPENAI_API_KEY=TF_DEMO_ONLY";
  let unprotected;
  let protectedServer;

  mkdirSync(workspace, { recursive: true });
  writeFileSync(envPath, `${syntheticSecret}\n`);
  writeFileSync(policyPath, [
    "version: 1",
    "default: allow",
    "rules:",
    "  - id: protect-secrets",
    "    effect: deny",
    "    operations: [fs.read, fs.write, fs.delete]",
    "    resources: [\"**/.env\", \"**/.env.*\"]",
    "",
  ].join("\n"));

  try {
    unprotected = spawnWithDiagnostics(process.execPath, [filesystemServerPath, workspace], {
      cwd: repositoryRoot,
      env: process.env,
    });
    const directRpc = await initialize(
      unprotected.child,
      unprotected.diagnostics,
      "toolfence-unprotected-env-demo",
    );
    const leaked = await directRpc.request("tools/call", {
      name: "read_text_file",
      arguments: { path: envPath },
    });
    assert.equal(leaked.result?.isError, undefined, toolText(leaked));
    assert.match(toolText(leaked), /OPENAI_API_KEY=TF_DEMO_ONLY/);
    await stopChild(unprotected.child);
    unprotected = undefined;

    protectedServer = spawnWithDiagnostics(process.execPath, [
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
      env: process.env,
    });
    const protectedRpc = await initialize(
      protectedServer.child,
      protectedServer.diagnostics,
      "toolfence-protected-env-demo",
    );
    const denied = await protectedRpc.request("tools/call", {
      name: "read_text_file",
      arguments: { path: envPath },
    });
    assert.equal(denied.result?.isError, true);
    assert.match(toolText(denied), /ToolFence denied/);
    assert.ok(!JSON.stringify(denied).includes(syntheticSecret));

    const audit = readFileSync(auditPath, "utf8");
    assert.match(audit, /protect-secrets/);
    assert.match(audit, /"effect":"deny"/);
    assert.ok(!audit.includes(syntheticSecret), "Audit log stored the synthetic secret");

    const filesystemVersion = JSON.parse(readFileSync(
      resolve(repositoryRoot, "node_modules/@modelcontextprotocol/server-filesystem/package.json"),
      "utf8",
    )).version;
    return {
      filesystemVersion,
      syntheticSecret,
      attack: {
        call: "READ_TEXT_FILE .ENV",
        result: syntheticSecret,
        outcome: "SECRET LEAKED",
      },
      defense: {
        call: "READ_TEXT_FILE .ENV",
        rule: "PROTECT-SECRETS",
        outcome: "BLOCKED BEFORE UPSTREAM",
        audit: "FS.READ .ENV DENY",
      },
      summary: "SAME MCP CALL. DIFFERENT OUTCOME.",
    };
  } finally {
    await stopChild(unprotected?.child);
    await stopChild(protectedServer?.child);
    rmSync(demoRoot, { recursive: true, force: true });
  }
}

function formatEnvLeakDemo(recording) {
  return `${[
    "ToolFence .env leak comparison",
    `Upstream: @modelcontextprotocol/server-filesystem ${recording.filesystemVersion}`,
    "",
    `WITHOUT TOOLFENCE  ${recording.attack.call}`,
    `RESULT             ${recording.attack.result}`,
    `OUTCOME            ${recording.attack.outcome}`,
    "",
    `WITH TOOLFENCE     ${recording.defense.call}`,
    `DENY               ${recording.defense.rule}`,
    `OUTCOME            ${recording.defense.outcome}`,
    `AUDIT              ${recording.defense.audit}`,
    "",
    recording.summary,
  ].join("\n")}\n`;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  runEnvLeakDemo()
    .then((recording) => process.stdout.write(formatEnvLeakDemo(recording)))
    .catch((error) => {
      process.stderr.write(`${error.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
