#!/usr/bin/env bun
/**
 * Build the anitabi-cross-index — for every L2 anitabi-index seed (Bangumi
 * subject id), resolve the corresponding AniList + MyAnimeList ids by
 * querying AniList GraphQL with the Bangumi Japanese title and
 * disambiguating on episode count + first-air year.
 *
 * Inputs (both fetched at build time from this same source repo's stable
 * release-asset URLs):
 *   - L2 anitabi-index:
 *       https://github.com/Aniseekr/Aniseekr-source/releases/download/anitabi-index/anitabi-index.json
 *   - Previous cross-index (for incremental reuse — first run is cold and
 *     resolves every seed; subsequent runs only re-resolve seeds that
 *     weren't previously matched OR are new in L2):
 *       https://github.com/Aniseekr/Aniseekr-source/releases/download/anitabi-cross-index/anitabi-cross-index.json
 *
 * Output: anitabi-cross-index.json in CWD, validated against
 *   schemas/anitabi-cross-index.schema.json.
 *
 * Rate: AniList allows 90 req/min unauthenticated. We use ~1.1 s/req to
 * leave headroom for retries and avoid 429s.
 *
 * Flags:
 *   --force      Refetch every seed, ignoring the previous cross-index.
 *
 * Usage:
 *   bun scripts/build-anitabi-cross-index.ts
 *   bun scripts/build-anitabi-cross-index.ts --force
 *   ANILIST_DELAY_MS=2000 bun scripts/build-anitabi-cross-index.ts
 *
 * @see schemas/anitabi-cross-index.schema.json for the output contract.
 */

import { writeFileSync } from 'fs';
import { resolve } from 'path';

// ---------- constants ----------

const L2_URL =
  'https://github.com/Aniseekr/Aniseekr-source/releases/download/anitabi-index/anitabi-index.json';
const PREVIOUS_OUTPUT_URL =
  'https://github.com/Aniseekr/Aniseekr-source/releases/download/anitabi-cross-index/anitabi-cross-index.json';

const SCHEMA_URL =
  'https://github.com/Aniseekr/Aniseekr-source/raw/main/schemas/anitabi-cross-index.schema.json';

const ANILIST_ENDPOINT = 'https://graphql.anilist.co';

// Defaults to 1500 ms (40 req/min) — under the 90 req/min unauth ceiling but
// leaves enough headroom to absorb a few retries without tripping a 429
// burst. Override via the env var.
const ANILIST_DELAY_MS = Number(process.env.ANILIST_DELAY_MS ?? '1500');

// Max retries on HTTP 429 per seed before giving up and recording no_match.
// AniList's rate-limit window is 60 s; we honour the Retry-After header when
// present, falling back to 60 s otherwise.
const ANILIST_RETRY_LIMIT = Number(process.env.ANILIST_RETRY_LIMIT ?? '3');

const FORCE = process.argv.includes('--force');

const USER_AGENT = 'Aniseekr-source/1.0 (+https://github.com/Aniseekr/Aniseekr-source)';

const OUTPUT_DEFAULT = 'anitabi-cross-index.json';

// ---------- types (must match the JSON Schema) ----------

interface L2Entry {
  id: number;
  title: string;
  cn: string;
  episodes?: number | null;
  startYear?: number | null;
}

interface L2File {
  generatedAt: number;
  source: string;
  entries: L2Entry[];
}

type MatchType = 'exact_native' | 'top1_fallback' | 'manual' | 'no_match';

interface CrossIndexEntry {
  bangumiId: number;
  anilistId: number | null;
  malId: number | null;
  anilistPopularity: number | null;
  anilistEpisodes: number | null;
  anilistStartYear: number | null;
  titleJa: string;
  titleCn: string;
  titleRomaji: string | null;
  titleEnglish: string | null;
  matchType: MatchType;
  matchNote: string | null;
  resolvedAt: number;
}

interface CrossIndexFile {
  $schema: string;
  generatedAt: number;
  source: string;
  seedSize: number;
  entries: CrossIndexEntry[];
}

interface AniListHit {
  id: number;
  idMal: number | null;
  popularity: number | null;
  episodes: number | null;
  startDate: { year: number | null } | null;
  title: { romaji: string | null; english: string | null; native: string | null };
}

// ---------- AniList GraphQL ----------

const SEARCH_QUERY = `
  query ($search: String) {
    Page(perPage: 5) {
      media(search: $search, type: ANIME) {
        id
        idMal
        popularity
        episodes
        startDate { year }
        title { romaji english native }
      }
    }
  }
`;

/**
 * One AniList search call. Throws on HTTP error or GraphQL error. Caller
 * (`searchAniListWithRetry`) handles the 429 backoff loop.
 */
