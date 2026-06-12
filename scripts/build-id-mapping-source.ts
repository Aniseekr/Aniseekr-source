#!/usr/bin/env bun
/**
 * Build merged anime ID mapping source.
 *
 * Sources, in join order:
 *   1. Fribb (anime-list-mini.json) × manami-project (minified) — outer-join
 *      on AniDB ID; Fribb values win where both define a field.
 *   2. Bangumi Archive weekly dump (subject.jsonlines, type=2) — offline
 *      title match (normalized native/Chinese name, ±1 year, platform/type
 *      compat; ambiguity → skip) contributes `bangumi_id` + `name_cn`.
 *      NOTE: neither Fribb nor manami carries Bangumi or Shikimori IDs — the
 *      historical sources[] regexes for them matched nothing, ever.
 *   3. anitabi-cross-index (this repo's release; AniList-verified
 *      bangumiId↔anilist/mal pairs) — authoritative seeds, win over a
 *      disagreeing title match.
 *
 * A coverage gate fails the build when bangumi_id / name_cn coverage drops
 * below the calibrated floors — a silent return to 0% must never ship again.
 *
 * Output: anime-id-mappings-merged.json (minified) in CWD.
 *
 * Run locally:   bun scripts/build-id-mapping-source.ts
 *                BANGUMI_DUMP_PATH=/tmp/dump.zip bun scripts/build-id-mapping-source.ts
 * Run in CI:     see .github/workflows/build-id-mapping.yml
 */

import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { downloadLatestDump, loadAnimeSubjects } from './lib/bangumi-dump';
import { matchManamiToBangumi, type ManamiMatchInput } from './lib/bangumi-match';

const FRIBB_URL =
  'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json';
// manami-project switched from in-repo JSON to weekly tagged GitHub Releases
// (e.g. tag "2026-14"). `releases/latest/download/*` is a stable redirect to
// whatever the most recent weekly release is — Bun's fetch follows 302s.
const MANAMI_URL =
  'https://github.com/manami-project/anime-offline-database/releases/latest/download/anime-offline-database-minified.json';

const CROSS_INDEX_URL =
  'https://github.com/Aniseekr/Aniseekr-source/releases/download/anitabi-cross-index/anitabi-cross-index.json';

const OUTPUT = 'anime-id-mappings-merged.json';

// Coverage floors among rows that carry an anilist_id. Calibrated against the
// 2026-06-09 Archive dump (measured: bangumi_id 41.2%, name_cn 34.6%) — set
// to roughly half the measured value. Their job is to catch a silent
// regression toward 0% (the pre-2026-06 state), not to enforce precision.
const BANGUMI_FLOOR_PCT = 20;
const NAME_CN_FLOOR_PCT = 17;

// All platform-ID columns we care about. anidb_id is the join key but is
// also kept on the merged record for future re-joins.
const ID_COLUMNS = [
  'mal_id',
  'anilist_id',
  'kitsu_id',
  'bangumi_id',
  'shikimori_id',
  'simkl_id',
  'annict_id',
  'anidb_id',
  'thetvdb_id',
  'themoviedb_id',
  'livechart_id',
  'anime_planet_id',
  'anisearch_id',
  'notify_moe_id',
] as const;

type IdColumn = (typeof ID_COLUMNS)[number];

type MergedRecord = Partial<Record<IdColumn, number | string>> & { name_cn?: string };

/** Fields propagated by mergeInto — the ID columns plus the Chinese title. */
const MERGE_FIELDS = [...ID_COLUMNS, 'name_cn'] as const;

interface FribbEntry {
  mal_id?: number;
  anilist_id?: number;
  kitsu_id?: number;
  anidb_id?: number;
  shikimori_id?: number;
  simkl_id?: number;
  annict_id?: number;
  thetvdb_id?: number;
  themoviedb_id?: number;
  livechart_id?: number;
  'anime-planet_id'?: string;
  anisearch_id?: number;
  'notify.moe_id'?: string;
  type?: string;
}

interface ManamiEntry {
  sources?: string[];
  title?: string;
  synonyms?: string[];
  animeSeason?: { season?: string; year?: number };
  type?: string;
}

interface CrossIndexEntry {
  bangumiId: number;
  anilistId: number | null;
  malId: number | null;
  titleCn: string;
}

interface ManamiFile {
  data?: ManamiEntry[];
}

const SOURCE_PATTERNS: Array<{
  re: RegExp;
  col: IdColumn;
  numeric: boolean;
}> = [
  { re: /bangumi\.tv\/subject\/(\d+)/i, col: 'bangumi_id', numeric: true },
  { re: /anilist\.co\/anime\/(\d+)/i, col: 'anilist_id', numeric: true },
  { re: /myanimelist\.net\/anime\/(\d+)/i, col: 'mal_id', numeric: true },
  { re: /anidb\.net\/anime\/(\d+)/i, col: 'anidb_id', numeric: true },
  { re: /kitsu\.io\/anime\/(\d+)/i, col: 'kitsu_id', numeric: true },
  { re: /shikimori\.one\/animes\/(\d+)/i, col: 'shikimori_id', numeric: true },
  { re: /simkl\.com\/anime\/(\d+)/i, col: 'simkl_id', numeric: true },
  { re: /livechart\.me\/anime\/(\d+)/i, col: 'livechart_id', numeric: true },
  { re: /notify\.moe\/anime\/(\S+)/i, col: 'notify_moe_id', numeric: false },
];

