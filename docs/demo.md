# Reproduce the ToolFence demos

## `.env` leak comparison

The README hero animation compares the same real MCP tool call with and without ToolFence. The demo creates an isolated workspace containing the explicitly synthetic value `OPENAI_API_KEY=TF_DEMO_ONLY`, then:

1. starts the official `@modelcontextprotocol/server-filesystem` directly;
2. verifies that `read_text_file` returns the synthetic `.env` value;
3. starts the same server behind the real ToolFence proxy;
4. repeats the same tool call and verifies that `protect-secrets` denies it before upstream execution;
5. verifies that neither the denied response nor the privacy-conscious audit log contains the synthetic secret.

Run the textual comparison:

```bash
npm run demo:env
```

Regenerate the 30-second README animation:

```bash
npm run demo:env:render
```

Rendering requires FFmpeg, Python 3, and Pillow. The renderer uses SF Mono on macOS and DejaVu Sans Mono on Linux; set `TOOLFENCE_DEMO_FONT` and `TOOLFENCE_DEMO_BOLD_FONT` to override the font files.

The secret is deliberately fake, but both reads use real JSON-RPC processes and the official Filesystem MCP Server. The renderer only creates the GIF after all attack, denial, and audit assertions pass.

## Full approval workflow

The longer workflow demo is also produced from a fresh, real MCP run—not from hard-coded policy results. It creates an isolated temporary home and workspace, then:

1. starts the real ToolFence Broker;
2. starts the real ToolFence stdio proxy around the official `@modelcontextprotocol/server-filesystem`;
3. completes MCP initialization and tool discovery;
4. reads an allowed file through the upstream server;
5. blocks a `.env` read before it reaches the upstream server;
6. queues a write in the Broker and resolves it with the real `allow-once` CLI;
7. verifies the upstream server created the file and checks the JSON audit summary.

Run the textual recording:

```bash
npm run demo
```

Expected result:

```text
ALLOW  READ SAFE.TXT          REAL UPSTREAM RETURNED CONTENT
DENY   READ .ENV              BLOCKED BEFORE UPSTREAM
ASK    WRITE APPROVED.TXT     REAL BROKER QUEUED REQUEST
ALLOW  ALLOW-ONCE             REAL UPSTREAM CREATED FILE

BROKER | PROXY | FILESYSTEM MCP | PASS
```

Regenerate `docs/assets/demo.gif` from a newly executed run:

```bash
npm run demo:render
```

Rendering requires `ffmpeg`. The GIF is a programmatically rendered terminal recording rather than a screen capture, but every displayed outcome is gated by assertions against the real Broker, proxy, upstream server, filesystem side effect, and audit log. Temporary files and credentials are removed after the run.