async function searchAniListOnce(
  keyword: string
): Promise<{ hits: AniListHit[]; status: number; retryAfterSec: number | null }> {
  const res = await fetch(ANILIST_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({ query: SEARCH_QUERY, variables: { search: keyword } }),
  });

  if (res.status === 429) {
    const ra = res.headers.get('retry-after');
    const retryAfterSec = ra ? Number(ra) : null;
    return { hits: [], status: 429, retryAfterSec: Number.isFinite(retryAfterSec) ? retryAfterSec : null };
  }
  if (!res.ok) {
    throw new Error(`AniList HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const json = (await res.json()) as {
    data?: { Page: { media: AniListHit[] } };
    errors?: unknown;
  };
  if (json.errors) {
    throw new Error(`AniList GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return { hits: json.data?.Page.media ?? [], status: 200, retryAfterSec: null };
}

/**
 * Retry on 429 honouring the Retry-After header (or 60 s fallback). After
 * `ANILIST_RETRY_LIMIT` consecutive 429s, throws — caller records no_match.
 */
async function searchAniList(keyword: string): Promise<AniListHit[]> {
  for (let attempt = 1; attempt <= ANILIST_RETRY_LIMIT; attempt++) {
    const result = await searchAniListOnce(keyword);
    if (result.status !== 429) return result.hits;
    if (attempt === ANILIST_RETRY_LIMIT) {
      throw new Error(`AniList HTTP 429 after ${ANILIST_RETRY_LIMIT} attempts`);
    }
    const wait = (result.retryAfterSec ?? 60) * 1000;
    process.stdout.write(`(429, sleeping ${wait / 1000}s) `);
    await delay(wait);
  }
  throw new Error('unreachable');
}

// ---------- title normalization + disambiguation ----------

function normalize(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(/[！]/g, '!')
    .replace(/[？]/g, '?')
    .replace(/[『』「」]/g, '')
    .replace(/[\s\-–—・　]+/g, '')
    .toLowerCase()
    .trim();
}

function cleanQuery(title: string): string {
  return title
    .replace(/[『』]/g, '')
    .replace(/シリーズ$/, '')
    .replace(/^劇場版/, '')
    .replace(/^映画/, '')
    .replace(/\([^)]*\)$/, '')
    .replace(/（[^）]*）$/, '')
    .trim();
}

interface DisambiguationInputs {
  titleJa: string;
  anitabiEpisodes: number | null;
  anitabiStartYear: number | null;
}

interface MatchPick {
  hit: AniListHit | null;
  type: MatchType;
  note: string | null;
}

/**
 * Pick from up to 5 AniList candidates:
 *   1. Prefer rows whose `title.native` equals the Bangumi Japanese title.
 *   2. Among ties, pick the one with the smallest combined diff in
 *      `episodes` and `startDate.year` vs the L2 anitabi columns.
 *   3. If 0 native-exact match, mark `top1_fallback` (top search hit).
 */
function pickMatch(inputs: DisambiguationInputs, hits: AniListHit[]): MatchPick {
  if (hits.length === 0) {
    return { hit: null, type: 'no_match', note: 'no_results' };
  }

  const targetJa = normalize(inputs.titleJa);
  const exact = hits.filter((h) => normalize(h.title.native) === targetJa);

  if (exact.length === 1) {
    return { hit: exact[0], type: 'exact_native', note: 'unique_native' };
  }

  if (exact.length > 1) {
    const ranked = [...exact].sort(
      (a, b) =>
        scoreByMeta(a, inputs) - scoreByMeta(b, inputs) ||
        (b.popularity ?? 0) - (a.popularity ?? 0)
    );
    return {
      hit: ranked[0],
      type: 'exact_native',
      note: `disambiguated_${exact.length}_by_meta`,
    };
  }

  return {
    hit: hits[0],
    type: 'top1_fallback',
    note: `top1_of_${hits.length}`,
  };
}

function scoreByMeta(hit: AniListHit, inputs: DisambiguationInputs): number {
  const MISSING_PENALTY = 100;
  let score = 0;
  if (inputs.anitabiEpisodes != null) {
    if (typeof hit.episodes === 'number') {
      score += Math.abs(hit.episodes - inputs.anitabiEpisodes);
    } else {
      score += MISSING_PENALTY;
    }
  }
  if (inputs.anitabiStartYear != null) {
    const year = hit.startDate?.year ?? null;
    if (typeof year === 'number') {
      score += Math.abs(year - inputs.anitabiStartYear);
    } else {
      score += MISSING_PENALTY;
    }
  }
  return score;
}

// ---------- input loading ----------

