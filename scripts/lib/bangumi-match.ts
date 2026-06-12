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
 *   2. year gate (unconditional when the manami year is known): keep
 *      |year − manamiYear| ≤ 1 — remakes share titles across decades, so even
 *      a sole candidate must clear it. Unknown-year candidates are kept —
 *      absence of data is not evidence.
 *   3. if still >1 and the manami type maps to platforms: keep matching or
 *      null-platform candidates
 *   4. exactly 1 left → match, else skip
 * Global pass — a bangumi id claimed by >1 entry (typical cause: a Specials/
 * movie entry carrying the base native title in its synonyms) is arbitrated:
 *   a. claimants whose year equals the subject year exactly; if that names a
 *      unique winner, award it
 *   b. then claimants whose type maps to a platform set CONTAINING the
 *      subject's platform (strict agreement beats no-constraint)
 *   c. still no unique winner → all claims dropped, never guess
 */

import type { BangumiAnimeSubject } from './bangumi-dump';
import { normalizeTitleKey } from './normalize-title';

export interface ManamiMatchInput {
  title: string;
  synonyms: readonly string[];
  year: number | null;
  /** manami `type`: TV | MOVIE | OVA | ONA | SPECIAL | UNKNOWN | null */
  type: string | null;
  /**
   * Record richness (e.g. count of extracted platform IDs). Used only to
   * pick a winner among upstream-DUPLICATE claimants (identical
   * title+year+type) — never to arbitrate genuinely different works.
   */
  weight?: number;
}

export interface MatchStats {
  matched: number;
  /** >1 candidate survived all filters — genuinely ambiguous, skipped. */
  ambiguous: number;
  /** The year gate eliminated every candidate — wrong-era hits, skipped. */
  filteredOut: number;
  noCandidate: number;
  collisionsArbitrated: number;
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

  const stats: MatchStats = {
    matched: 0,
    ambiguous: 0,
    filteredOut: 0,
    noCandidate: 0,
    collisionsArbitrated: 0,
    collisionsDropped: 0,
  };
  const provisional = new Map<number, number>(); // entry index → bangumi id
  const subjectsById = new Map(subjects.map((s) => [s.id, s]));

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
    // Unconditional: remakes share titles across decades — even a sole
    // candidate must be in the right era.
    if (entry.year !== null) {
      remaining = remaining.filter((s) => s.year === null || Math.abs(s.year - entry.year!) <= 1);
    }
    // The platform gate is disambiguation-only: a sole year-gate survivor is
    // accepted even when its platform disagrees with the manami type. Title
    // equality + matching era for the only Bangumi entry of that name is the
    // stronger signal (type labels drift between databases), and the
    // cross-index seed pass corrects any known mismatch downstream.
    const platforms = entry.type ? TYPE_TO_PLATFORMS[entry.type] : undefined;
    if (remaining.length > 1 && platforms) {
      remaining = remaining.filter((s) => s.platform === null || platforms.has(s.platform));
    }

    if (remaining.length === 1) {
      provisional.set(i, remaining[0].id);
    } else if (remaining.length === 0) {
      stats.filteredOut += 1;
    } else {
      stats.ambiguous += 1;
    }
  });

  // Collision pass. The dominant cause is a Specials/movie entry whose
  // synonyms carry the base native title and whose air year matches the
  // parent series — arbitrate before giving up.
  const claims = new Map<number, number[]>(); // bangumi id → entry indices
  for (const [i, id] of provisional) {
    const list = claims.get(id);
    if (list) {
      list.push(i);
    } else {
      claims.set(id, [i]);
    }
  }

  const matches = new Map<number, number>();
  for (const [id, claimants] of claims) {
    if (claimants.length === 1) {
      matches.set(claimants[0], id);
      continue;
    }
    const subject = subjectsById.get(id);
    let pool = claimants;

    // a. exact-year agreement
    if (subject?.year != null) {
      const exact = pool.filter((i) => entries[i].year === subject.year);
      if (exact.length === 1) {
        matches.set(exact[0], id);
        stats.collisionsArbitrated += 1;
        stats.collisionsDropped += claimants.length - 1;
        continue;
      }
      if (exact.length > 1) pool = exact;
    }

    // b. strict type/platform agreement beats no-constraint claimants
    if (subject?.platform != null) {
      const strict = pool.filter((i) => {
        const type = entries[i].type;
        const set = type ? TYPE_TO_PLATFORMS[type] : undefined;
        return set !== undefined && set.has(subject.platform!);
      });
      if (strict.length === 1) {
        matches.set(strict[0], id);
        stats.collisionsArbitrated += 1;
        stats.collisionsDropped += claimants.length - 1;
        continue;
      }
    }

    // c. upstream duplicates: identical normalized title + year + type means
    //    the claimants ARE the same work (manami occasionally ships unmerged
    //    twins) — award to the richest record instead of dropping the match.
    const signature = (i: number) =>
      `${normalizeTitleKey(entries[i].title)}|${entries[i].year ?? ''}|${entries[i].type ?? ''}`;
    const firstSig = signature(pool[0]);
    if (pool.length > 1 && pool.every((i) => signature(i) === firstSig)) {
      let winner = pool[0];
      for (const i of pool) {
        if ((entries[i].weight ?? 0) > (entries[winner].weight ?? 0)) winner = i;
      }
      matches.set(winner, id);
      stats.collisionsArbitrated += 1;
      stats.collisionsDropped += claimants.length - 1;
      continue;
    }

    // d. no unique winner — drop every claim rather than guess.
    stats.collisionsDropped += claimants.length;
  }
  stats.matched = matches.size;
  return { matches, stats };
}
