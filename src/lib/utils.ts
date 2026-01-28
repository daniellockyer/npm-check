import { promises as fs } from "fs";
import { join } from "path";
import { type Packument } from "./fetch-packument.ts";

export const DEFAULT_OUTPUT_DIR = "./metadata";

export function nowIso(): string {
  return new Date().toISOString();
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : String(error);
}

export async function ensureOutputDir(outputDir: string): Promise<void> {
  try {
    await fs.access(outputDir);
  } catch {
    await fs.mkdir(outputDir, { recursive: true });
  }
}

export async function writeMetadataToFile(
  packageName: string,
  metadata: Packument,
  outputDir: string,
): Promise<void> {
  // Sanitize package name for filesystem (handle scoped packages)
  const sanitizedName = packageName.replace(/[\/\\:*?"<>|]/g, "_");
  const filePath = join(outputDir, `${sanitizedName}.json`);

  await fs.writeFile(filePath, JSON.stringify(metadata, null, 2), "utf-8");
}
