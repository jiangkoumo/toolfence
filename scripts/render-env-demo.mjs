import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runEnvLeakDemo } from "./env-leak-demo.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(repositoryRoot, "docs/assets/env-leak-demo.gif");
const rendererPath = resolve(repositoryRoot, "scripts/render-env-frames.py");
const frameDirectory = mkdtempSync(join(tmpdir(), "toolfence-env-demo-"));
const recordingPath = join(frameDirectory, "recording.json");
const recording = await runEnvLeakDemo();

try {
  writeFileSync(recordingPath, JSON.stringify(recording), "utf8");
  try {
    execFileSync(process.env.PYTHON ?? "python3", [rendererPath, recordingPath, frameDirectory], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const details = error.stderr?.toString().trim() || error.message;
    throw new Error(`Could not render terminal frames. Install Python 3 and Pillow.\n${details}`);
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  execFileSync(process.env.FFMPEG ?? "ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-framerate", "1/3",
    "-i", join(frameDirectory, "frame-%02d.png"),
    "-vf", "fps=10,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer",
    "-loop", "0",
    outputPath,
  ]);
  process.stdout.write(`Rendered ${outputPath}\n`);
} finally {
  rmSync(frameDirectory, { recursive: true, force: true });
}
