// Tests the fetch/retry/loop orchestration in scripts/build-anitabi-points.ts
// via an injectable fetch (FetchLike) + injectable delay (DelayLike), so no
// real network call or real timer ever runs. Filtering itself
// (spotEntryFromRawPoint / topBangumiIdsByPoints) is already covered by
// tests/anitabi-points-build.test.ts — these tests exercise the new
// orchestration: 404 skip, 403 abort (no retry), transient-error retry x3,
// per-anime top-N snapshot capture, and single-pass doc assembly.

import { describe, expect, it } from 'bun:test';
import { runPointsLoop, WafBlockedError } from '../scripts/build-anitabi-points';
import type { RawPoint } from '../scripts/lib/anitabi-points-build';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

const noDelay = async (_ms: number) => {};

const POINT_A: RawPoint = {
  id: 'pt-a',
  name: 'A地',
  cn: 'A地',
  image: '/images/points/a.jpg',
  geo: [35.0, 135.0],
};
const POINT_B: RawPoint = {
  id: 'pt-b',
  name: 'B地',
  image: '/images/points/b.jpg',
  geo: [36.0, 136.0],
};
// Filtered out by spotEntryFromRawPoint (no image).
const POINT_NO_IMAGE: RawPoint = { id: 'pt-c', name: 'C地', geo: [37.0, 137.0] };

describe('runPointsLoop', () => {
  it('fetches every seed, filters points via spotEntryFromRawPoint, and captures raw payloads only for topIds', async () => {
    const calls: number[] = [];
    const fetchImpl = async (url: string) => {
      const id = Number(url.match(/bangumi\/(\d+)\/points/)?.[1]);
      calls.push(id);
      if (id === 1) return jsonResponse(200, { points: [POINT_A, POINT_NO_IMAGE] });
      if (id === 2) return jsonResponse(200, { points: [POINT_B] });
      return jsonResponse(404, {});
    };

    const seeds = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const result = await runPointsLoop(seeds, new Set([1]), fetchImpl, 0, noDelay);

    expect(calls).toEqual([1, 2, 3]);
    expect(result.fetched).toBe(2);
    expect(result.skipped).toBe(1); // id 3 → 404
    expect(result.spots).toHaveLength(2); // POINT_NO_IMAGE dropped
    expect(result.spots.map((s) => s.id).sort()).toEqual(['pt-a', 'pt-b']);
    expect(Object.keys(result.byBangumiId)).toEqual(['1']); // only topIds captured
    expect(result.byBangumiId['1']).toEqual([POINT_A, POINT_NO_IMAGE]);
  });

  it('skips (does not abort) on 404', async () => {
    const fetchImpl = async () => jsonResponse(404, {});
    const result = await runPointsLoop([{ id: 42 }], new Set(), fetchImpl, 0, noDelay);
    expect(result.skipped).toBe(1);
    expect(result.fetched).toBe(0);
    expect(result.spots).toEqual([]);
  });

  it('aborts immediately on 403 without retrying, and never resolves the loop', async () => {
    let callCount = 0;
    const fetchImpl = async () => {
      callCount++;
      return jsonResponse(403, {});
    };
    await expect(
      runPointsLoop([{ id: 1 }, { id: 2 }], new Set(), fetchImpl, 0, noDelay)
    ).rejects.toBeInstanceOf(WafBlockedError);
    expect(callCount).toBe(1); // no retry on 403, loop never reaches id 2
  });

  it('retries a transient error up to 3 attempts, then skips', async () => {
    let callCount = 0;
    const fetchImpl = async () => {
      callCount++;
      return jsonResponse(500, {});
    };
    const result = await runPointsLoop([{ id: 1 }], new Set(), fetchImpl, 0, noDelay);
    expect(callCount).toBe(3);
    expect(result.skipped).toBe(1);
    expect(result.fetched).toBe(0);
  });

  it('recovers within the retry budget when a later attempt succeeds', async () => {
    let callCount = 0;
    const fetchImpl = async () => {
      callCount++;
      if (callCount < 2) return jsonResponse(500, {});
      return jsonResponse(200, { points: [POINT_A] });
    };
    const result = await runPointsLoop([{ id: 1 }], new Set(), fetchImpl, 0, noDelay);
    expect(callCount).toBe(2);
    expect(result.fetched).toBe(1);
    expect(result.spots).toHaveLength(1);
  });

  it('treats a non-array points field as an empty points list', async () => {
    const fetchImpl = async () => jsonResponse(200, { points: null });
    const result = await runPointsLoop([{ id: 1 }], new Set([1]), fetchImpl, 0, noDelay);
    expect(result.fetched).toBe(1);
    expect(result.spots).toEqual([]);
    expect(result.byBangumiId['1']).toEqual([]);
  });

  it('produces an empty result for an empty seed list', async () => {
    const fetchImpl = async () => jsonResponse(200, { points: [] });
    const result = await runPointsLoop([], new Set(), fetchImpl, 0, noDelay);
    expect(result).toEqual({ spots: [], byBangumiId: {}, fetched: 0, skipped: 0 });
  });
});
