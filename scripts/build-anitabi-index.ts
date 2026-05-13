#!/usr/bin/env bun
/**
 * Build the anitabi-index data file — every anime that anitabi.cn has
 * pilgrimage coordinates for, keyed by Bangumi subject ID.
 *
 * Primary path:
 *   GET https://api.anitabi.cn/bangumi
 *     → single bulk JSON (the same endpoint anitabi.cn's own map page uses
 *       to load every marker on launch). Entries with `geo` populated are
 *       the pilgrimage-ready ones.
 *
 *   This endpoint is NOT documented in the official anitabi open-API doc
 *   (https://github.com/anitabi/anitabi.cn-document/blob/main/api.md), so
 *   anitabi makes no stability guarantee on it. If it ever changes shape
 *   or disappears, the fallback path below takes over.
 *
 * Fallback path:
 *   For each id in EMBEDDED_FALLBACK_SEED, call the documented
 *   GET https://api.anitabi.cn/bangumi/{id}/lite endpoint and assemble a
 *   minimal but useful index. This is slower (rate-limited) and narrower
 *   (only the seed) but uses only documented endpoints, so it survives any
 *   change to the bulk mirror.
 *
 * Output: anitabi-index.json (JSON-Schema-validated against
 *   schemas/anitabi-index.schema.json) written to CWD.
 *
 * Usage:
 *   bun scripts/build-anitabi-index.ts                # try primary, fall back automatically
 *   ANITABI_FORCE_FALLBACK=1 bun scripts/...          # skip primary, exercise fallback
 *   bun scripts/build-anitabi-index.ts --out=path.json
 *
 * @see schemas/anitabi-index.schema.json for the output contract.
 */

import { writeFileSync } from 'fs';
import { resolve } from 'path';

// ---------- constants ----------

const BANGUMI_LIST_URL = 'https://api.anitabi.cn/bangumi';
const LITE_URL = (id: number) => `https://api.anitabi.cn/bangumi/${id}/lite`;

const OUTPUT_DEFAULT = 'anitabi-index.json';
const SCHEMA_URL =
  'https://github.com/Aniseekr/Aniseekr-source/raw/main/schemas/anitabi-index.schema.json';

/** Categories that anitabi tags as anime/animation. Games/manga/novels excluded. */
const ANIME_CATS = new Set(['TV', '剧场版', 'OVA', 'WEB']);

/** Wall-clock seconds we'll spend on the bulk list before giving up. */
const PRIMARY_TIMEOUT_MS = Number(process.env.ANITABI_PRIMARY_TIMEOUT_MS ?? '600000');

/** Per-request delay for the fallback /lite enumeration. */
const FALLBACK_DELAY_MS = Number(process.env.ANITABI_DELAY_MS ?? '120');

/** Bangumi subject ids we know have pilgrimage data, used only if primary fails. */
const EMBEDDED_FALLBACK_SEED: readonly number[] = [
  207195, 115908, 152091, 328609, 262897, 927, 296659, 1424, 3774, 100403,
  58949, 160209, 430699, 402656, 10440, 252655, 287488, 221127, 27364, 248175,
  259, 218708, 143205, 364450, 9912, 376703, 269235, 805, 500,
];

// ---------- types ----------

/**
 * Raw shape of one entry in the /bangumi bulk list.
 * Loosely typed — many fields come and go depending on cat.
 *
 * @schema https://api.anitabi.cn/bangumi (undocumented)
 */
interface AnitabiBulkEntry {
  id: number;
  title?: string;
  cn?: string;
  cat?: string;
  cover?: string;
  color?: string;
  city?: string;
  geo?: number[];
  zoom?: number;
  ep?: string | number;
  info?: Record<string, string>;
  release?: string;
  modified?: number;
  fade?: number;
  // …other fields ignored
}

/**
 * Raw shape of /bangumi/{id}/lite — anitabi documented endpoint.
 *
 * @schema https://github.com/anitabi/anitabi.cn-document/blob/main/api.md
 */
