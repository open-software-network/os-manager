import { readFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";

export const providerSchema = z.enum(["claude-code", "codex-cli"]);

export const modelRefSchema = z.object({
  provider: providerSchema,
  model: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  tools: z.array(z.string()).optional(),
  timeout_seconds: z.number().int().positive().default(900)
});

export type ProviderName = z.infer<typeof providerSchema>;
export type ModelRef = z.infer<typeof modelRefSchema>;

export const repoRefSchema = z
  .string()
  .regex(/^[^/\s]+\/[^/\s]+$/, "repo must be in owner/name form");

export const configSchema = z.object({
  manager: z.object({
    login: z.string().min(1)
  }),
  models: z.object({
    triage: modelRefSchema,
    plan: modelRefSchema,
    review: modelRefSchema,
    meta_review: modelRefSchema
  }),
  poll: z
    .object({
      interval_seconds: z.number().int().positive().default(60)
    })
    .default({ interval_seconds: 60 }),
  policies: z
    .object({
      triage_prompt: z.string().default(""),
      max_review_rounds: z.number().int().positive().default(3),
      max_meta_rounds: z.number().int().positive().default(2),
      stale_after_hours: z.number().positive().default(48)
    })
    .default({
      triage_prompt: "",
      max_review_rounds: 3,
      max_meta_rounds: 2,
      stale_after_hours: 48
    }),
  budgets: z
    .object({
      per_task_usd: z.number().positive().default(5),
      daily_usd: z.number().positive().default(100)
    })
    .default({ per_task_usd: 5, daily_usd: 100 }),
  merge: z
    .object({
      method: z.enum(["merge", "squash", "rebase"]).default("squash"),
      auto_merge_on_approve: z.boolean().default(true)
    })
    .default({ method: "squash", auto_merge_on_approve: true }),
  escalation: z
    .object({
      mention: z.array(z.string()).default([])
    })
    .default({ mention: [] }),
  labels: z
    .object({
      prefix: z.string().min(1).default("osm")
    })
    .default({ prefix: "osm" })
});

export type OsManagerConfig = z.infer<typeof configSchema>;

export interface RepoRef {
  owner: string;
  repo: string;
}

export function parseRepoRef(repo: string): RepoRef {
  const parsed = repoRefSchema.parse(repo);
  const [owner, name] = parsed.split("/");
  if (!owner || !name) {
    throw new Error(`Invalid repo ref: ${repo}`);
  }
  return { owner, repo: name };
}

export async function loadConfig(path = ".github/osmanager.yml"): Promise<OsManagerConfig> {
  const content = await readFile(path, "utf8");
  const parsed = YAML.parse(content) as unknown;
  return configSchema.parse(parsed);
}

export async function tryLoadConfig(path = ".github/osmanager.yml"): Promise<OsManagerConfig | undefined> {
  try {
    return await loadConfig(path);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export function defaultStateDir(repo: RepoRef): string {
  const safe = `${repo.owner}__${repo.repo}`.replaceAll(/[^a-zA-Z0-9_.-]/g, "_");
  return join(process.env.HOME ?? process.cwd(), ".os-manager", "state", safe);
}
