#!/usr/bin/env bun
/**
 * Build the two anitabi point-level artifacts from the L2 anitabi-index.
 *
 * For every Bangumi subject id in the L2 index, fetch the complete
 * GET https://api.anitabi.cn/bangumi/{id}/points payload once, and in a single
 * pass emit BOTH:
 *
 *   1. anitabi-spots-index.json — a flat, global, point-level index. One row
 *      per scene point that has valid geo AND a scene image. This is what the
 *      app queries for "sacred sites near me". (~40-80k rows, minified.)
 *   2. anitabi-points-top.json — the raw /points payload for the top-100 anime
 *      by pointsLength, so the app can seed complete offline point data for the
 *      most-visited anime. (Fed straight into the app's normalizeRawPoints.)
 *
 * L2 index input (mirrors build-anitabi-cross-index.ts):
 *   - Local ./anitabi-index.json when present (dev loop / CI checkout), else
 *   - the stable alias release asset (downloaded, 404-tolerant).
 *   Override the local path with ANITABI_INDEX_PATH.
 *
 * WAF probe (spec 2026-07-03 §5 spike 1): api.anitabi.cn sits behind a
 * Cloudflare WAF. A 403 means the pipeline's egress is now blocked; rather than
 * write a half-empty index the script ABORTS the whole run and exits 1, so a
 * failed workflow is a visible signal. (404 = "this anime has no points" and is
 * skipped; other transient errors get 3 retries then skip that id.)
 *
 * The fetch/retry loop (`runPointsLoop`) takes an injectable fetch + delay so
 * it's unit-testable with fakes (tests/build-anitabi-points.test.ts) without
 * ever touching the real, WAF-fronted api.anitabi.cn.
 *
 * Usage:
 *   bun scripts/build-anitabi-points.ts
 *   ANITABI_INDEX_PATH=./anitabi-index.json bun scripts/build-anitabi-points.ts
 *   ANITABI_DELAY_MS=200 bun scripts/build-anitabi-points.ts
 *
 * @see schemas/anitabi-spots-index.schema.json, schemas/anitabi-points-top.schema.json
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import {
  spotEntryFromRawPoint,
  topBangumiIdsByPoints,
  type RawPoint,
  type SpotEntry,
} from './lib/anitabi-points-build';

// ---------- constants ----------

const POINTS_URL = (id: number) => `https://api.anitabi.cn/bangumi/${id}/points`;

const L2_LOCAL_DEFAULT = 'anitabi-index.json';
const L2_ALIAS_URL =
  'https://github.com/Aniseekr/Aniseekr-source/releases/download/anitabi-index/anitabi-index.json';

const SPOTS_OUTPUT = 'anitabi-spots-index.json';
const TOP_OUTPUT = 'anitabi-points-top.json';

const SPOTS_SCHEMA_URL =
  'https://github.com/Aniseekr/Aniseekr-source/raw/main/schemas/anitabi-spots-index.schema.json';
const TOP_SCHEMA_URL =
  'https://github.com/Aniseekr/Aniseekr-source/raw/main/schemas/anitabi-points-top.schema.json';

const USER_AGENT = 'Aniseekr-source/1.0 (+https://github.com/Aniseekr/Aniseekr-source)';
const DELAY_MS = Number(process.env.ANITABI_DELAY_MS ?? '120');
const TOP_N = 100;

// ---------- types ----------

interface L2Entry {
  id: number;
  pointsLength?: number | null;
}
interface L2File {
  generatedAt: number;
  source: string;
  entries: L2Entry[];
}
interface RawPointsResponse {
  points?: RawPoint[];
}

/** Injectable seam so the fetch/retry loop is testable without real network. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
/** Injectable seam so retry/inter-request backoff is testable without real timers. */
export type DelayLike = (ms: number) => Promise<void>;

/** Thrown when anitabi returns HTTP 403 — treated as a hard, run-aborting WAF block. */
export class WafBlockedError extends Error {}

// ---------- helpers ----------

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

/** Load L2 from a local file (dev/CI checkout) or the alias release (404-tolerant). */
async function loadL2(): Promise<L2File | null> {
  const localPath = process.env.ANITABI_INDEX_PATH ?? L2_LOCAL_DEFAULT;
  const abs = resolve(process.cwd(), localPath);
  if (existsSync(abs)) {
    console.log(`[anitabi-points] reading local L2 index: ${abs}`);
    return JSON.parse(readFileSync(abs, 'utf8')) as L2File;
  }
  console.log(`[anitabi-points] no local index, downloading alias: ${L2_ALIAS_URL}`);
  try {
    const res = await fetch(L2_ALIAS_URL, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    });
    if (res.status === 404) {
      console.warn('[anitabi-points] L2 alias 404 (index not published yet)');
      return null;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as L2File;
  } catch (err) {
    console.warn('[anitabi-points] L2 download failed:', (err as Error).message);
    return null;
  }
}

