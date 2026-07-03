// Pure build helpers for scripts/build-anitabi-points.ts. Kept here (not in the
// script) so they are unit-testable with `bun test` without hitting the network.
//
// Filtering mirrors the app's normalizeRawPoints (drop points with no id/name/
// image) plus the anitabi-index hasValidGeo rule (finite, in-range, non-(0,0)).

/** Loosely-typed point exactly as GET /bangumi/{id}/points returns each element. */
export interface RawPoint {
  id?: unknown;
  name?: unknown;
  cn?: unknown;
  image?: unknown;
  ep?: unknown;
  s?: unknown;
  geo?: unknown;
}

/** One row in anitabi-spots-index.json. Minified keys to keep the artifact small. */
export interface SpotEntry {
  /** anitabi point id (stable within an anime). */
  id: string;
  /** Bangumi subject id this point belongs to. */
  b: number;
  lat: number;
  lng: number;
  /** Japanese/original name. */
  n: string;
  /** Chinese name, '' when anitabi has none. */
  c: string;
  /** Scene image, exactly as anitabi returns it (usually a host-relative
   *  `/images/points/...` path). The app normalizes it to an absolute CDN
   *  thumbnail on read via normalizeAnitabiImageUrl. */
  img: string;
}

export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function hasValidGeo(geo: unknown): geo is [number, number] {
  if (!Array.isArray(geo) || geo.length < 2) return false;
  const lat = Number(geo[0]);
  const lng = Number(geo[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat === 0 && lng === 0) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  return true;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function spotEntryFromRawPoint(raw: RawPoint, bangumiId: number): SpotEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = str(raw.id);
  if (!id) return null;
  const n = str(raw.name);
  if (!n) return null;
  const img = str(raw.image);
  if (!img) return null; // no reference frame ⇒ useless for the compare feature
  if (!hasValidGeo(raw.geo)) return null;
  const [lat, lng] = raw.geo as [number, number];
  return {
    id,
    b: bangumiId,
    lat: round6(Number(lat)),
    lng: round6(Number(lng)),
    n,
    c: str(raw.cn),
    img,
  };
}

export function topBangumiIdsByPoints(
  entries: readonly { id: number; pointsLength?: number | null }[],
  limit: number
): number[] {
  return [...entries]
    .sort((a, b) => (b.pointsLength ?? 0) - (a.pointsLength ?? 0) || a.id - b.id)
    .slice(0, Math.max(0, limit))
    .map((e) => e.id);
}
