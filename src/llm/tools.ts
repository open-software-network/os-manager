import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";
import fg from "fast-glob";
import { tool } from "ai";
import { z } from "zod";

const execFileAsync = promisify(execFile);

function assertInside(cwd: string, path: string): string {
  const root = resolve(cwd);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel.startsWith("..") || rel === ".." || rel.includes(`..${pathSeparator()}`) || resolve(rel) === rel) {
    throw new Error(`Path escapes workspace: ${path}`);
  }
  return target;
}

function pathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

function trimOutput(value: string, maxBytes = 200_000): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  return `${value.slice(0, maxBytes)}\n\n[truncated at ${maxBytes} bytes]`;
}

const gitReadSchema = z.object({
  args: z.array(z.string()).min(1).describe("Git subcommand and arguments. First arg must be log, show, diff, or blame.")
});

export const allowedGitSubcommands = new Set(["log", "show", "diff", "blame"]);

export function createReadOnlyTools(cwd: string): Record<string, unknown> {
  const root = resolve(cwd);
  return {
    read_file: tool({
      description: "Read a UTF-8 text file inside the checked-out repository workspace.",
      inputSchema: z.object({
        path: z.string(),
        maxBytes: z.number().int().positive().max(500_000).default(200_000)
      }),
      execute: async ({ path, maxBytes }: { path: string; maxBytes: number }) => {
        const target = assertInside(root, path);
        const content = await readFile(target, "utf8");
        return trimOutput(content, maxBytes);
      }
    }),
    glob: tool({
      description: "List files matching a glob pattern inside the workspace.",
      inputSchema: z.object({
        pattern: z.string(),
        limit: z.number().int().positive().max(1000).default(200)
      }),
      execute: async ({ pattern, limit }: { pattern: string; limit: number }) => {
        const entries = await fg(pattern, {
          cwd: root,
          onlyFiles: true,
          dot: true,
          ignore: [".git/**", "node_modules/**", "dist/**"]
        });
        return entries.slice(0, limit).join("\n");
      }
    }),
    grep: tool({
      description: "Search the workspace with ripgrep. Pattern is treated as a ripgrep pattern.",
      inputSchema: z.object({
        pattern: z.string(),
        path: z.string().default("."),
        limit: z.number().int().positive().max(1000).default(200)
      }),
      execute: async ({ pattern, path, limit }: { pattern: string; path: string; limit: number }) => {
        const searchPath = assertInside(root, path);
        try {
          const { stdout } = await execFileAsync("rg", ["--line-number", "--no-heading", "--color", "never", pattern, searchPath], {
            cwd: root,
            maxBuffer: 1024 * 1024
          });
          return stdout.split("\n").slice(0, limit).join("\n");
        } catch (error) {
          const maybe = error as { code?: number; stdout?: string };
          if (maybe.code === 1) {
            return "";
          }
          if (maybe.stdout) {
            return maybe.stdout.split("\n").slice(0, limit).join("\n");
          }
          throw error;
        }
      }
    }),
    git_read: tool({
      description: "Run a read-only git command. First arg must be log, show, diff, or blame.",
      inputSchema: gitReadSchema,
      execute: async ({ args }: z.infer<typeof gitReadSchema>) => {
        const [subcommand, ...rest] = args;
        if (!subcommand || !allowedGitSubcommands.has(subcommand)) {
          throw new Error(`git subcommand is not allowed: ${subcommand ?? ""}`);
        }
        const { stdout, stderr } = await execFileAsync("git", [subcommand, ...rest], {
          cwd: root,
          maxBuffer: 1024 * 1024
        });
        return trimOutput(stdout || stderr);
      }
    })
  };
}

export const testOnly = { assertInside };
