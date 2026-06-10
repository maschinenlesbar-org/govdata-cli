---
name: govdata-dataset-finder
description: >
  Find, rank and enrich open German government datasets on a topic using the
  govdata-cli. Trigger when the user asks "find datasets about air quality on
  GovData", "what open data is there on Verkehr / Haushalt / Klima?", "newest
  datasets from destatis", "is there CSV data on X I can download?", or wants a
  ranked, deduped briefing of catalogue hits with publishers, formats, real
  licences and download links — not the raw CKAN search JSON.
version: 1.0.0
userInvocable: true
---

# GovData Dataset Finder

Turn a free-text topic into a **ranked, deduplicated shortlist of datasets** from
Germany's central open-data catalogue, each annotated with publisher, available file
formats, the *real* licence, last-modified date and direct download links — instead of
the 30-field-per-hit CKAN search blob.

## Tooling

This skill drives the `govdata` command. **Before anything else, validate it is available** — run `command -v govdata` (or `govdata --version`). If it is not on your PATH, STOP and inform the user that the `govdata` CLI (`@maschinenlesbar.org/govdata-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

Data comes from the `govdata` CLI (`@maschinenlesbar.org/govdata-cli`) over the open GovData CKAN Action API. It is read-only and needs **no API key**. Always pass `--compact` so each result is one line to pipe into `jq`. A search that matches nothing returns `{"count":0,"results":[]}` and exits `0` — that is **not** an error, it means "nothing in the catalogue on that topic"; report it plainly and suggest a broader term. Exit `4` means a named dataset id wasn't found; exit `1` is a real error (bad `--fq` syntax, network). Bump `--timeout 60000` if a call is slow.

## Step 1 — Search the topic

```bash
govdata --compact search "Luftqualität" --rows 25 --sort "metadata_modified desc"
```

- The unwrapped result is `{ count, results, sort, search_facets }`. `count` is the
  **total** catalogue matches; `results` is capped by `--rows` (default is small — set
  `--rows 25` to have enough to rank).
- Sorting `metadata_modified desc` surfaces freshest data first; offer
  `metadata_created desc` for "newest *published*".
- Narrow on request with repeatable `--fq` (Solr filter), combined with `AND`/`OR`:
  - publisher: `--fq organization:statistisches-bundesamt`
  - theme/category: `--fq groups:tran` (group names are 4-letter DCAT codes — resolve
    them with `govdata groups --all-fields`; e.g. `tran`=Verkehr, `envi`=Umwelt,
    `soci`=Bevölkerung & Gesellschaft)
  - file format: **see the format trap in Step 3** — naive `--fq res_format:CSV` misses
    most matches.
- A bare topic with no text query is fine: `govdata --compact search --fq organization:open-nrw --rows 25`.

## Step 2 — Read the fields that matter

Per item in `results`, the useful fields:

| Field | Meaning |
|---|---|
| `title` / `name` | Human title / URL slug. **Use `name`** for the follow-up `govdata package <name>`. |
| `notes` | German description (may be `null`). |
| `organization.name` / `.title` | Publisher slug / label. |
| `metadata_modified` / `metadata_created` | ISO timestamps — recency for ranking. |
| `num_resources` | How many downloadable files/services. **`0` = metadata-only stub**, deprioritise. |
| `resources[]` | The distributions: `{ name, format, mimetype, url, size, last_modified }`. The `url` is a **direct download**. |
| `tags[].name` | Keywords. |
| `groups[].name` | Theme codes. |
| `extras[]` | `{key,value}` pairs of DCAT-AP.de metadata (publisher_name, access_rights, source portal, …). |

> **Licence trap.** Do **not** trust the package-level `license_id` / `license_title` /
> `isopen` — on GovData they are **empty/`false` for the vast majority of datasets** even
> though the data is openly licensed. The real licence lives on each resource as a
> DCAT-AP URI: `resources[].license`, e.g.
> `http://dcat-ap.de/def/licenses/dl-by-de/2.0` (Datenlizenz Deutschland Namensnennung)
> or `…/dl-zero-de/2.0` (DL-DE Zero, no attribution). Read the licence from there and map
> the URI tail to a short label; say "licence not stated" only if no resource carries one.

## Step 3 — Handle the format filter trap

GovData stores the **same logical format twice**: a clean string (`CSV`, `PDF`) *and* an
EU-vocabulary URI (`http://publications.europa.eu/resource/authority/file-type/CSV`). The
URI variant is by far the more common — for a typical topic ~5600 resources carry
`…/file-type/CSV` vs only a few hundred the bare `CSV`. So:

- `--fq res_format:CSV` silently **misses the majority** of CSV datasets. Don't rely on it
  alone. To filter server-side, OR both forms:
  `--fq 'res_format:("CSV" OR "http://publications.europa.eu/resource/authority/file-type/CSV")'`
- The robust approach: search the topic, then filter **client-side** on
  `resources[].format` matching either the bare format or `…/file-type/<FMT>` (case-
  insensitive, take the tail after the last `/`).

## Step 4 — Rank and dedupe

1. **Drop stubs:** push `num_resources == 0` datasets to the bottom (or omit, saying so).
2. **Recency:** within relevance, prefer higher `metadata_modified`.
3. **Format fit:** if the user wanted a format (CSV, GeoJSON…), rank datasets that
   actually carry it first; note its presence per hit.
4. **Dedupe near-duplicates.** GovData federates many portals, so the same dataset
   recurs as yearly editions or re-harvests (e.g. `haushalt-2019`, `haushalt-2020`, plus
   a `has_version` collection in `extras`). Collapse obvious series into one line with a
   year range rather than listing every edition.

## Step 5 — Brief the user

Lead with the **total `count`** ("412 datasets match; top 8 by recency"), then a compact
ranked list. Per dataset show: title, publisher, formats available, last-modified, the
real licence (from `resources[].license`), and the dataset slug for follow-up.

```
"Luftqualität" — 412 datasets in the catalogue. Top by last update:

1. Luftqualität Messstationen 2026        Umweltbundesamt
   CSV, JSON, WMS · updated 2026-06-08 · DL-DE-BY 2.0 · 6 files
   → govdata package luftqualitat-messstationen-2026
2. Feinstaub-Messwerte Stuttgart          Open Data Baden-Württemberg
   CSV · updated 2026-05-30 · DL-DE Zero 2.0 · 3 files
…
(11 metadata-only stubs with no files omitted)
```

Rules:
- Always give the dataset `name` so the user can run `govdata package <name>` for the full
  record, and offer the direct `resources[].url` download links on request.
- State formats and licence per hit — those are the decision drivers for reuse.
- If the user wants the files, hand off to **govdata-resource-harvest**; for "who
  publishes most / format breakdown" questions, hand off to **govdata-catalogue-stats**.
- Don't claim a licence the data doesn't carry; if every resource lacks `license`, say so.
