import { createInterface } from "node:readline";

createInterface({ input: process.stdin, crlfDelay: Infinity }).once("line", () => {
  process.exit(23);
});
