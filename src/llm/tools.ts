import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";
import fg from "fast-glob";
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

export function createReadOnlyToolExecutors(cwd: string): Record<string, (input: unknown) => Promise<string>> {
  const root = resolve(cwd);
  return {
    read_file: async (input: unknown) => {
      const { path, maxBytes } = z
        .object({
        path: z.string(),
        maxBytes: z.number().int().positive().max(500_000).default(200_000)
      })
        .parse(input);
      const target = assertInside(root, path);
      const content = await readFile(target, "utf8");
      return trimOutput(content, maxBytes);
    },
    glob: async (input: unknown) => {
      const { pattern, limit } = z
        .object({
        pattern: z.string(),
        limit: z.number().int().positive().max(1000).default(200)
      })
        .parse(input);
      const entries = await fg(pattern, {
        cwd: root,
        onlyFiles: true,
        dot: true,
        ignore: [".git/**", "node_modules/**", "dist/**"]
      });
      return entries.slice(0, limit).join("\n");
    },
    grep: async (input: unknown) => {
      const { pattern, path, limit } = z
        .object({
        pattern: z.string(),
        path: z.string().default("."),
        limit: z.number().int().positive().max(1000).default(200)
      })
        .parse(input);
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
    },
    git_read: async (input: unknown) => {
      const { args } = gitReadSchema.parse(input);
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
  };
}

export const testOnly = { assertInside };
