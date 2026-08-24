import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "echo", version: "1.0.0" }
      }
    })}\n`);
  } else if (request.method === "tools/list") {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: { tools: [{ name: "read_file", inputSchema: { type: "object" } }] }
    })}\n`);
  } else if (request.method === "tools/call") {
    const errorMessage = request.params.arguments?.errorMessage;
    const response = typeof errorMessage === "string"
      ? { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: errorMessage } }
      : {
          jsonrpc: "2.0",
          id: request.id,
          result: { content: [{ type: "text", text: JSON.stringify(request.params.arguments) }] }
        };
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
});