async function fetchJson<T>(url: string): Promise<T> {
  console.log(`[build-id-mapping] GET ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

function extractIdsFromManami(entry: ManamiEntry): MergedRecord {
  const out: MergedRecord = {};
  for (const url of entry.sources ?? []) {
    for (const { re, col, numeric } of SOURCE_PATTERNS) {
      if (out[col] !== undefined) continue;
      const m = url.match(re);
      if (!m) continue;
      out[col] = numeric ? Number(m[1]) : m[1];
    }
  }
  return out;
}

function normalizeFribbEntry(e: FribbEntry): MergedRecord {
  const out: MergedRecord = {};
  if (typeof e.mal_id === 'number') out.mal_id = e.mal_id;
  if (typeof e.anilist_id === 'number') out.anilist_id = e.anilist_id;
  if (typeof e.kitsu_id === 'number') out.kitsu_id = e.kitsu_id;
  if (typeof e.anidb_id === 'number') out.anidb_id = e.anidb_id;
  if (typeof e.shikimori_id === 'number') out.shikimori_id = e.shikimori_id;
  if (typeof e.simkl_id === 'number') out.simkl_id = e.simkl_id;
  if (typeof e.annict_id === 'number') out.annict_id = e.annict_id;
  if (typeof e.thetvdb_id === 'number') out.thetvdb_id = e.thetvdb_id;
  if (typeof e.themoviedb_id === 'number') out.themoviedb_id = e.themoviedb_id;
  if (typeof e.livechart_id === 'number') out.livechart_id = e.livechart_id;
  if (typeof e['anime-planet_id'] === 'string')
    out.anime_planet_id = e['anime-planet_id'];
  if (typeof e.anisearch_id === 'number') out.anisearch_id = e.anisearch_id;
  if (typeof e['notify.moe_id'] === 'string') out.notify_moe_id = e['notify.moe_id'];
  return out;
}

function mergeInto(dst: MergedRecord, src: MergedRecord): void {
  for (const col of MERGE_FIELDS) {
    if (dst[col] === undefined && src[col] !== undefined) {
      (dst as Record<string, number | string>)[col] = src[col] as number | string;
    }
  }
}

function dedupeByPriority(records: MergedRecord[]): MergedRecord[] {
  // Outer-join key is anidb_id. Records without anidb_id are kept as singletons
  // (they cannot be joined, but still carry useful IDs we want to ship).
  const byAnidb = new Map<number, MergedRecord>();
  const orphans: MergedRecord[] = [];

  for (const r of records) {
    const key = r.anidb_id;
    if (typeof key === 'number') {
      const existing = byAnidb.get(key);
      if (existing) {
        mergeInto(existing, r);
      } else {
        byAnidb.set(key, { ...r });
      }
    } else {
      // Keep but cannot be merged with manami via the join key.
      orphans.push({ ...r });
    }
  }
  return [...byAnidb.values(), ...orphans];
}

function reportCoverage(records: MergedRecord[]): void {
  const total = records.length;
  console.log(`\n=== Coverage report (${total} records) ===`);
  for (const col of MERGE_FIELDS) {
    let present = 0;
    for (const r of records) {
      if (r[col] !== undefined && r[col] !== null) present++;
    }
    const pct = total > 0 ? ((present / total) * 100).toFixed(2) : '0.00';
    console.log(`  ${col.padEnd(18)} ${present.toString().padStart(7)} / ${total} (${pct}%)`);
  }
}

/**
 * Coverage is measured against rows that carry an anilist_id — those are the
 * rows the app's AniList-backed screens actually resolve titles for.
 * Below-floor coverage refuses to publish: shipping a dataset that silently
 * regressed to no Chinese titles is exactly the failure this gate exists for.
 */
function enforceCoverageGate(records: MergedRecord[]): void {
  const withAnilist = records.filter((r) => r.anilist_id !== undefined);
  const pct = (n: number) => (withAnilist.length > 0 ? (n / withAnilist.length) * 100 : 0);
  const bangumiPct = pct(withAnilist.filter((r) => r.bangumi_id !== undefined).length);
  const nameCnPct = pct(withAnilist.filter((r) => r.name_cn !== undefined).length);
  console.log(
    `\n[gate] of ${withAnilist.length} anilist rows: bangumi_id ${bangumiPct.toFixed(1)}% ` +
      `(floor ${BANGUMI_FLOOR_PCT}%), name_cn ${nameCnPct.toFixed(1)}% (floor ${NAME_CN_FLOOR_PCT}%)`
  );
  if (bangumiPct < BANGUMI_FLOOR_PCT || nameCnPct < NAME_CN_FLOOR_PCT) {
    console.error('[gate] FAIL — bangumi/name_cn coverage regressed; refusing to publish.');
    process.exit(1);
  }
}

/** Fetch the cross-index seeds; tolerate failure — it's an enhancement layer. */
async function fetchCrossIndexSeeds(): Promise<CrossIndexEntry[]> {
  try {
    const file = await fetchJson<{ entries?: CrossIndexEntry[] }>(CROSS_INDEX_URL);
    return (file.entries ?? []).filter(
      (e) => typeof e.bangumiId === 'number' && e.bangumiId > 0
    );
  } catch (err) {
    console.warn('[build-id-mapping] cross-index unavailable, continuing without seeds:', err);
    return [];
  }
}

async function main() {
  const [fribbRaw, manamiRaw, crossSeeds] = await Promise.all([
    fetchJson<FribbEntry[]>(FRIBB_URL),
    fetchJson<ManamiFile>(MANAMI_URL),
    fetchCrossIndexSeeds(),
  ]);

  console.log(`[build-id-mapping] Fribb entries: ${fribbRaw.length}`);
  console.log(`[build-id-mapping] Manami entries: ${manamiRaw.data?.length ?? 0}`);
  console.log(`[build-id-mapping] Cross-index seeds: ${crossSeeds.length}`);

  const dumpPath = await downloadLatestDump(resolve(process.cwd(), 'bangumi-dump.zip'));
  const subjects = await loadAnimeSubjects(dumpPath);
  const subjectById = new Map(subjects.map((s) => [s.id, s]));

  const fribbRecords = fribbRaw.map(normalizeFribbEntry);
  const manamiEntries = manamiRaw.data ?? [];
  const manamiRecords = manamiEntries.map(extractIdsFromManami);

  // Title-match each manami entry against the Archive BEFORE the merge, while
  // titles/synonyms are still attached.
  const matchInputs: ManamiMatchInput[] = manamiEntries.map((e, i) => ({
    title: e.title ?? '',
    synonyms: e.synonyms ?? [],
    year: typeof e.animeSeason?.year === 'number' ? e.animeSeason.year : null,
    type: e.type ?? null,
    // Richness for upstream-duplicate arbitration: how many platform IDs the
    // sources[] regexes extracted for this entry.
    weight: Object.keys(manamiRecords[i]).length,
  }));
  const { matches, stats } = matchManamiToBangumi(matchInputs, subjects);
  for (const [i, bangumiId] of matches) {
    const record = manamiRecords[i];
    record.bangumi_id = bangumiId;
    const nameCn = subjectById.get(bangumiId)?.nameCn;
    if (nameCn) record.name_cn = nameCn;
  }
  console.log(
    `[build-id-mapping] Archive title match: ${stats.matched} matched, ` +
      `${stats.ambiguous} ambiguous, ${stats.noCandidate} no-candidate, ` +
      `${stats.collisionsDropped} collision-dropped`
  );

  // Order matters: Fribb first → its values win when both sides define a field.
  const merged = dedupeByPriority([...fribbRecords, ...manamiRecords]);

  // Cross-index seeds are AniList-verified pairs — they win over a
  // disagreeing title match and reach Fribb-only records the matcher can't.
  const byAnilist = new Map<number, CrossIndexEntry>();
  const byMal = new Map<number, CrossIndexEntry>();
  for (const e of crossSeeds) {
    if (typeof e.anilistId === 'number') byAnilist.set(e.anilistId, e);
    if (typeof e.malId === 'number') byMal.set(e.malId, e);
  }
  let seeded = 0;
  let disagreements = 0;
  for (const record of merged) {
    const seed =
      (typeof record.anilist_id === 'number' ? byAnilist.get(record.anilist_id) : undefined) ??
      (typeof record.mal_id === 'number' ? byMal.get(record.mal_id) : undefined);
    if (seed) {
      if (record.bangumi_id !== undefined && record.bangumi_id !== seed.bangumiId) {
        disagreements += 1;
        delete record.name_cn; // judged for the wrong subject
      }
      if (record.bangumi_id !== seed.bangumiId) seeded += 1;
      record.bangumi_id = seed.bangumiId;
    }
    if (record.bangumi_id !== undefined && record.name_cn === undefined) {
      const fromArchive = subjectById.get(record.bangumi_id as number)?.nameCn;
      const fromSeed = seed?.titleCn?.trim();
      const nameCn = fromArchive ?? (fromSeed && fromSeed.length > 0 ? fromSeed : undefined);
      if (nameCn) record.name_cn = nameCn;
    }
  }
  console.log(
    `[build-id-mapping] Cross-index: ${seeded} records seeded/corrected, ` +
      `${disagreements} title-match disagreements overridden`
  );

  reportCoverage(merged);
  enforceCoverageGate(merged);

  const outPath = resolve(process.cwd(), OUTPUT);
  writeFileSync(outPath, JSON.stringify(merged));
  console.log(`\n[build-id-mapping] Wrote ${merged.length} records → ${outPath}`);
}

main().catch((err) => {
  console.error('[build-id-mapping] FATAL', err);
  process.exit(1);
});