interface AnitabiLiteEntry {
  id: number;
  title?: string;
  cn?: string;
  cat?: string;
  cover?: string;
  color?: string;
  city?: string;
  geo?: number[];
  zoom?: number;
  pointsLength?: number;
  modified?: number;
  episodes?: number;
  ep?: number;
  // …other fields ignored
}

/** Output entry. Must match schemas/anitabi-index.schema.json $defs/IndexEntry. */
interface IndexEntry {
  id: number;
  title: string;
  cn: string;
  city: string;
  cover: string;
  color: string;
  lat: number;
  lng: number;
  zoom: number;
  pointsLength: number;
  episodes: number | null;
  startYear: number | null;
  modified: number | null;
}

/** Output document. Must match schemas/anitabi-index.schema.json root. */
interface IndexFile {
  $schema: string;
  generatedAt: number;
  source: string;
  fallbackUsed: boolean;
  entries: IndexEntry[];
}

// ---------- helpers ----------

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function hasValidGeo(entry: { geo?: number[] }): entry is { geo: [number, number] } {
  const g = entry.geo;
  if (!Array.isArray(g) || g.length < 2) return false;
  const [lat, lng] = g;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat === 0 && lng === 0) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  return true;
}

function coerceInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v === 'string') {
    const m = v.match(/-?\d+/);
    if (m) {
      const n = Number(m[0]);
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
  }
  return null;
}

/** Extract first-air year from anitabi's loose info/release shape. */
function extractStartYear(raw: AnitabiBulkEntry | AnitabiLiteEntry): number | null {
  const info = (raw as AnitabiBulkEntry).info ?? {};
  // Common Bangumi.tv keys
  for (const key of ['放送开始', '首播', '发售日', '上映年度', '连载开始']) {
    const v = info[key];
    if (typeof v === 'string' && v.length >= 4) {
      const m = v.match(/(\d{4})/);
      if (m) {
        const y = Number(m[1]);
        if (y >= 1900 && y <= 2100) return y;
      }
    }
  }
  const release = (raw as AnitabiBulkEntry).release;
  if (typeof release === 'string' && /^\d{6}$/.test(release)) {
    // anitabi quirk: YYMMDD with a 70 pivot for century.
    const yy = Number(release.slice(0, 2));
    const year = yy >= 70 ? 1900 + yy : 2000 + yy;
    if (year >= 1970 && year <= 2099) return year;
  }
  return null;
}

function extractEpisodes(raw: AnitabiBulkEntry | AnitabiLiteEntry): number | null {
  if ('episodes' in raw) {
    const n = coerceInt((raw as AnitabiLiteEntry).episodes);
    if (n !== null) return n;
  }
  return coerceInt(raw.ep);
}

function entryFromBulk(raw: AnitabiBulkEntry): IndexEntry | null {
  if (!hasValidGeo(raw)) return null;
  if (!ANIME_CATS.has(raw.cat ?? '')) return null;
  return {
    id: raw.id,
    title: raw.title ?? '',
    cn: raw.cn ?? '',
    city: raw.city ?? '',
    cover: raw.cover ?? '',
    color: raw.color ?? '',
    lat: round6(raw.geo![0]),
    lng: round6(raw.geo![1]),
    zoom: round1(raw.zoom ?? 0),
    // bulk endpoint doesn't surface pointsLength; geo presence already means
    // pilgrimage data exists, so 1 is a safe placeholder for UI gating.
    pointsLength: 1,
    episodes: extractEpisodes(raw),
    startYear: extractStartYear(raw),
    modified: typeof raw.modified === 'number' ? raw.modified : null,
  };
}

