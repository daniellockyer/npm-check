/**
 * npm postinstall monitor
 *
 * Polls npm's replicate `_changes` endpoint and flags new publishes that
 * introduce a `scripts.postinstall` entry.
 *
 * Notes:
 * - `replicate.npmjs.com` currently rejects streaming feeds (`feed=continuous`)
 *   and `include_docs`, so this script uses the normal `_changes` feed and
 *   fetches package metadata from `registry.npmjs.org` to inspect scripts.
 */

'use strict';

const https = require('node:https');
const { setTimeout: delay } = require('node:timers/promises');

const DEFAULT_REPLICATE_DB_URL = 'https://replicate.npmjs.com/';
const DEFAULT_CHANGES_URL = 'https://replicate.npmjs.com/_changes';
const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org/';

const agent = new https.Agent({ keepAlive: true, maxSockets: 50 });

function nowIso() {
  return new Date().toISOString();
}

function isLikelyVersionKey(key) {
  // Basic semver-ish guard; npm time keys are usually exact versions.
  return typeof key === 'string' && /^\d+\.\d+\.\d+.*$/.test(key);
}

function hasPostinstall(versionDoc) {
  if (!versionDoc || typeof versionDoc !== 'object') return false;
  const scripts = versionDoc.scripts;
  if (!scripts || typeof scripts !== 'object') return false;
  const val = scripts.postinstall;
  return typeof val === 'string' && val.trim().length > 0;
}

function pickLatestAndPreviousVersions(doc) {
  const versions = doc && doc.versions && typeof doc.versions === 'object' ? doc.versions : null;
  const time = doc && doc.time && typeof doc.time === 'object' ? doc.time : null;
  const distTags =
    doc && doc['dist-tags'] && typeof doc['dist-tags'] === 'object' ? doc['dist-tags'] : null;

  if (!versions) return { latest: null, previous: null };

  // Prefer dist-tags.latest for the "current" publish signal.
  const latest = distTags && typeof distTags.latest === 'string' ? distTags.latest : null;

  // Try to find the previous version using publish times.
  let previous = null;
  if (time) {
    const entries = Object.entries(time)
      .filter(([k, v]) => isLikelyVersionKey(k) && typeof v === 'string')
      .map(([k, v]) => ({ version: k, t: Date.parse(v) }))
      .filter((x) => Number.isFinite(x.t))
      .sort((a, b) => b.t - a.t);

    if (entries.length > 0) {
      const effectiveLatest = latest && versions[latest] ? latest : entries[0].version;
      const prevEntry = entries.find((e) => e.version !== effectiveLatest);
      previous = prevEntry ? prevEntry.version : null;
      return { latest: effectiveLatest, previous };
    }
  }

  // Fallback: if we can't use time, just use dist-tag latest and no previous.
  return { latest: latest && versions[latest] ? latest : null, previous: null };
}

function httpGetJson(url, { headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: {
          'User-Agent': 'npm-check-postinstall-monitor',
          Accept: 'application/json',
          ...(headers || {})
        },
        agent,
        timeout: 60000
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          if (body.length > 20 * 1024 * 1024) {
            req.destroy(new Error('response too large'));
          }
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode || 0}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`invalid JSON: ${e && e.message ? e.message : String(e)}`));
          }
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', (e) => reject(e));
    req.end();
  });
}

async function getInitialSince(replicateDbUrl) {
  const dbInfo = await httpGetJson(replicateDbUrl);
  if (!dbInfo || typeof dbInfo.update_seq === 'undefined') {
    throw new Error('replicate db info missing update_seq');
  }
  return dbInfo.update_seq;
}

function encodePackageNameForRegistry(name) {
  // Scoped packages need the slash encoded: @scope%2Fpkg
  return encodeURIComponent(name);
}

async function fetchPackument(registryBaseUrl, name) {
  const url = new URL(encodePackageNameForRegistry(name), registryBaseUrl);
  // "corgi" packument: smaller than full and includes scripts.
  return httpGetJson(url, {
    headers: { Accept: 'application/vnd.npm.install-v1+json' }
  });
}

