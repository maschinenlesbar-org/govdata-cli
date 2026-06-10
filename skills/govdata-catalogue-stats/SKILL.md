---
name: govdata-catalogue-stats
description: >
  Produce statistics and breakdowns over Germany's open-data catalogue using the
  govdata-cli's facet support. Trigger when the user asks "which organizations
  publish the most datasets about Verkehr?", "what file formats dominate the
  catalogue?", "the licence landscape on GovData", "how many datasets does
  destatis have?", "datasets per theme", or wants counts/rankings/aggregations
  rather than a list of individual datasets. Uses CKAN facets via the generic
  action escape hatch and cleans up the messy facet values.
version: 1.0.0
userInvocable: true
---

# GovData Catalogue Statistics

Answer "how many / which publishes the most / what's the distribution of …" questions
about the GovData catalogue by driving CKAN **facets** — aggregated value counts over a
search — and tidying the raw, duplicated facet values into a clean ranking.

## Tooling

This skill drives the `govdata` command. **Before anything else, validate it is available** — run `command -v govdata` (or `govdata --version`). If it is not on your PATH, STOP and inform the user that the `govdata` CLI (`@maschinenlesbar.org/govdata-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

Data comes from the `govdata` CLI (`@maschinenlesbar.org/govdata-cli`), read-only, **no API key**. Always pass `--compact`. Empty `count:0` is a valid answer, not an error.

## Step 1 — Pick the entrypoint for the question

- **Per-topic / per-publisher breakdowns** (the common case) → use the **`action`
  escape hatch** with `package_search`, because the dedicated `search` command does
  **not** expose facet flags. Facets are requested via `facet.field` and
  returned under `search_facets`.
- **A single publisher's total** → `govdata --compact organization <slug>` and read
  `package_count` directly (no facet needed).
- **The catalogue grand total** → `govdata --compact action package_search --param rows=0`
  then read `.count`.

## Step 2 — Run the facet query

Set `rows=0` so you pay only for the aggregation, not the documents. `facet.field` is a
**JSON array string**; raise `facet.limit` so the long tail isn't truncated:

```bash
# Which organizations publish the most "Verkehr" datasets?
govdata --compact action package_search \
  --param q=Verkehr \
  --param rows=0 \
  --param 'facet.field=["organization"]' \
  --param 'facet.limit=50'
```

Other useful facet fields: `res_format` (file formats), `license_id` (licences),
`groups` (themes), `tags`. Add `q=…` and/or repeat `--param fq=…` to scope the universe
(e.g. only datasets from one org, one theme). For a catalogue-wide picture, drop `q`.

> `--param` keys must be unique — the CLI **rejects a duplicated `--param` key**. To pass
> several Solr `fq` filters in one call, combine them inside one `fq` value with
> `AND`/`OR` instead of repeating `--param fq=…`.

## Step 3 — Read and clean the facet items

The result is `search_facets.<field>.items[]`, each `{ name, display_name, count }`.

> **These items are NOT pre-sorted by count** — sort them yourself descending before
> ranking. Use `jq 'sort_by(-.count)'`.

Field-specific clean-up — the raw `name` values are messy and need normalising:

- **`organization`**: `name` is the slug; **`display_name` is the readable label** — show
  that. (e.g. `open-data-bayern` → `open.bydata`.)
- **`res_format`**: the SAME format appears under **two `name` values** — a clean string
  (`CSV`) *and* an EU-vocabulary URI
  (`http://publications.europa.eu/resource/authority/file-type/CSV`). To report true
  format totals you must **fold them together**: take the tail after the last `/`,
  uppercase it, and **sum the counts** of both variants. Reporting them separately
  badly undercounts every format (the URI variant usually dwarfs the bare one).
- **`license_id`**: same duplication problem and worse — `name` is a DCAT-AP URI with
  punctuation variants (`…/dl-by-de/2.0` *and* `…/dl-by-de/2_0`, plus an "ältere
  DCAT-AP.de Version" of each). Use `display_name` for the human label and **merge the
  `2.0`/`2_0`/older-version rows of the same licence** before ranking. Note that the
  package-level licence facet is sparse because most datasets carry the licence only at
  resource level (see govdata-dataset-finder).
- **`groups`**: `name` is a 4-letter DCAT code (`tran`, `envi`, `soci`); map to titles via
  `govdata --compact groups --all-fields` (`.[] | {name, title}`).

## Step 4 — Present the breakdown

A ranked table or bar-style list, cleaned and summed, with the scope stated:

```
Publishers of "Verkehr" datasets (top 5 of 50 facets):

  Open Data Brandenburg     4 446
  open.bydata               3 446
  Mobilithek (mCLOUD)         766
  Open Data Baden-Württemb.   740
  Statistisches Bundesamt     316
  … 45 more publishers
```

```
File formats across "Verkehr" (folded clean+URI variants):

  CSV    5 700   ████████████
  HTML   4 939   ██████████
  PDF    4 025   ████████
  XML    2 729   ██████
```

Rules:
- **State the universe** you faceted over (whole catalogue, a topic `q`, an `fq` scope) —
  a count is meaningless without it.
- Always **fold `res_format` and `license_id` duplicates** and **sort by count** before
  presenting; never paste raw facet items.
- Use `display_name`, not `name`, for orgs and licences; map group codes to titles.
- For a single org's total, prefer `organization <slug>` → `package_count` over a facet.
- If a facet is empty (`items: []`), the field isn't faceted for that scope — say so.