function entryFromLite(raw: AnitabiLiteEntry): IndexEntry | null {
  if (!hasValidGeo(raw)) return null;
  if ((raw.pointsLength ?? 0) <= 0) return null;
  return {
    id: raw.id,
    title: raw.title ?? '',
    cn: raw.cn ?? '',
    city: raw.city ?? '',
    cover: raw.cover ?? '',
    color: raw.color ?? '',
    lat: round6(raw.geo![0]),
    lng: round6(raw.geo![1]),
    zoom: round1(raw.zoom ?? 0),
    pointsLength: raw.pointsLength ?? 0,
    episodes: extractEpisodes(raw),
    startYear: extractStartYear(raw),
    modified: typeof raw.modified === 'number' ? raw.modified : null,
  };
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((r) => setTimeout(r, ms));
}

// ---------- primary: bulk /bangumi ----------

async function fetchPrimary(): Promise<AnitabiBulkEntry[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PRIMARY_TIMEOUT_MS);
  try {
    console.log(`[anitabi-index] GET ${BANGUMI_LIST_URL}`);
    const res = await fetch(BANGUMI_LIST_URL, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`Primary HTTP ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as AnitabiBulkEntry[];
    if (!Array.isArray(json)) {
      throw new Error('Primary response is not an array');
    }
    console.log(`[anitabi-index] primary: ${json.length} raw subjects`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- fallback: /lite enumeration ----------

async function fetchLite(id: number): Promise<AnitabiLiteEntry | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(LITE_URL(id), {
        headers: { Accept: 'application/json' },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as AnitabiLiteEntry;
    } catch (err) {
      if (attempt === 3) {
        console.warn(`[anitabi-index] lite ${id} failed:`, (err as Error).message);
        return null;
      }
      await delay(500 * attempt);
    }
  }
  return null;
}

async function buildFallback(): Promise<IndexEntry[]> {
  console.log(`[anitabi-index] fallback: enumerating ${EMBEDDED_FALLBACK_SEED.length} seeds via /lite`);
  const out: IndexEntry[] = [];
  for (const id of EMBEDDED_FALLBACK_SEED) {
    const lite = await fetchLite(id);
    if (lite) {
      const entry = entryFromLite(lite);
      if (entry) out.push(entry);
    }
    await delay(FALLBACK_DELAY_MS);
  }
  return out;
}

// ---------- main ----------

function parseOutPath(): string {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--out=')) return arg.slice('--out='.length);
  }
  return OUTPUT_DEFAULT;
}

async function main(): Promise<void> {
  const forceFallback = process.env.ANITABI_FORCE_FALLBACK === '1';

  let entries: IndexEntry[] = [];
  let source = BANGUMI_LIST_URL;
  let fallbackUsed = false;

  if (!forceFallback) {
    try {
      const raw = await fetchPrimary();
      for (const r of raw) {
        const entry = entryFromBulk(r);
        if (entry) entries.push(entry);
      }
      console.log(`[anitabi-index] primary: kept ${entries.length} anime with pilgrimage data`);
    } catch (err) {
      console.warn(
        `[anitabi-index] primary failed (${(err as Error).message}), switching to fallback`
      );
      entries = [];
    }
  }

  if (entries.length === 0) {
    entries = await buildFallback();
    source = 'fallback:lite-enumeration';
    fallbackUsed = true;
    console.log(`[anitabi-index] fallback: built ${entries.length} entries from seed`);
  }

  if (entries.length === 0) {
    throw new Error('Both primary and fallback produced 0 entries — refusing to write empty index');
  }

  entries.sort((a, b) => a.id - b.id);

  const doc: IndexFile = {
    $schema: SCHEMA_URL,
    generatedAt: Date.now(),
    source,
    fallbackUsed,
    entries,
  };

  const outPath = resolve(process.cwd(), parseOutPath());
  writeFileSync(outPath, JSON.stringify(doc), 'utf8');
  console.log(
    `[anitabi-index] wrote ${entries.length} entries → ${outPath} (fallback=${fallbackUsed})`
  );
}

main().catch((err) => {
  console.error('[anitabi-index] FATAL', err);
  process.exit(1);
});
