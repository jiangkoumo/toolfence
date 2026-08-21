# Reproduce the ToolFence end-to-end demo

The README animation is produced from a fresh, real MCP run—not from hard-coded policy results. The demo creates an isolated temporary home and workspace, then:

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
