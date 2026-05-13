# Aniseekr-source

Derived public data sources for [Aniseekr](https://github.com/Aniseekr/aniseekr-expo).

## Anime ID Mappings

Merged platform-ID lookup table built from:

- [Fribb/anime-lists](https://github.com/Fribb/anime-lists) — `anime-list-mini.json`
- [manami-project/anime-offline-database](https://github.com/manami-project/anime-offline-database) — `anime-offline-database-minified.json` (latest weekly release)

Outer-joined on AniDB ID. Fribb values win where present; manami fills the gaps — most importantly Bangumi, which Fribb doesn't carry.

### Consumption

Stable URL (refreshed weekly, never changes):

```
https://github.com/Aniseekr/Aniseekr-source/releases/download/mapping-data/anime-id-mappings-merged.json
```

Dated weekly snapshots are also published at `mapping-data-YYYY-WW` (ISO week). The 8 most recent are retained for rollback; older ones are pruned automatically.

### Rebuild cadence

Daily at 03:00 UTC via [`.github/workflows/build-id-mapping.yml`](.github/workflows/build-id-mapping.yml). Can also be run manually via `workflow_dispatch` or locally:

```bash
bun scripts/build-id-mapping-source.ts
```

### Schema

Each record is a sparse object keyed by platform-ID column:

```json
{
  "mal_id": 21,
  "anilist_id": 21,
  "kitsu_id": 12,
  "bangumi_id": 975,
  "anidb_id": 69,
  "shikimori_id": 21,
  "simkl_id": 38026,
  "thetvdb_id": 81797,
  "themoviedb_id": 37854,
  "livechart_id": 3437,
  "anime_planet_id": "one-piece",
  "anisearch_id": 2614,
  "notify_moe_id": "Y9w5KFmig"
}
```

Fields are absent when no upstream source provides them.
