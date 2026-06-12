import { describe, expect, it } from 'bun:test';
import { parseSubjectLine, pickNewestDumpAsset } from '../scripts/lib/bangumi-dump';

describe('pickNewestDumpAsset', () => {
  it('picks the lexicographically newest dump-*.zip', () => {
    const assets = [
      { name: 'dump-2026-05-26.210457Z.zip', browser_download_url: 'u1' },
      { name: 'dump-2026-06-09.210424Z.zip', browser_download_url: 'u2' },
      { name: 'dump-2026-06-09.210424Z.7z', browser_download_url: 'u3' },
      { name: 'dump-2026-06-02.210429Z.zip', browser_download_url: 'u4' },
    ];
    expect(pickNewestDumpAsset(assets)?.browser_download_url).toBe('u2');
  });

  it('returns null when no zip asset matches', () => {
    expect(pickNewestDumpAsset([{ name: 'readme.md', browser_download_url: 'x' }])).toBeNull();
  });
});

describe('parseSubjectLine', () => {
  it('extracts an anime subject', () => {
    const line = JSON.stringify({
      id: 8,
      type: 2,
      name: 'コードギアス 反逆のルルーシュR2',
      name_cn: 'Code Geass 反叛的鲁路修R2',
      date: '2008-04-06',
      platform: 1,
    });
    expect(parseSubjectLine(line)).toEqual({
      id: 8,
      name: 'コードギアス 反逆のルルーシュR2',
      nameCn: 'Code Geass 反叛的鲁路修R2',
      year: 2008,
      platform: 1,
    });
  });

  it('rejects non-anime, invalid ids, and handles missing date/name_cn', () => {
    expect(parseSubjectLine(JSON.stringify({ id: 1, type: 1, name: 'x' }))).toBeNull();
    expect(parseSubjectLine(JSON.stringify({ id: 0, type: 2, name: 'x' }))).toBeNull();
    expect(parseSubjectLine('not json')).toBeNull();
    expect(
      parseSubjectLine(JSON.stringify({ id: 9, type: 2, name: 'y', name_cn: '', date: '' }))
    ).toEqual({ id: 9, name: 'y', nameCn: null, year: null, platform: null });
  });

  it('nullifies garbage platform values', () => {
    expect(
      parseSubjectLine(JSON.stringify({ id: 7, type: 2, name: 'z', platform: 2006 }))
    ).toEqual({ id: 7, name: 'z', nameCn: null, year: null, platform: null });
  });
});
