import { describe, expect, it } from 'bun:test';
import {
  spotEntryFromRawPoint,
  topBangumiIdsByPoints,
  round6,
} from '../scripts/lib/anitabi-points-build';

describe('spotEntryFromRawPoint', () => {
  it('keeps a point with valid geo + image, rounding coords to 6dp', () => {
    const out = spotEntryFromRawPoint(
      {
        id: 'pt1',
        name: '宇治橋',
        cn: '宇治桥',
        image: '/images/points/115908/pt1.jpg',
        geo: [34.8912345678, 135.8012345678],
      },
      115908
    );
    expect(out).toEqual({
      id: 'pt1',
      b: 115908,
      lat: 34.891235,
      lng: 135.801235,
      n: '宇治橋',
      c: '宇治桥',
      img: '/images/points/115908/pt1.jpg',
    });
  });

  it('drops points with no image, no id, no name, or invalid geo', () => {
    expect(spotEntryFromRawPoint({ id: 'a', name: 'x', geo: [35, 139] }, 1)).toBeNull(); // no image
    expect(
      spotEntryFromRawPoint({ id: '', name: 'x', image: '/i.jpg', geo: [35, 139] }, 1)
    ).toBeNull(); // no id
    expect(
      spotEntryFromRawPoint({ id: 'a', name: '', image: '/i.jpg', geo: [35, 139] }, 1)
    ).toBeNull(); // no name
    expect(
      spotEntryFromRawPoint({ id: 'a', name: 'x', image: '/i.jpg', geo: [0, 0] }, 1)
    ).toBeNull(); // 0,0 geo
    expect(
      spotEntryFromRawPoint({ id: 'a', name: 'x', image: '/i.jpg', geo: [200, 0] }, 1)
    ).toBeNull(); // out of range
    expect(
      spotEntryFromRawPoint({ id: 'a', name: 'x', image: '/i.jpg' }, 1)
    ).toBeNull(); // no geo
  });

  it('defaults cn to empty string and trims strings', () => {
    const out = spotEntryFromRawPoint(
      { id: ' pt2 ', name: ' 駅前 ', image: ' /i.jpg ', geo: [35.1, 139.2] },
      42
    );
    expect(out).toEqual({ id: 'pt2', b: 42, lat: 35.1, lng: 139.2, n: '駅前', c: '', img: '/i.jpg' });
  });
});

describe('topBangumiIdsByPoints', () => {
  it('returns the highest-pointsLength ids, capped at limit, id-stable on ties', () => {
    const entries = [
      { id: 10, pointsLength: 5 },
      { id: 20, pointsLength: 100 },
      { id: 30, pointsLength: 100 },
      { id: 40, pointsLength: null },
      { id: 50, pointsLength: 7 },
    ];
    expect(topBangumiIdsByPoints(entries, 3)).toEqual([20, 30, 50]);
  });

  it('treats missing pointsLength as 0 and never exceeds available entries', () => {
    expect(topBangumiIdsByPoints([{ id: 1 }], 10)).toEqual([1]);
  });
});

describe('round6', () => {
  it('rounds to 6 decimal places', () => {
    expect(round6(34.123456789)).toBe(34.123457);
  });
});
