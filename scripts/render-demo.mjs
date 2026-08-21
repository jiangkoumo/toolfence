import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDemo } from "./demo.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(repositoryRoot, "docs/assets/demo.gif");
const frameDirectory = mkdtempSync(join(tmpdir(), "toolfence-demo-"));
const recording = await runDemo();
const width = 1200;
const height = 675;

const colors = {
  background: [13, 17, 23],
  chrome: [22, 27, 34],
  foreground: [230, 237, 243],
  muted: [139, 148, 158],
  blue: [88, 166, 255],
  allow: [94, 227, 141],
  deny: [255, 107, 122],
  ask: [246, 200, 95],
};

const glyphs = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  J: ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  0: ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  2: ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  3: ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  4: ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  5: ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  6: ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  7: ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  8: ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  9: ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  _: ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
  "$": ["00100", "01111", "10100", "01110", "00101", "11110", "00100"],
  "|": ["00100", "00100", "00100", "00100", "00100", "00100", "00100"],
};

function fill(buffer, color) {
  for (let index = 0; index < buffer.length; index += 3) {
    buffer[index] = color[0];
    buffer[index + 1] = color[1];
    buffer[index + 2] = color[2];
  }
}

function rectangle(buffer, x, y, w, h, color) {
  for (let py = Math.max(0, y); py < Math.min(height, y + h); py += 1) {
    for (let px = Math.max(0, x); px < Math.min(width, x + w); px += 1) {
      const offset = (py * width + px) * 3;
      buffer[offset] = color[0];
      buffer[offset + 1] = color[1];
      buffer[offset + 2] = color[2];
    }
  }
}

function text(buffer, value, x, y, color, scale = 3) {
  let cursor = x;
  for (const character of value.toUpperCase()) {
    const glyph = glyphs[character] ?? glyphs[" "];
    glyph.forEach((row, rowIndex) => {
      [...row].forEach((pixel, columnIndex) => {
        if (pixel === "1") {
          rectangle(buffer, cursor + columnIndex * scale, y + rowIndex * scale, scale, scale, color);
        }
      });
    });
    cursor += 6 * scale;
  }
}

function frame(visible, showSummary) {
  const buffer = Buffer.alloc(width * height * 3);
  fill(buffer, colors.background);
  rectangle(buffer, 0, 0, width, 58, colors.chrome);
  rectangle(buffer, 28, 22, 16, 16, [255, 95, 87]);
  rectangle(buffer, 54, 22, 16, 16, [254, 188, 46]);
  rectangle(buffer, 80, 22, 16, 16, [40, 200, 64]);
  text(buffer, "TOOLFENCE DEMO", 474, 22, colors.muted, 2);
  text(buffer, "$ NPM RUN DEMO", 78, 94, colors.blue, 3);
  text(buffer, "TOOLFENCE END-TO-END DEMO", 78, 148, colors.foreground, 3);
  text(buffer, `FILESYSTEM MCP ${recording.filesystemVersion}`, 78, 197, colors.muted, 2);

  recording.events.slice(0, visible).forEach((event, index) => {
    const y = 256 + index * 67;
    text(buffer, event.effect, 78, y, colors[event.effect], 3);
    text(buffer, event.label, 190, y, colors.foreground, 3);
    text(buffer, event.detail, 590, y + 4, colors.muted, 2);
  });

  if (showSummary) {
    text(buffer, recording.summary, 78, 558, colors.foreground, 2);
  } else {
    rectangle(buffer, 78, 558, 14, 24, colors.blue);
  }
  text(buffer, "RECORDED FROM REAL MCP PROCESSES", 786, 628, [72, 79, 88], 2);
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), buffer]);
}

try {
  const states = [
    [0, false],
    [1, false],
    [2, false],
    [3, false],
    [4, false],
    [4, true],
    [4, true],
  ];
  states.forEach(([visible, showSummary], index) => {
    writeFileSync(join(frameDirectory, `frame-${String(index).padStart(2, "0")}.ppm`), frame(visible, showSummary));
  });

  mkdirSync(dirname(outputPath), { recursive: true });
  execFileSync(process.env.FFMPEG ?? "ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-framerate", "1/3",
    "-i", join(frameDirectory, "frame-%02d.ppm"),
    "-vf", "fps=10,split[s0][s1];[s0]palettegen=max_colors=96:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer",
    "-loop", "0",
    outputPath,
  ]);
  process.stdout.write(`Rendered ${outputPath}\n`);
} finally {
  rmSync(frameDirectory, { recursive: true, force: true });
}
