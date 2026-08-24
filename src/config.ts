import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { getRecipe, listRecipes } from "./recipes.js";
import { operations, type PolicyConfig } from "./types.js";

const effectSchema = z.enum(["allow", "deny", "ask"]);
const operationSchema = z.enum(operations);

const starterPolicy = `# ToolFence starts conservatively: unmatched actions require approval.
version: 1
default: ask

rules:
  - id: protect-secrets
    effect: deny
    operations: [fs.read, fs.write, fs.delete]
    resources:
      - "**/.env"
      - "**/.env.*"
      - "**/*.pem"
      - "\${home}/.ssh/**"

  - id: allow-workspace-read
    effect: allow
    operations: [fs.read]
    resources:
      - "\${workspace}/**"

  - id: allow-git-read
    effect: allow
    operations: [git.read]
`;

const ruleSchema = z.object({
  id: z.string().min(1),
  effect: effectSchema,
  operations: z.array(operationSchema).min(1),
  resources: z.array(z.string().min(1)).optional(),
  servers: z.array(z.string().min(1)).optional(),
  tools: z.array(z.string().min(1)).optional(),
  executables: z.array(z.string().min(1)).optional(),
  commands: z.array(z.array(z.string()).min(1)).optional(),
  hosts: z.array(z.string().min(1)).optional(),
  methods: z.array(z.string().min(1).transform((value) => value.toUpperCase())).optional(),
}).strict();

const policySchema = z
  .object({
    version: z.literal(1),
    default: effectSchema.default("ask"),
    redactSecrets: z.boolean().optional(),
    rules: z.array(ruleSchema).default([]),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const ids = new Set<string>();
    for (const rule of policy.rules) {
      if (ids.has(rule.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate rule id: ${rule.id}`,
          path: ["rules"],
        });
      }
      ids.add(rule.id);

      if ((rule.hosts || rule.methods) && !rule.operations.includes("net.request")) {
        ctx.addIssue({
          code: "custom",
          message: "hosts and methods are only valid for net.request rules",
          path: ["rules", rule.id],
        });
      }

      for (const resource of rule.resources ?? []) {
        const variables = resource.match(/\$\{[^}]+\}/g) ?? [];
        for (const variable of variables) {
          if (variable !== "${workspace}" && variable !== "${home}") {
            ctx.addIssue({
              code: "custom",
              message: `Unsupported resource variable ${variable}`,
              path: ["rules", rule.id, "resources"],
            });
          }
        }
      }
    }
  });

export function loadPolicy(filePath: string): PolicyConfig {
  const absolutePath = resolve(filePath);
  const source = readFileSync(absolutePath, "utf8");
  return policySchema.parse(parseYaml(source)) as PolicyConfig;
}

export function initPolicy(filePath: string, recipeName?: string): string {
  const absolutePath = resolve(filePath);
  let policyContent = starterPolicy;
  if (recipeName) {
    const recipe = getRecipe(recipeName);
    if (!recipe) {
      const available = listRecipes().map((r) => r.name).join(", ");
      throw new Error(`Unknown policy recipe "${recipeName}". Available recipes: ${available}`);
    }
    policyContent = recipe.policy;
  }
  mkdirSync(dirname(absolutePath), { recursive: true });
  try {
    writeFileSync(absolutePath, policyContent, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Policy already exists: ${absolutePath}`);
    }
    throw error;
  }
  return absolutePath;
}

export function parsePolicy(value: unknown): PolicyConfig {
  return policySchema.parse(value) as PolicyConfig;
}
