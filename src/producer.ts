/**
 * npm preinstall/postinstall monitor - Producer
 *
 * Polls npm's replicate `_changes` endpoint and adds packages to a BullMQ queue
 * for processing by workers.
 */

import "dotenv/config";
import { setTimeout as delay } from "node:timers/promises";
import semver from "semver";
import { packageQueue, type PackageJobData } from "./queue.ts";

const DEFAULT_REPLICATE_DB_URL = "https://replicate.npmjs.com/";
const DEFAULT_CHANGES_URL = "https://replicate.npmjs.com/_changes";
const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org/";

interface ChangesResult {
  id: string;
  [key: string]: unknown;
}

interface ChangesResponse {
  results: ChangesResult[];
  last_seq: string | number;
  [key: string]: unknown;
}

interface DbInfo {
  update_seq: string | number;
  [key: string]: unknown;
}

function nowIso(): string {
  return new Date().toISOString();
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

async function httpGetJson<T = unknown>(
  url: string | URL,
  { headers }: { headers?: Record<string, string> } = {},
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "npm-scan-preinstall-postinstall-monitor",
        Accept: "application/json",
        ...headers,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("request timeout");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getInitialSince(
  replicateDbUrl: string,
): Promise<string | number> {
  const dbInfo = await httpGetJson<DbInfo>(replicateDbUrl);
  if (!dbInfo || typeof dbInfo.update_seq === "undefined") {
    throw new Error("replicate db info missing update_seq");
  }
  return dbInfo.update_seq;
}

async function fetchPackument(
  registryBaseUrl: string,
  name: string,
): Promise<{ versions?: Record<string, unknown>; "dist-tags"?: { latest?: string } }> {
  const response = await fetch(
    `${registryBaseUrl}${encodeURIComponent(name)}`,
    {
      headers: {
        "User-Agent": "npm-scan-preinstall-postinstall-monitor",
        Accept: "application/json",
      },
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  return (await response.json()) as {
    versions?: Record<string, unknown>;
    "dist-tags"?: { latest?: string };
  };
}

async function run(): Promise<void> {
  const replicateDbUrl =
    process.env.NPM_REPLICATE_DB_URL || DEFAULT_REPLICATE_DB_URL;
  const changesUrl = process.env.NPM_CHANGES_URL || DEFAULT_CHANGES_URL;
  const registryBaseUrl = process.env.NPM_REGISTRY_URL || DEFAULT_REGISTRY_URL;

  const changesLimit = Math.max(
    1,
    Math.min(5000, Number(process.env.CHANGES_LIMIT || 200)),
  );
  const pollMs = Math.max(250, Number(process.env.POLL_MS || 1500));

  const lastSeenLatest = new Map<string, string>(); // name -> latest version processed
  const maxCachePackages = 1000;

  let since: string | number | null = null;
  let backoffMs = 1000;

  since = await getInitialSince(replicateDbUrl);
  process.stdout.write(
    `[${nowIso()}] Producer starting: changes=${changesUrl} since=${since} limit=${changesLimit}\n`,
  );

  // Run indefinitely.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const url = new URL(changesUrl);
      url.searchParams.set("since", String(since));
      url.searchParams.set("limit", String(changesLimit));

      const changes = await httpGetJson<ChangesResponse>(url);
      backoffMs = 1000;

      if (
        !changes ||
        !Array.isArray(changes.results) ||
        typeof changes.last_seq === "undefined"
      ) {
        throw new Error("unexpected _changes response shape");
      }

      for (const row of changes.results) {
        if (!row || typeof row.id !== "string") continue;
        const name = row.id;
        if (name.startsWith("_design/")) continue;

        try {
          // Fetch packument to get latest version
          const packument = await fetchPackument(registryBaseUrl, name);
          
          // Get latest from dist-tags, or find highest semver version
          let latest: string | null = packument["dist-tags"]?.latest || null;
          
          if (!latest && packument.versions) {
            const versions = Object.keys(packument.versions);
            // Sort versions using semver if available, otherwise fallback to string sort
            const sortedVersions = versions
              .filter((v) => {
                try {
                  return semver.valid(v) !== null;
                } catch {
                  return false;
                }
              })
              .sort((a, b) => {
                try {
                  return semver.compare(b, a) ?? 0;
                } catch {
                  return b.localeCompare(a, undefined, { numeric: true });
                }
              });
            latest = sortedVersions[0] || null;
          }

          if (!latest) continue;

          const last = lastSeenLatest.get(name);
          if (last === latest) continue;
          lastSeenLatest.set(name, latest);

          if (lastSeenLatest.size > maxCachePackages) {
            lastSeenLatest.clear();
            process.stderr.write(
              `[${nowIso()}] WARN package cache exceeded ${maxCachePackages}; cleared cache\n`,
            );
          }

          // Find previous version
          const previous = last || null;

          // Add job to queue
          const jobData: PackageJobData = {
            packageName: name,
            version: latest,
            previousVersion: previous,
          };

          await packageQueue.add("scan-package", jobData, {
            jobId: `${name}@${latest}`, // Use package@version as job ID to prevent duplicates
          });

          process.stdout.write(
            `[${nowIso()}] Queued: ${name}@${latest} (prev: ${previous ?? "none"})\n`,
          );
        } catch (e) {
          process.stderr.write(
            `[${nowIso()}] WARN failed to queue ${name}: ${getErrorMessage(e)}\n`,
          );
        }
      }

      since = changes.last_seq;

      if (changes.results.length === 0) {
        await delay(pollMs);
      }
    } catch (err) {
      process.stderr.write(
        `[${nowIso()}] poll error: ${getErrorMessage(err)}; retrying in ${backoffMs}ms\n`,
      );
      await delay(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30000);
    }
  }
}

run().catch((e) => {
  const errorMessage =
    e instanceof Error && e.stack ? e.stack : getErrorMessage(e);
  process.stderr.write(`[${nowIso()}] fatal: ${errorMessage}\n`);
  process.exitCode = 1;
  process.exit(1);
});
