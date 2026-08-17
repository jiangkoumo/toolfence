import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";
import type { PolicyContext } from "./types.js";

export function canonicalizePath(input: string, workspace: string): string {
  const absolute = resolve(workspace, input);
  if (existsSync(absolute)) {
    return realpathSync.native(absolute);
  }

  const missing: string[] = [];
  let cursor = absolute;

  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) {
      return absolute;
    }
    missing.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cursor = parent;
  }

  return join(realpathSync.native(cursor), ...missing);
}

function slash(value: string): string {
  return value.split(sep).join("/");
}

function expandPattern(pattern: string, context: PolicyContext): string {
  return pattern
    .replaceAll("${workspace}", slash(context.workspace))
    .replaceAll("${home}", slash(context.home));
}

export function resourceMatches(
  pattern: string,
  resource: string,
  context: PolicyContext,
): boolean {
  const expanded = expandPattern(pattern, context);
  const normalizedResource = slash(resource);
  const options = { dot: true, nocase: process.platform === "win32" };

  if (isAbsolute(expanded)) {
    return minimatch(normalizedResource, slash(expanded), options);
  }

  const relativeResource = slash(relative(context.workspace, resource));
  return (
    minimatch(relativeResource, slash(expanded), options) ||
    minimatch(normalizedResource, slash(expanded), options)
  );
}
