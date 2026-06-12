/**
 * Bangumi Archive weekly dump access.
 *
 * The bangumi/Archive repo publishes dated assets (dump-YYYY-MM-DD.HHMMSSZ.zip,
 * ~400 MB) under the fixed `archive` release tag — no stable-alias asset, so
 * the newest one is resolved through the GitHub API. `subject.jsonlines`
 * inside is ~900 MB; it is never buffered whole — `unzip -p` streams it and
 * lines are parsed as they arrive, keeping only type-2 (anime) subjects.
 *
 * Env:
 *   BANGUMI_DUMP_PATH  use a local dump.zip instead of downloading (dev loop)
 *   GH_TOKEN           optional GitHub API token (CI; avoids rate limits)
 */

const ARCHIVE_RELEASE_API = 'https://api.github.com/repos/bangumi/Archive/releases/tags/archive';

export interface DumpAsset {
  name: string;
  browser_download_url: string;
}

export interface BangumiAnimeSubject {
  id: number;
  name: string;
  nameCn: string | null;
  year: number | null;
  /** 1=TV, 2=OVA, 3=Movie, 5=WEB, 0=other; null when absent/garbage. */
  platform: number | null;
}

const DUMP_NAME_RE = /^dump-\d{4}-\d{2}-\d{2}\..*\.zip$/;
const KNOWN_PLATFORMS = new Set([0, 1, 2, 3, 5]);

/** Dated names are fixed-width, so lexicographic max = newest. */
export function pickNewestDumpAsset(assets: readonly DumpAsset[]): DumpAsset | null {
  let best: DumpAsset | null = null;
  for (const a of assets) {
    if (!DUMP_NAME_RE.test(a.name)) continue;
    if (!best || a.name > best.name) best = a;
  }
  return best;
}

export function parseSubjectLine(line: string): BangumiAnimeSubject | null {
  let o: {
    id?: unknown;
    type?: unknown;
    name?: unknown;
    name_cn?: unknown;
    date?: unknown;
    platform?: unknown;
  };
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (o.type !== 2) return null;
  if (typeof o.id !== 'number' || !Number.isFinite(o.id) || o.id <= 0) return null;
  if (typeof o.name !== 'string' || o.name.length === 0) return null;

  const nameCn =
    typeof o.name_cn === 'string' && o.name_cn.trim().length > 0 ? o.name_cn.trim() : null;
  const yearMatch = typeof o.date === 'string' ? /^(\d{4})-/.exec(o.date) : null;
  const year = yearMatch ? Number(yearMatch[1]) : null;
  const platform =
    typeof o.platform === 'number' && KNOWN_PLATFORMS.has(o.platform) ? o.platform : null;

  return { id: o.id, name: o.name, nameCn, year, platform };
}

export async function downloadLatestDump(destPath: string): Promise<string> {
  const local = process.env.BANGUMI_DUMP_PATH;
  if (local) {
    console.log(`[bangumi-dump] using local dump: ${local}`);
    return local;
  }
  const headers: Record<string, string> = { 'User-Agent': 'Aniseekr-source build' };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const res = await fetch(ARCHIVE_RELEASE_API, { headers });
  if (!res.ok) throw new Error(`Archive release listing failed: ${res.status}`);
  const release = (await res.json()) as { assets?: DumpAsset[] };
  const asset = pickNewestDumpAsset(release.assets ?? []);
  if (!asset) throw new Error('No dump-*.zip asset found in bangumi/Archive release');

  console.log(`[bangumi-dump] downloading ${asset.name}…`);
  // ~400 MB from GitHub Releases normally lands in <2 min on CI; the timeout
  // exists to surface a hung connection in minutes, not the job's 6-hour cap.
  const dl = await fetch(asset.browser_download_url, {
    signal: AbortSignal.timeout(20 * 60 * 1000),
  });
  if (!dl.ok || !dl.body) throw new Error(`Dump download failed: ${dl.status}`);
  await Bun.write(destPath, dl);
  return destPath;
}

/** Stream subject.jsonlines out of the zip; never buffers the whole file. */
export async function loadAnimeSubjects(zipPath: string): Promise<BangumiAnimeSubject[]> {
  const proc = Bun.spawn(['unzip', '-p', zipPath, 'subject.jsonlines'], {
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const subjects: BangumiAnimeSubject[] = [];
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of proc.stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const parsed = parseSubjectLine(buffer.slice(0, nl));
      if (parsed) subjects.push(parsed);
      buffer = buffer.slice(nl + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const parsed = parseSubjectLine(buffer);
    if (parsed) subjects.push(parsed);
  }
  const exit = await proc.exited;
  if (exit !== 0) throw new Error(`unzip exited with ${exit}`);
  console.log(`[bangumi-dump] anime subjects: ${subjects.length}`);
  return subjects;
}
