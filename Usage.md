# govdata-cli — Usage

Real, use-case-driven examples for the `govdata` CLI: a read-only client for the
open [GovData](https://www.govdata.de/) **CKAN Action API** (`ckan.govdata.de`) —
the central German open-data catalogue. Search datasets, inspect packages,
resources, organizations, groups, tags and facets.

CKAN wraps every response in `{ help, success, result }`. This CLI prints the
**unwrapped `result`** and exits non-zero when `success` is false, so the
examples below pipe straight into [`jq`](https://jqlang.github.io/jq/).

## Install

```bash
npm i -g @maschinenlesbar.org/govdata-cli
```

This installs the **`govdata`** binary. Without a global install you can run it
straight from the build output: `node dist/src/cli/index.js <command>`. The
examples use `govdata`.

## Use cases

### 1. Full-text search the catalogue

Find datasets matching free text (Solr query syntax) — the everyday entry point.

```bash
govdata search Haushalt --rows 5
```

The unwrapped `result` is CKAN's search object: `{ count, results, sort, ... }`.
`--rows` caps how many dataset objects come back. Get just the total and the
titles:

```bash
govdata search Haushalt --rows 5 | jq '{count, titles: [.results[].title]}'
```

### 2. Get the newest datasets first

See what was just published or updated — useful for monitoring a topic.

```bash
govdata search Klima --rows 10 --sort "metadata_modified desc"
```

`--sort` takes any Solr sort expression (`<field> asc|desc`), e.g.
`metadata_created desc` or `title_string asc`.

### 3. Filter by publishing organization and file format

Narrow a search to one publisher and only datasets that ship CSV — for example
to harvest tabular data from the Federal Statistical Office (destatis).

```bash
govdata search --fq 'organization:statistisches-bundesamt AND res_format:CSV' --rows 20
```

`--fq` is a Solr filter query. Combine several conditions in one filter with
Solr boolean operators (`AND` / `OR`), as shown above. The bare `[query]`
argument is optional, so you can filter without a text query as shown here.

### 4. Page through a large result set

Walk results in batches without re-fetching — page 2 of 20-per-page:

```bash
govdata search Verkehr --rows 20 --start 20
```

`--start` is the zero-based offset. Combine with `count` from the first call to
know when to stop:

```bash
govdata search Verkehr --rows 0 | jq '.count'
```

### 5. Inspect one dataset and its resources (distributions)

Pull the full metadata of a single dataset by id or by its slug `name`, then
list the downloadable distributions attached to it.

```bash
govdata package luftqualitat
```

```bash
# Just the resources: format + direct download URL
govdata package luftqualitat \
  | jq '.resources[] | {name, format, url}'
```

The first hit of a search is a handy way to discover a valid id/name:

```bash
govdata search Luftqualität --rows 1 | jq -r '.results[0].name'
```

### 6. Fetch a single resource (distribution) by id

When you already have a resource id (from a dataset's `resources[]`), inspect
just that distribution — its format, size and download URL.

```bash
govdata resource <resource-id>
```

```bash
govdata resource <resource-id> | jq '{format, url, size, last_modified}'
```

### 7. List data publishers (organizations)

Discover which organizations publish to GovData — names for quick scanning, or
full objects with counts and metadata.

```bash
# Just the org slugs
govdata organizations

# Full objects (title, package_count, description, ...)
govdata organizations --all-fields | jq '.[] | {name, title, packages: .package_count}'
```

Then drill into one:

```bash
govdata organization statistisches-bundesamt | jq '{title, package_count}'
```

### 8. Browse themes/categories (groups) and tags

Explore the controlled vocabulary you can use in `--fq` filters.

```bash
# Groups (themes), e.g. transport, environment, health
govdata groups
govdata groups --all-fields | jq '.[] | {name, title}'
govdata group envi

# Tags, optionally filtered by substring
govdata tags --query energie
```

Use a discovered group in a search filter:

```bash
govdata search --fq groups:envi --rows 10 | jq '.count'
```

### 9. Get facet counts via the generic action escape hatch

Build a "datasets per format" or "per organization" breakdown. The `search`
command does not expose facet flags, but `action package_search` can pass any
CKAN parameter, including `facet.field`.

```bash
govdata action package_search \
  --param q=Klima \
  --param rows=0 \
  --param "facet.field=[\"res_format\",\"organization\"]" \
  | jq '.search_facets.res_format.items'
```

`--param` is repeatable `key=value` (duplicate keys are rejected). With
`rows=0` you pay only for the facet aggregation, not the documents.

### 10. Call any read action not wrapped by a dedicated command

The escape hatch reaches every CKAN read action by name.

```bash
# Equivalent to the `tags` command, via the generic action
govdata action tag_list --param query=verkehr

# Total dataset count in the catalogue
govdata action package_search --param rows=0 | jq '.count'
```

The action name is validated against `^[a-z0-9_]+$`, so only plain action names
are accepted.

## Global options

These apply to every command and may be given **before or after** the
subcommand (e.g. `govdata --compact search Haushalt` or
`govdata search Haushalt --compact`).

| Option | Description |
| --- | --- |
| `-V, --version` | Print the version and exit |
| `--base-url <url>` | API base URL (default `https://ckan.govdata.de`) |
| `--timeout <ms>` | Per-request timeout in milliseconds |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `-h, --help` | Show help for the program or a command |

**Exit codes:** `0` on success (and for `--help`/`--version`), `4` on a `404`
from the API, `1` for any other error (including a CKAN `success: false`) and
for usage/parse errors.
