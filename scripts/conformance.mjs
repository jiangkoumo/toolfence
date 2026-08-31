// ToolFence conformance gate.
//
// Validates conformance/matrix.json, runs the shared conformance corpus through
// the vitest suite with report writing enabled, then verifies that every
// `supported` matrix row has a passing, dated report entry. Fails the release
// if any supported row is missing, failing, or stale relative to the package
// version.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(resolve(root, file), "utf8");
const failures = [];
const requireCondition = (condition, message) => {
  if (!condition) failures.push(message);
};

const packageJson = JSON.parse(read("package.json"));
const STATUSES = ["supported", "experimental", "unverified", "unsupported"];

const matrixPath = join(root, "conformance", "matrix.json");
requireCondition(existsSync(matrixPath), "conformance/matrix.json is missing");
const matrix = JSON.parse(read("conformance/matrix.json"));

requireCondition(
  typeof matrix.toolfenceVersion === "string" && matrix.toolfenceVersion.length > 0,
  "conformance matrix must declare a non-empty toolfenceVersion",
);
requireCondition(Number.isInteger(matrix.matrixVersion), "conformance matrix must declare an integer matrixVersion");
requireCondition(
  matrix.toolfenceVersion === packageJson.version,
  `conformance matrix identifies ${matrix.toolfenceVersion} but package is ${packageJson.version}`,
);
requireCondition(Array.isArray(matrix.rows) && matrix.rows.length > 0, "conformance matrix has no rows");
for (const row of matrix.rows) {
  requireCondition(typeof row.id === "string" && row.id.length > 0, "every matrix row needs a non-empty string id");
  requireCondition(STATUSES.includes(row.status), `matrix row ${row.id} status must be one of ${STATUSES.join(", ")}`);
  if (row.status === "supported") {
    requireCondition(
      ["legacy", "modern"].includes(row.style),
      `supported row ${row.id} must declare a style of legacy or modern`,
    );
    requireCondition(existsSync(resolve(root, row.server ?? "")), `supported row ${row.id} fixture ${row.server} is missing`);
  } else {
    requireCondition(row.server === null, `unsupported row ${row.id} must not declare a corpus-backed fixture`);
  }
}

// Run the corpus; the report is written by the test suite when the flag is set.
if (failures.length === 0) {
  execFileSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", "test/conformance.test.ts"], {
    cwd: root,
    env: { ...process.env, TOOLFENCE_CONFORMANCE_REPORT: "1" },
    stdio: "inherit",
  });
}

const reportPath = join(root, "conformance", "report.json");
requireCondition(existsSync(reportPath), "conformance/report.json was not produced by the corpus run");
const report = JSON.parse(read("conformance/report.json"));
requireCondition(
  report.toolfenceVersion === packageJson.version,
  `conformance report identifies ${report.toolfenceVersion} but package is ${packageJson.version}`,
);
requireCondition(
  Number.isInteger(report.matrixVersion),
  "conformance report must declare an integer matrixVersion",
);
requireCondition(
  report.matrixVersion === matrix.matrixVersion,
  `conformance report matrixVersion ${report.matrixVersion} does not match the matrix version ${matrix.matrixVersion}`,
);
requireCondition(
  typeof report.generatedAt === "string" && report.generatedAt.length > 0,
  "conformance report has no generatedAt evidence date",
);
for (const row of matrix.rows.filter((candidate) => candidate.status === "supported")) {
  for (const revision of row.mcpProtocol ?? []) {
    const entry = report.rows?.find((candidate) => candidate.id === row.id && candidate.revision === revision);
    requireCondition(
      entry?.status === "pass",
      `supported row ${row.id} did not pass the corpus for protocol revision ${revision} in the latest report`,
    );
  }
}

if (failures.length) {
  process.stderr.write(`Conformance gate failed (${failures.length}):\n${failures.map((item) => `- ${item}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  const supported = matrix.rows.filter((row) => row.status === "supported").length;
  process.stdout.write(
    `Conformance gate passed: ${packageJson.name}@${packageJson.version}, ${supported} supported stdio row(s) verified (report ${report.generatedAt})\n`,
  );
}