/** Fetch /points for one id: 404→null(skip), 403→WafBlockedError, else 3 retries then null. */
async function fetchPoints(
  id: number,
  fetchImpl: FetchLike,
  delayImpl: DelayLike
): Promise<RawPoint[] | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetchImpl(POINTS_URL(id), {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      });
      if (res.status === 403) throw new WafBlockedError(`HTTP 403 on bgm#${id}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as RawPointsResponse;
      return Array.isArray(json.points) ? json.points : [];
    } catch (err) {
      if (err instanceof WafBlockedError) throw err; // never retry a WAF block
      if (attempt === 3) {
        console.warn(`[anitabi-points] points ${id} failed:`, (err as Error).message);
        return null;
      }
      await delayImpl(500 * attempt);
    }
  }
  return null;
}

/** Aggregate result of one full pass over the L2 seeds. */
export interface BuildLoopResult {
  spots: SpotEntry[];
  byBangumiId: Record<string, RawPoint[]>;
  fetched: number;
  skipped: number;
}

/**
 * Fetch /points for every seed once and, in the same pass, emit both the flat
 * spots array (filtered via spotEntryFromRawPoint) and the raw per-anime
 * payload for ids in `topIds`. Throws WafBlockedError (never caught here) the
 * instant any request 403s, so the caller can abort without writing partial
 * artifacts. `fetchImpl`/`delayImpl` default to the real network/timer but are
 * overridable so this loop is unit-testable with fakes.
 */
export async function runPointsLoop(
  seeds: readonly L2Entry[],
  topIds: ReadonlySet<number>,
  fetchImpl: FetchLike = fetch,
  delayMs: number = DELAY_MS,
  delayImpl: DelayLike = delay
): Promise<BuildLoopResult> {
  const spots: SpotEntry[] = [];
  const byBangumiId: Record<string, RawPoint[]> = {};
  let fetched = 0;
  let skipped = 0;

  for (let i = 0; i < seeds.length; i++) {
    const id = seeds[i].id;
    const raw = await fetchPoints(id, fetchImpl, delayImpl); // throws WafBlockedError → aborts
    if (raw === null) {
      skipped++;
    } else {
      fetched++;
      for (const p of raw) {
        const entry = spotEntryFromRawPoint(p, id);
        if (entry) spots.push(entry);
      }
      if (topIds.has(id)) byBangumiId[String(id)] = raw;
    }
    if ((i + 1) % 50 === 0) {
      console.log(`[anitabi-points] ${i + 1}/${seeds.length} (spots so far: ${spots.length})`);
    }
    await delayImpl(delayMs);
  }

  return { spots, byBangumiId, fetched, skipped };
}

// ---------- main ----------

async function main(): Promise<void> {
  const l2 = await loadL2();
  if (!l2 || !Array.isArray(l2.entries) || l2.entries.length === 0) {
    throw new Error('L2 anitabi-index unavailable or empty — refusing to build points over zero seeds');
  }

  const seeds = l2.entries;
  const topIds = new Set(topBangumiIdsByPoints(seeds, TOP_N));
  console.log(`[anitabi-points] ${seeds.length} seeds, top-${TOP_N} snapshot targets: ${topIds.size}`);

  const { spots, byBangumiId, fetched, skipped } = await runPointsLoop(seeds, topIds);

  if (spots.length === 0) {
    throw new Error('Produced 0 spots — refusing to write an empty spots index');
  }

  const now = Date.now();
  const spotsDoc = {
    $schema: SPOTS_SCHEMA_URL,
    generatedAt: now,
    source: 'scripts/build-anitabi-points.ts',
    count: spots.length,
    spots,
  };
  const topDoc = {
    $schema: TOP_SCHEMA_URL,
    generatedAt: now,
    source: 'scripts/build-anitabi-points.ts',
    topN: TOP_N,
    byBangumiId,
  };

  writeFileSync(resolve(process.cwd(), SPOTS_OUTPUT), JSON.stringify(spotsDoc), 'utf8');
  writeFileSync(resolve(process.cwd(), TOP_OUTPUT), JSON.stringify(topDoc), 'utf8');

  console.log(
    `[anitabi-points] wrote ${spots.length} spots → ${SPOTS_OUTPUT}\n` +
      `[anitabi-points] wrote ${Object.keys(byBangumiId).length} anime snapshots → ${TOP_OUTPUT}\n` +
      `  fetched: ${fetched}  skipped(404/err): ${skipped}`
  );
}

// Only run when executed directly (`bun scripts/build-anitabi-points.ts`), not
// when imported by tests for its exported functions/types.
if (import.meta.main) {
  main().catch((err: unknown) => {
    if (err instanceof WafBlockedError) {
      console.error('[anitabi-points] ABORT: anitabi WAF returned 403 — pipeline egress blocked.', err.message);
      process.exit(1);
    }
    console.error('[anitabi-points] FATAL', err);
    process.exit(1);
  });
}
