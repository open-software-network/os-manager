import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export async function readAsset(relativePath: string): Promise<string> {
  const candidates = [
    resolve(process.cwd(), "assets", relativePath),
    resolve(here, "..", "assets", relativePath),
    resolve(here, "..", "..", "assets", relativePath)
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return await readFile(candidate, "utf8");
    } catch {
      // Try the next packaging layout.
    }
  }
  throw new Error(`Unable to locate asset ${relativePath}`);
}
