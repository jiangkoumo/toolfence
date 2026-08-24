import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeToolCall } from "../src/adapters.js";
import { parsePolicy } from "../src/config.js";
import { PolicyEngine } from "../src/policy.js";
import { builtInRecipes, getRecipe, listRecipes } from "../src/recipes.js";
import { parse as parseYaml } from "yaml";

describe("policy recipes catalog", () => {
  it("lists all built-in recipes with required metadata", () => {
    const list = listRecipes();
    expect(list.length).toBe(6);
    const names = list.map((r) => r.name);
    expect(names).toContain("filesystem");
    expect(names).toContain("github");
    expect(names).toContain("fetch");
    expect(names).toContain("git");
    expect(names).toContain("sqlite");
    expect(names).toContain("postgres");
  });

  it("fetches recipes case-insensitively", () => {
    expect(getRecipe("GitHub")?.name).toBe("github");
    expect(getRecipe("  FETCH  ")?.name).toBe("fetch");
    expect(getRecipe("unknown")).toBeUndefined();
  });

  it("validates every built-in recipe against the Policy schema", () => {
    for (const recipe of Object.values(builtInRecipes)) {
      const parsedYaml = parseYaml(recipe.policy);
      const policy = parsePolicy(parsedYaml);
      expect(policy.version).toBe(1);
      expect(policy.rules.length).toBeGreaterThan(0);
    }
  });

  it("ensures examples/recipes/*.yaml match built-in recipes exactly", () => {
    for (const [name, recipe] of Object.entries(builtInRecipes)) {
      const examplePath = resolve(`examples/recipes/${name}.yaml`);
      const fileContent = readFileSync(examplePath, "utf8");
      const parsedFile = parsePolicy(parseYaml(fileContent));
      const parsedBuiltin = parsePolicy(parseYaml(recipe.policy));
      expect(parsedFile).toEqual(parsedBuiltin);
    }
  });

  it("denies literal IPv4 and IPv6 local destinations in the fetch recipe", () => {
    const policy = new PolicyEngine(
      parsePolicy(parseYaml(builtInRecipes.fetch.policy)),
      { workspace: "/tmp/workspace", home: "/tmp/home" },
    );
    for (const url of [
      "http://127.1.2.3/resource",
      "http://169.254.10.20/resource",
      "http://172.16.0.1/resource",
      "http://172.31.255.255/resource",
      "http://[::1]/resource",
      "http://[fc00::1]/resource",
      "http://[fe80::1]/resource",
    ]) {
      const action = normalizeToolCall("fetch", "fetch", { url, method: "GET" }, "/tmp/workspace");
      expect(policy.evaluate(action).effect, url).toBe("deny");
    }

    const publicAction = normalizeToolCall(
      "fetch",
      "fetch",
      { url: "https://example.com/resource", method: "GET" },
      "/tmp/workspace",
    );
    expect(policy.evaluate(publicAction).effect).toBe("allow");
  });
});
