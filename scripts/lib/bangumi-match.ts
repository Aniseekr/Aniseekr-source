/**
 * Offline manami → Bangumi subject matcher.
 *
 * Acceptance is strict (mirrors the app's runtime bangumi-title-match): a
 * candidate counts only when one of its names equals one of the entry's
 * titles after normalization, and any surviving ambiguity means NO match —
 * a wrong bangumi_id would hang another anime's Chinese title on the record.
 *
 * Filter order per entry:
 *   1. candidate set = index hits for normalize(title) + normalize(synonyms)
 *      over Bangumi `name` AND `name_cn`
 *   2. if >1 and the manami year is known: keep |year − manamiYear| ≤ 1
 *      (unknown-year candidates are kept — absence of data is not evidence)
 *   3. if still >1 and the manami type maps to platforms: keep matching or
 *      null-platform candidates
 *   4. exactly 1 left → match, else skip
 * Global pass: a bangumi id claimed by >1 entry → all claims dropped.
 */

import type { BangumiAnimeSubject } from './bangumi-dump';
import { normalizeTitleKey } from './normalize-title';

export interface ManamiMatchInput {
  title: string;
  synonyms: readonly string[];
  year: number | null;
  /** manami `type`: TV | MOVIE | OVA | ONA | SPECIAL | UNKNOWN | null */
  type: string | null;
}

export interface MatchStats {
  matched: number;
  ambiguous: number;
  noCandidate: number;
  collisionsDropped: number;
}

/** manami type → acceptable Bangumi platforms (null platform always passes). */
const TYPE_TO_PLATFORMS: Record<string, ReadonlySet<number>> = {
  TV: new Set([1]),
  MOVIE: new Set([3]),
  OVA: new Set([2]),
  ONA: new Set([5]),
  // SPECIAL / UNKNOWN: Bangumi has no dedicated platform — no constraint.
};

export function matchManamiToBangumi(
  entries: readonly ManamiMatchInput[],
  subjects: readonly BangumiAnimeSubject[]
): { matches: Map<number, number>; stats: MatchStats } {
  // Index native names and Chinese names; a key may collide across subjects.
  const index = new Map<string, BangumiAnimeSubject[]>();
  const add = (key: string, s: BangumiAnimeSubject) => {
    if (!key) return;
    const list = index.get(key);
    if (list) {
      if (!list.includes(s)) list.push(s);
    } else {
      index.set(key, [s]);
    }
  };
  for (const s of subjects) {
    add(normalizeTitleKey(s.name), s);
    if (s.nameCn) add(normalizeTitleKey(s.nameCn), s);
  }

  const stats: MatchStats = { matched: 0, ambiguous: 0, noCandidate: 0, collisionsDropped: 0 };
  const provisional = new Map<number, number>(); // entry index → bangumi id

  entries.forEach((entry, i) => {
    const keys = new Set<string>();
    keys.add(normalizeTitleKey(entry.title));
    for (const syn of entry.synonyms) keys.add(normalizeTitleKey(syn));
    keys.delete('');

    const candidates = new Map<number, BangumiAnimeSubject>();
    for (const key of keys) {
      for (const s of index.get(key) ?? []) candidates.set(s.id, s);
    }
    if (candidates.size === 0) {
      stats.noCandidate += 1;
      return;
    }

    let remaining = [...candidates.values()];
    if (remaining.length > 1 && entry.year !== null) {
      remaining = remaining.filter((s) => s.year === null || Math.abs(s.year - entry.year!) <= 1);
    }
    const platforms = entry.type ? TYPE_TO_PLATFORMS[entry.type] : undefined;
    if (remaining.length > 1 && platforms) {
      remaining = remaining.filter((s) => s.platform === null || platforms.has(s.platform));
    }

    if (remaining.length === 1) {
      provisional.set(i, remaining[0].id);
    } else {
      stats.ambiguous += 1;
    }
  });

  // A bangumi id claimed by two entries means at least one claim is wrong —
  // drop them all rather than guess which one is right.
  const claimCount = new Map<number, number>();
  for (const id of provisional.values()) claimCount.set(id, (claimCount.get(id) ?? 0) + 1);
  const matches = new Map<number, number>();
  for (const [i, id] of provisional) {
    if (claimCount.get(id) === 1) {
      matches.set(i, id);
    } else {
      stats.collisionsDropped += 1;
    }
  }
  stats.matched = matches.size;
  return { matches, stats };
}
