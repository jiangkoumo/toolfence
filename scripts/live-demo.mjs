import { runDemo } from "./demo.mjs";

const color = {
  info: 36,
  allow: 32,
  deny: 31,
  ask: 33,
};
const paint = (code, value) => `\u001b[${code}m${value}\u001b[0m`;

process.stdout.write("\u001b[2J\u001b[H");
process.stdout.write(`${paint(1, "ToolFence real-machine MCP demo")}\n`);
process.stdout.write("Isolated workspace - no personal files\n\n");

try {
  const pauseMs = Number(process.env.TOOLFENCE_DEMO_PAUSE_MS ?? "1350");
  const recording = await runDemo({
    pauseMs,
    onEvent(event) {
      const label = event.effect === "info" ? event.label : event.effect.toUpperCase();
      process.stdout.write(
        `${paint(color[event.effect], label.padEnd(7))}  ${event.label.padEnd(22)} ${event.detail}\n`,
      );
    },
  });
  process.stdout.write(`\n${paint(32, "PASS")}     ${recording.summary}\n`);
  process.stdout.write("Real Broker + real proxy + official Filesystem MCP\n");
} catch (error) {
  process.stderr.write(`\n${paint(31, "FAIL")}     ${error.stack ?? error}\n`);
  process.exitCode = 1;
}
