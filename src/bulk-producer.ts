/**
 * Bulk package metadata fetcher - Producer
 *
 * Loads all package names from all-the-package-names and adds them to a queue
 * for processing by workers.
 */

import "dotenv/config";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Queue } from "bullmq";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load package names from all-the-package-names
const allPackageNamesPath = join(
  __dirname,
  "../node_modules/all-the-package-names/names.json",
);
const allPackageNames: string[] = JSON.parse(
  readFileSync(allPackageNamesPath, "utf-8"),
);

interface PackageJobData {
  packageName: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : String(error);
}

const connection = {
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null,
};

const bulkQueue = new Queue<PackageJobData>("bulk-package-metadata", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
    removeOnComplete: {
      age: 86400, // Keep completed jobs for 24 hours
    },
    removeOnFail: {
      age: 86400, // Keep failed jobs for 24 hours
    },
  },
});

async function run(): Promise<void> {
  process.stdout.write(
    `[${nowIso()}] Loading all package names from all-the-package-names...\n`,
  );

  const packageNames = allPackageNames;
  const totalPackages = packageNames.length;

  process.stdout.write(
    `[${nowIso()}] Found ${totalPackages} packages. Adding to queue...\n`,
  );

  let queued = 0;
  let failed = 0;

  // Add packages to queue in batches to avoid overwhelming Redis
  const batchSize = 1000;
  for (let i = 0; i < packageNames.length; i += batchSize) {
    const batch = packageNames.slice(i, i + batchSize);
    const jobs = batch.map((packageName) => ({
      name: "fetch-metadata",
      data: { packageName } as PackageJobData,
      opts: {
        jobId: `bulk-${packageName}`, // Use package name as job ID to prevent duplicates
      },
    }));

    try {
      await bulkQueue.addBulk(jobs);
      queued += batch.length;
      process.stdout.write(
        `[${nowIso()}] Queued ${queued}/${totalPackages} packages...\n`,
      );
    } catch (e) {
      failed += batch.length;
      process.stderr.write(
        `[${nowIso()}] Failed to queue batch starting at ${i}: ${getErrorMessage(e)}\n`,
      );
    }
  }

  process.stdout.write(
    `[${nowIso()}] Done! Queued: ${queued}, Failed: ${failed}\n`,
  );

  // Wait a bit for jobs to be added, then close the queue connection
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await bulkQueue.close();
  process.exit(0);
}

run().catch((e) => {
  const errorMessage =
    e instanceof Error && e.stack ? e.stack : getErrorMessage(e);
  process.stderr.write(`[${nowIso()}] fatal: ${errorMessage}\n`);
  process.exitCode = 1;
  process.exit(1);
});
