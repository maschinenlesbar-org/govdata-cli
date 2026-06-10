---
name: govdata-resource-harvest
description: >
  Collect the downloadable files (distributions) for a topic or publisher from
  the GovData catalogue into a clean download manifest, using the govdata-cli.
  Trigger when the user asks "get me all the CSVs about Haushalt", "download
  links for destatis transport data", "harvest the GeoJSON files on flood maps",
  "build a list of files I can fetch for X", or wants direct download URLs +
  format + size across many datasets rather than browsing one dataset at a time.
version: 1.0.0
userInvocable: true
---

# GovData Resource Harvest

Go from a topic/publisher to a **flat manifest of downloadable resources** — one row per
file with its direct URL, format, size, licence and parent dataset — ready to feed into
`curl`/`wget`, a data pipeline, or a download script. The CLI returns datasets with nested
`resources[]`; this skill does the cross-dataset flatten + format filter the CLI doesn't.

## Tooling

This skill drives the `govdata` command. **Before anything else, validate it is available** — run `command -v govdata` (or `govdata --version`). If it is not on your PATH, STOP and inform the user that the `govdata` CLI (`@maschinenlesbar.org/govdata-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

Data comes from the `govdata` CLI (`@maschinenlesbar.org/govdata-cli`), read-only, **no API key**. Always `--compact`. `count:0` (exit `0`) = nothing matched; report it, don't treat it as an error. This skill only **lists** download URLs — it does not download anything unless the user explicitly asks you to fetch them.

## Step 1 — Scope the search

```bash
govdata --compact search "Haushalt" --rows 50 --sort "metadata_modified desc"
```

- Set `--rows` high enough to harvest meaningfully (25–100). Note `count` so you can warn
  if there's far more than one page; page with `--start 50`, `--start 100`, … if the user
  wants the lot.
- Scope with `--fq` as needed (combine conditions with `AND`/`OR` in **one** `--fq`):
  - publisher: `--fq organization:open-data-baden-wurttemberg`
  - theme: `--fq groups:soci` (codes from `govdata groups --all-fields`)

## Step 2 — Filter to the wanted format — mind the duplication trap

> **The format trap.** GovData records the same format under **two values**: a clean
> string (`CSV`) and an EU-vocabulary URI
> (`http://publications.europa.eu/resource/authority/file-type/CSV`). The URI variant is
> the more common one. So `--fq res_format:CSV` **misses most files**.
>
> Harvest reliably by filtering **client-side** on each `resources[].format`: normalise it
> (take the tail after the last `/`, uppercase) and keep those equal to the wanted format.
> If you must filter server-side, OR both forms:
> `--fq 'res_format:("CSV" OR "http://publications.europa.eu/resource/authority/file-type/CSV")'`.

## Step 3 — Flatten datasets → resources

For every dataset hit, expand `resources[]` into individual rows. The fields per resource:

| Field | Meaning |
|---|---|
| `url` | **Direct download URL** — the thing to fetch. |
| `format` | File format (clean string *or* the EU URI — normalise it). |
| `mimetype` | MIME type (often more reliable than `format`). |
| `name` | Resource label. |
| `size` | Bytes (may be `null`). |
| `last_modified` / `created` | Timestamps (often `null`). |
| `license` | **Per-resource DCAT-AP licence URI** — the real licence (the package-level `license_id` is usually empty). |

Carry the parent dataset's `name` (slug) and `organization.title` onto each row for
provenance.

```bash
# CSV manifest for one publisher, flattened, with jq
govdata --compact search --fq organization:open-data-baden-wurttemberg --rows 50 \
  | jq -r '.results[] as $d | $d.resources[]
           | select((.format // "" | ascii_downcase | sub(".*/";"")) == "csv")
           | [$d.name, .name, (.size//"?"), (.license//"-"), .url] | @tsv'
```

Notes:
- **Skip resources without a `url`** (service stubs); count and report how many you
  dropped.
- A `WMS`/`WFS`/`view` "format" is a **map service endpoint, not a file** — exclude it
  from a "files to download" harvest unless the user wants services too.
- `size:null` is common — show "?" rather than guessing.
- Dedupe identical URLs (the same file can appear via re-harvested duplicate datasets).

## Step 4 — Present the manifest

Lead with totals (datasets scanned, files matched, total bytes where known), then the
flat list grouped by dataset, plus an offer to write it out.

```
Haushalt · CSV harvest — 18 datasets scanned, 41 CSV files, ~3.2 MB

haushalte06853 (Open Data Baden-Württemberg) · DL-DE-BY 2.0
  Haushalte insgesamt            8 KB   https://transparenz.karlsruhe.de/.../haushalte-insgesamt.csv
  Einpersonenhaushalte           8 KB   https://transparenz.karlsruhe.de/.../einpersonenhaushalte.csv
…
```

Offer to:
- write the URLs to a file (`urls.txt`) for `wget -i urls.txt` / `xargs curl`,
- emit a CSV/TSV manifest (dataset, file, format, size, licence, url),
- actually download them **only if the user confirms** (respect each resource's `license`;
  flag any resource with no licence so the user can check terms before redistributing).

Rules:
- Always state the **licence per file** from `resources[].license`; harvesting is only
  safe to redistribute under the stated open licence.
- Don't silently cap: if `count` exceeds what you fetched, say "showing first N of M;
  page with `--start`".
- Keep service endpoints (WMS/WFS/view) out of a file harvest unless asked.
