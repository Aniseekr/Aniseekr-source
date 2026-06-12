import { describe, expect, it } from 'bun:test';
import { matchManamiToBangumi, type ManamiMatchInput } from '../scripts/lib/bangumi-match';
import type { BangumiAnimeSubject } from '../scripts/lib/bangumi-dump';

const subj = (
  s: Partial<BangumiAnimeSubject> & { id: number; name: string }
): BangumiAnimeSubject => ({
  nameCn: null,
  year: null,
  platform: null,
  ...s,
});
const entry = (e: Partial<ManamiMatchInput> & { title: string }): ManamiMatchInput => ({
  synonyms: [],
  year: null,
  type: null,
  ...e,
});

describe('matchManamiToBangumi', () => {
  it('matches a unique native-title hit via synonyms', () => {
    const { matches } = matchManamiToBangumi(
      [entry({ title: 'Attack on Titan', synonyms: ['進撃の巨人'], year: 2013 })],
      [subj({ id: 23686, name: '進撃の巨人', year: 2013, platform: 1 })]
    );
    expect(matches.get(0)).toBe(23686);
  });

  it('disambiguates same-name entries by year ±1', () => {
    const subjects = [
      subj({ id: 10, name: 'ハンター×ハンター', year: 1999, platform: 1 }),
      subj({ id: 11, name: 'ハンター×ハンター', year: 2011, platform: 1 }),
    ];
    const { matches } = matchManamiToBangumi(
      [
        entry({
          title: 'Hunter x Hunter (2011)',
          synonyms: ['ハンター×ハンター'],
          year: 2011,
          type: 'TV',
        }),
      ],
      subjects
    );
    expect(matches.get(0)).toBe(11);
  });

  it('disambiguates TV vs movie by type when years tie', () => {
    const subjects = [
      subj({ id: 20, name: '君の名は。', year: 2016, platform: 3 }),
      subj({ id: 21, name: '君の名は。', year: 2016, platform: 1 }),
    ];
    const { matches } = matchManamiToBangumi(
      [entry({ title: 'Kimi no Na wa.', synonyms: ['君の名は。'], year: 2016, type: 'MOVIE' })],
      subjects
    );
    expect(matches.get(0)).toBe(20);
  });

  it('skips when ambiguity survives the filters', () => {
    const subjects = [
      subj({ id: 30, name: '同名', year: 2020, platform: 1 }),
      subj({ id: 31, name: '同名', year: 2020, platform: 1 }),
    ];
    const { matches, stats } = matchManamiToBangumi(
      [entry({ title: '同名', year: 2020, type: 'TV' })],
      subjects
    );
    expect(matches.size).toBe(0);
    expect(stats.ambiguous).toBe(1);
  });

  it('accepts a sole year-gate survivor even when the type disagrees (documented tradeoff)', () => {
    // Platform gate is disambiguation-only: type labels drift between
    // databases, so the only same-era Bangumi entry of that name wins.
    const subjects = [subj({ id: 60, name: '唯一の作品', year: 2023, platform: 3 })];
    const { matches } = matchManamiToBangumi(
      [entry({ title: '唯一の作品', year: 2023, type: 'ONA' })],
      subjects
    );
    expect(matches.get(0)).toBe(60);
  });

  it('counts wrong-era eliminations as filteredOut, not ambiguous', () => {
    const subjects = [subj({ id: 61, name: 'リメイク元', year: 1985, platform: 1 })];
    const { matches, stats } = matchManamiToBangumi(
      [entry({ title: 'リメイク元', year: 2024, type: 'TV' })],
      subjects
    );
    expect(matches.size).toBe(0);
    expect(stats.filteredOut).toBe(1);
    expect(stats.ambiguous).toBe(0);
  });

  it('matches through name_cn too', () => {
    const { matches } = matchManamiToBangumi(
      [entry({ title: '葬送的芙莉蓮' })],
      [subj({ id: 40, name: '葬送のフリーレン', nameCn: '葬送的芙莉蓮' })]
    );
    expect(matches.get(0)).toBe(40);
  });

  it('drops a bangumi id claimed by two different entries', () => {
    const subjects = [subj({ id: 50, name: 'かぶり' })];
    const { matches, stats } = matchManamiToBangumi(
      [entry({ title: 'かぶり' }), entry({ title: 'カブリ', synonyms: ['かぶり'] })],
      subjects
    );
    expect(matches.size).toBe(0);
    expect(stats.collisionsDropped).toBe(2);
  });

  it('arbitrates a collision toward strict type/platform agreement (TV beats SPECIAL)', () => {
    // FMA:B pattern: the Specials entry shares the base native title via
    // synonyms and the same air year — the TV entry must win the TV subject.
    const subjects = [
      subj({ id: 1428, name: '鋼の錬金術師 FULLMETAL ALCHEMIST', year: 2009, platform: 1 }),
    ];
    const { matches, stats } = matchManamiToBangumi(
      [
        entry({
          title: 'Fullmetal Alchemist: Brotherhood',
          synonyms: ['鋼の錬金術師 FULLMETAL ALCHEMIST'],
          year: 2009,
          type: 'TV',
        }),
        entry({
          title: 'Fullmetal Alchemist: Brotherhood Specials',
          synonyms: ['鋼の錬金術師 FULLMETAL ALCHEMIST'],
          year: 2009,
          type: 'SPECIAL',
        }),
      ],
      subjects
    );
    expect(matches.get(0)).toBe(1428);
    expect(matches.has(1)).toBe(false);
    expect(stats.collisionsArbitrated).toBe(1);
  });

  it('awards upstream-duplicate claimants (same title+year+type) to the richest record', () => {
    // manami carries occasional unmerged duplicates (e.g. two "One Piece"
    // TV/1999 entries, one without anilist/mal sources). Identical
    // title+year+type = the same work — not an ambiguity.
    const subjects = [subj({ id: 975, name: 'ONE PIECE', year: 1999, platform: 1 })];
    const { matches, stats } = matchManamiToBangumi(
      [
        entry({ title: 'One Piece', synonyms: ['ONE PIECE'], year: 1999, type: 'TV', weight: 6 }),
        entry({ title: 'One Piece', synonyms: ['ONE PIECE'], year: 1999, type: 'TV', weight: 1 }),
      ],
      subjects
    );
    expect(matches.get(0)).toBe(975);
    expect(matches.has(1)).toBe(false);
    expect(stats.collisionsArbitrated).toBe(1);
  });

  it('arbitrates a collision toward the exact-year claimant', () => {
    const subjects = [subj({ id: 975, name: 'ONE PIECE', year: 1999, platform: 1 })];
    const { matches } = matchManamiToBangumi(
      [
        entry({ title: 'One Piece', synonyms: ['ONE PIECE'], year: 1999, type: 'TV' }),
        entry({ title: 'One Piece Special', synonyms: ['ONE PIECE'], year: 2005, type: 'TV' }),
      ],
      subjects
    );
    expect(matches.get(0)).toBe(975);
    expect(matches.has(1)).toBe(false);
  });
});
