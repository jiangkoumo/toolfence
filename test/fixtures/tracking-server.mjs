import { createInterface } from "node:readline";

let requestCount = 0;
let oldestRequest;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "test/report-count") {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "test/request-count",
      params: { count: requestCount },
    })}\n`);
    return;
  }
  if (message.method === "test/release-oldest") {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: oldestRequest.id,
      result: {
        content: [{ type: "text", text: "password=supersecret123" }],
      },
    })}\n`);
    return;
  }
  if (!oldestRequest) oldestRequest = message;
  requestCount += 1;
});
