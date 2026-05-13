# Aniseekr-source

Derived public data sources for [Aniseekr](https://github.com/Aniseekr/aniseekr-expo). Every artifact ships with a JSON Schema (Draft 2020-12, OpenAPI 3.1 compatible) under [`schemas/`](./schemas) so external consumers can validate against the same contract.

## Anime ID Mappings

Merged platform-ID lookup table built from:

- [Fribb/anime-lists](https://github.com/Fribb/anime-lists) — `anime-list-mini.json`
- [manami-project/anime-offline-database](https://github.com/manami-project/anime-offline-database) — `anime-offline-database-minified.json` (latest weekly release)

Outer-joined on AniDB ID. Fribb values win where present; manami fills the gaps. Neither upstream carries `bangumi_id` today, so that column is empty until a separate cross-reference feeds it in.

**Stable consumption URL** (refreshed weekly, never changes):

```
https://github.com/Aniseekr/Aniseekr-source/releases/download/mapping-data/anime-id-mappings-merged.json
```

Top-level shape is a plain `MappingRecord[]`. Schema: [`schemas/anime-id-mappings.schema.json`](./schemas/anime-id-mappings.schema.json).

Dated snapshots: `mapping-data-YYYY-WW` (ISO week). The 8 most recent are retained.

## Anitabi Index

Index of every anime that [anitabi.cn](https://anitabi.cn) has confirmed pilgrimage (聖地巡禮) coordinates for, keyed by Bangumi subject ID.

**Stable consumption URL**:

```
https://github.com/Aniseekr/Aniseekr-source/releases/download/anitabi-index/anitabi-index.json
```

Top-level shape is an object with `$schema`, `generatedAt`, `source`, `fallbackUsed`, `entries`. Schema: [`schemas/anitabi-index.schema.json`](./schemas/anitabi-index.schema.json).

Dated snapshots: `anitabi-index-YYYY-WW`. The 8 most recent are retained.

### Build strategy

- **Primary**: a single `GET https://api.anitabi.cn/bangumi` — the bulk endpoint anitabi.cn's own map page uses. Undocumented; anitabi makes no stability guarantee.
- **Fallback**: if the primary endpoint changes shape or disappears, the script enumerates the documented [`/bangumi/{id}/lite`](https://github.com/anitabi/anitabi.cn-document/blob/main/api.md) endpoint over a small embedded seed list so we still publish a useful (smaller) index.

The output's `source` and `fallbackUsed` fields tell consumers which path was taken.

## Rebuild cadence

Both data sets rebuild daily via GitHub Actions:

- `.github/workflows/build-id-mapping.yml` — 03:00 UTC
- `.github/workflows/build-anitabi-index.yml` — 03:30 UTC

Either can be re-run manually via `workflow_dispatch`.

## Local builds

```bash
bun scripts/build-id-mapping-source.ts        # writes anime-id-mappings-merged.json in CWD
bun scripts/build-anitabi-index.ts            # writes anitabi-index.json in CWD
ANITABI_FORCE_FALLBACK=1 bun scripts/build-anitabi-index.ts   # exercise fallback path
```