async function fetchJson<T>(url: string, label: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    });
    if (res.status === 404) {
      console.log(`[cross-index] ${label}: 404 (treating as empty)`);
      return null;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[cross-index] ${label} fetch failed:`, (err as Error).message);
    return null;
  }
}

function loadPreviousIntoMap(prev: CrossIndexFile | null): Map<number, CrossIndexEntry> {
  const map = new Map<number, CrossIndexEntry>();
  if (!prev || !Array.isArray(prev.entries)) return map;
  for (const entry of prev.entries) {
    if (typeof entry.bangumiId === 'number' && entry.bangumiId > 0) {
      map.set(entry.bangumiId, entry);
    }
  }
  return map;
}

// ---------- helpers ----------

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

function parseOutPath(): string {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--out=')) return arg.slice('--out='.length);
  }
  return OUTPUT_DEFAULT;
}

// ---------- main ----------

async function main(): Promise<void> {
  const l2 = await fetchJson<L2File>(L2_URL, 'L2 anitabi-index');
  if (!l2 || !Array.isArray(l2.entries) || l2.entries.length === 0) {
    throw new Error('L2 anitabi-index unavailable or empty — refusing to build a cross-index over zero seeds');
  }

  const previous = FORCE ? null : await fetchJson<CrossIndexFile>(PREVIOUS_OUTPUT_URL, 'previous cross-index');
  const cached = loadPreviousIntoMap(previous);

  const seeds = l2.entries;
  console.log(
    `[cross-index] ${seeds.length} L2 seeds, ${cached.size} cached rows from previous build (force=${FORCE})`
  );

  const out: CrossIndexEntry[] = [];
  let cachedCount = 0;
  let resolvedCount = 0;
  let missCount = 0;

  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i];

    // 1. Reuse a previously-resolved row when present and not a hard miss.
    const prev = cached.get(seed.id);
    if (prev && prev.matchType !== 'no_match' && !FORCE) {
      out.push(prev);
      cachedCount++;
      continue;
    }

    // 2. Hit AniList for new / previously-missed seeds.
    const query = cleanQuery(seed.title) || seed.title;
    process.stdout.write(
      `[${i + 1}/${seeds.length}] bgm#${seed.id} q=${JSON.stringify(query)} ... `
    );
    let hits: AniListHit[];
    try {
      hits = await searchAniList(query);
    } catch (err) {
      console.log(`ERR ${(err as Error).message}`);
      out.push({
        bangumiId: seed.id,
        anilistId: null,
        malId: null,
        anilistPopularity: null,
        anilistEpisodes: null,
        anilistStartYear: null,
        titleJa: seed.title,
        titleCn: seed.cn,
        titleRomaji: null,
        titleEnglish: null,
        matchType: 'no_match',
        matchNote: `http_error:${(err as Error).message}`,
        resolvedAt: Date.now(),
      });
      missCount++;
      await delay(ANILIST_DELAY_MS);
      continue;
    }

    const pick = pickMatch(
      {
        titleJa: seed.title,
        anitabiEpisodes: seed.episodes ?? null,
        anitabiStartYear: seed.startYear ?? null,
      },
      hits
    );

    if (pick.hit) {
      out.push({
        bangumiId: seed.id,
        anilistId: pick.hit.id,
        malId: pick.hit.idMal,
        anilistPopularity: pick.hit.popularity,
        anilistEpisodes: pick.hit.episodes,
        anilistStartYear: pick.hit.startDate?.year ?? null,
        titleJa: seed.title,
        titleCn: seed.cn,
        titleRomaji: pick.hit.title.romaji,
        titleEnglish: pick.hit.title.english,
        matchType: pick.type,
        matchNote: pick.note,
        resolvedAt: Date.now(),
      });
      console.log(`OK anilist#${pick.hit.id} (${pick.type})`);
      resolvedCount++;
    } else {
      out.push({
        bangumiId: seed.id,
        anilistId: null,
        malId: null,
        anilistPopularity: null,
        anilistEpisodes: null,
        anilistStartYear: null,
        titleJa: seed.title,
        titleCn: seed.cn,
        titleRomaji: null,
        titleEnglish: null,
        matchType: 'no_match',
        matchNote: pick.note,
        resolvedAt: Date.now(),
      });
      console.log(`MISS ${pick.note ?? 'no_match'}`);
      missCount++;
    }

    await delay(ANILIST_DELAY_MS);
  }

  out.sort((a, b) => a.bangumiId - b.bangumiId);

  const file: CrossIndexFile = {
    $schema: SCHEMA_URL,
    generatedAt: Date.now(),
    source: 'scripts/build-anitabi-cross-index.ts',
    seedSize: seeds.length,
    entries: out,
  };

  const outPath = resolve(process.cwd(), parseOutPath());
  writeFileSync(outPath, JSON.stringify(file), 'utf8');

  console.log(
    `\n[cross-index] wrote ${out.length} entries → ${outPath}\n` +
      `  cached:   ${cachedCount}\n` +
      `  resolved: ${resolvedCount} (new AniList hits)\n` +
      `  missed:   ${missCount}`
  );
}

main().catch((err: unknown) => {
  console.error('[cross-index] FATAL:', err);
  process.exit(1);
});