async function run() {
  const replicateDbUrl = process.env.NPM_REPLICATE_DB_URL || DEFAULT_REPLICATE_DB_URL;
  const changesUrl = process.env.NPM_CHANGES_URL || DEFAULT_CHANGES_URL;
  const registryBaseUrl = process.env.NPM_REGISTRY_URL || DEFAULT_REGISTRY_URL;

  const maxConcurrency = Math.max(1, Number(process.env.MAX_CONCURRENCY || 10));
  const limit = Math.max(1, Math.min(5000, Number(process.env.CHANGES_LIMIT || 200)));
  const pollMs = Math.max(250, Number(process.env.POLL_MS || 1500));
  const maxCachePackages = Math.max(1000, Number(process.env.MAX_CACHE_PACKAGES || 200000));

  const flagged = new Set(); // `${name}@${version}` flagged already
  const lastSeenLatest = new Map(); // name -> latest version processed

  let since = null;
  let backoffMs = 1000;

  since = await getInitialSince(replicateDbUrl);
  process.stdout.write(
    `[${nowIso()}] starting poll: changes=${changesUrl} since=${since} limit=${limit} concurrency=${maxConcurrency}\n`
  );

  const queue = [];
  let inFlight = 0;

  const runNext = () => {
    while (inFlight < maxConcurrency && queue.length > 0) {
      const fn = queue.shift();
      inFlight += 1;
      Promise.resolve()
        .then(fn)
        .catch(() => {})
        .finally(() => {
          inFlight -= 1;
          runNext();
        });
    }
  };

  const enqueue = (fn) => {
    queue.push(fn);
    runNext();
  };

  // Run indefinitely.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const url = new URL(changesUrl);
      url.searchParams.set('since', String(since));
      url.searchParams.set('limit', String(limit));

      const changes = await httpGetJson(url);
      backoffMs = 1000;

      if (!changes || !Array.isArray(changes.results) || typeof changes.last_seq === 'undefined') {
        throw new Error('unexpected _changes response shape');
      }

      for (const row of changes.results) {
        if (!row || typeof row.id !== 'string') continue;
        const name = row.id;
        if (name.startsWith('_design/')) continue;

        enqueue(async () => {
          let packument;
          try {
            packument = await fetchPackument(registryBaseUrl, name);
          } catch (e) {
            process.stderr.write(
              `[${nowIso()}] WARN packument fetch failed for ${name}: ${e && e.message ? e.message : String(e)}\n`
            );
            return;
          }

          const { latest, previous } = pickLatestAndPreviousVersions(packument);
          if (!latest) return;

          const last = lastSeenLatest.get(name);
          if (last === latest) return;
          lastSeenLatest.set(name, latest);

          if (lastSeenLatest.size > maxCachePackages) {
            lastSeenLatest.clear();
            process.stderr.write(
              `[${nowIso()}] WARN package cache exceeded ${maxCachePackages}; cleared cache\n`
            );
          }

          const versions =
            packument.versions && typeof packument.versions === 'object' ? packument.versions : {};
          const latestDoc = versions[latest];
          const prevDoc = previous ? versions[previous] : null;

          const latestHas = hasPostinstall(latestDoc);
          if (!latestHas) return;

          const prevHas = prevDoc ? hasPostinstall(prevDoc) : false;
          if (prevHas) return;

          const key = `${name}@${latest}`;
          if (flagged.has(key)) return;
          flagged.add(key);

          const cmd = latestDoc && latestDoc.scripts ? latestDoc.scripts.postinstall : '';
          const prevTxt = previous ? ` (prev: ${previous})` : ' (first publish / unknown prev)';
          process.stdout.write(
            `[${nowIso()}] FLAG postinstall added: ${name}@${latest}${prevTxt}\n` +
              `  postinstall: ${JSON.stringify(cmd)}\n`
          );
        });
      }

      since = changes.last_seq;

      if (changes.results.length === 0) {
        await delay(pollMs);
      }
    } catch (err) {
      process.stderr.write(
        `[${nowIso()}] poll error: ${err && err.message ? err.message : String(err)}; retrying in ${backoffMs}ms\n`
      );
      await delay(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30000);
    }
  }
}

run().catch((e) => {
  process.stderr.write(`[${nowIso()}] fatal: ${e && e.stack ? e.stack : String(e)}\n`);
  process.exitCode = 1;
});

