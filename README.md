# govdata-cli

[![CI](https://github.com/maschinenlesbar-org/govdata-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/govdata-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/govdata-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/govdata-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/govdata-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/govdata-cli)

Browse Germany's central open-data catalogue from your terminal. `govdata` is a
command-line tool over the [GovData CKAN Action API](https://www.govdata.de/)
(`ckan.govdata.de`) — the national portal that federates open datasets from
federal government, federal states and municipalities: search, inspect, filter
and pipe straight into [`jq`](https://jqlang.github.io/jq/).

- **Works out of the box** — no account, no API key, no configuration. Install
  and explore.
- **Clean JSON output** — the CKAN envelope is unwrapped for you; `--compact`
  for one-line/scripting.
- **Ten commands** — `search`, `package`, `packages`, `organizations`,
  `organization`, `groups`, `group`, `tags`, `resource`, and a generic `action`
  escape hatch.
- **Everything is open** — every dataset this tool reaches is publicly licensed;
  nothing to register for.

> Want to use this as a TypeScript library or understand how it's built?
> See **[DEVELOPING.md](DEVELOPING.md)**.

## Install

```bash
npm i -g @maschinenlesbar.org/govdata-cli
```

This installs the **`govdata`** command. Requires **Node.js 20+**.

Check it works:

```bash
govdata --help
```

## Quickstart

No setup needed — the API is open and requires no key. Your first search:

```bash
govdata search Haushalt --rows 5
```

The result is unwrapped from CKAN's `{ help, success, result }` envelope — you
get the search object directly: `{ count, results, sort, … }`. Pull out just
the titles with `jq`:

```bash
govdata search Haushalt --rows 5 | jq '{count, titles: [.results[].title]}'
```

Take a name from those results and fetch the full dataset record:

```bash
govdata package luftqualitat
```

## Commands

```text
search [query] [filters…]             search datasets
package <id>                          show one dataset by id or name
packages [--limit <n>] [--offset <n>] list dataset names
organizations [--all-fields]          list organizations (publishers)
organization <id>                     show one organization
groups [--all-fields]                 list groups (themes/categories)
group <id>                            show one group
tags [--query <substring>]            list tags
resource <id>                         show one resource (distribution)
action <name> [--param key=value …]   call any CKAN action (generic)
```

### `search` filters

| Flag | Meaning |
| --- | --- |
| `[query]` | free-text Solr query, e.g. `Haushalt` or `title:Klimaschutz` |
| `--fq <filter>` | Solr filter query, e.g. `organization:destatis` (repeatable) |
| `--rows <n>` | max results to return |
| `--start <n>` | zero-based offset for paging |
| `--sort <expr>` | Solr sort expression, e.g. `metadata_modified desc` |

> **Note on `--rows`** — GovData's Solr caps a single search at **1000 results**
> server-side. Asking for more (e.g. `--rows 100000`) is not an error — you simply
> get at most 1000 back, while `count` still reports the true total. Use `--start`
> to page beyond the first 1000.

> **Note on free-text matching** — the bare `[query]` is a Solr query, and Solr
> *tokenises* terms: a string like `abc12345` can match a dataset whose title
> contains `12345` (e.g. `1,2,3,4,5 …`). If you need an exact field match, scope
> the query (`title:Klimaschutz`) or add an `--fq` filter rather than relying on a
> bare keyword.

### `packages` flags

| Flag | Meaning |
| --- | --- |
| `--limit <n>` | max names to return |
| `--offset <n>` | number of records to skip |

### `organizations` / `groups` flag

| Flag | Meaning |
| --- | --- |
| `--all-fields` | return full objects instead of bare names |

### `tags` flag

| Flag | Meaning |
| --- | --- |
| `--query <substring>` | filter tags by substring |

### `action` flag

| Flag | Meaning |
| --- | --- |
| `--param <key=value>` | query parameter (repeatable; duplicate keys are rejected) |

> **Note on the `<name>`** — the action name is validated client-side against
> `^[a-z0-9_]+$` (lowercase letters, digits and underscores). Names with dashes,
> uppercase letters or spaces are rejected before any request is sent — this keeps
> the escape hatch from injecting extra path segments into the request URL. Use the
> exact CKAN action name, e.g. `package_search`, `organization_list`, `status_show`.

The **[Glossary](GLOSSARY.md)** decodes every CKAN term and search-parameter
name.

## Common tasks

A few recipes to get going — see **[Usage.md](Usage.md)** for the full,
use-case-driven set.

```bash
# Newest datasets first
govdata search Klima --rows 10 --sort "metadata_modified desc"

# Filter by publisher and file format
govdata search --fq organization:destatis --fq res_format:CSV

# Full dataset with all its resources (distributions)
govdata package luftqualitat | jq '.resources[] | {name, format, url}'

# All data publishers (short names)
govdata organizations

# Full publisher objects, then drill into one
govdata organizations --all-fields | jq '.[] | {name, title, packages: .package_count}'
govdata organization statistisches-bundesamt | jq '{title, package_count}'

# Tags matching a substring
govdata tags --query energie

# Any CKAN action not covered by a dedicated command
govdata action package_search --param q=Verkehr --param rows=3
```

## Output & scripting

Every command prints the **unwrapped `result`** as pretty JSON to stdout.
Errors and diagnostics go to stderr, so piping stdout into `jq` stays clean.

```bash
# Total datasets in the catalogue
govdata action package_search --param rows=0 | jq '.count'

# Resource format and download URL from a dataset
govdata package luftqualitat | jq '.resources[] | {format, url}'

# Discover a valid dataset name from a search hit
govdata search Luftqualität --rows 1 | jq -r '.results[0].name'
```

Use `--compact` for single-line JSON in pipelines and logs:

```bash
govdata --compact search Haushalt --rows 5 | jq -c '.results[].title'
```

`--compact` (and every global option) works **before or after** the command —
both `govdata --compact search …` and `govdata search … --compact` do the same
thing.

**Exit codes** make the CLI easy to use in scripts:

| Code | Meaning |
| --- | --- |
| `0` | success (also `--help` / `--version`) |
| `4` | dataset/resource not found (`404`) |
| `1` | any other error — bad usage, CKAN `success:false`, network failure |

## Troubleshooting

- **`command not found: govdata`** — the global npm bin directory isn't on your
  `PATH`. Run `npm bin -g` to find it and add it, or run via
  `npx @maschinenlesbar.org/govdata-cli …`.
- **Exit `4` / "not found"** — the dataset or resource id doesn't exist or has
  been removed. Re-run a `search` to get a fresh name/id.
- **Exit `1` / CKAN `success:false`** — the catalogue rejected the request
  (malformed filter, unknown action name, etc.). Check your `--fq` syntax or
  `--param` values.
- **Network failure / timeout** — connectivity or a slow server. Try again, or
  raise the limit with `--timeout 60000`.
- **Empty `results`** — the search matched nothing; broaden the keyword, drop
  an `--fq` filter, or check spelling.

## Global options

These apply to every command and may be given before *or* after it:

| Option | Description |
| --- | --- |
| `-V, --version` | Print the version number |
| `-h, --help` | Show help for the program or a command |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `--base-url <url>` | API base URL (default `https://ckan.govdata.de`) |
| `--timeout <ms>` | Per-request timeout (default `30000`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |

## Learn more

- **[Usage.md](Usage.md)** — full use-case-driven cookbook.
- **[GLOSSARY.md](GLOSSARY.md)** — every CKAN term, search parameter and domain
  concept explained.
- **[DEVELOPING.md](DEVELOPING.md)** — TypeScript library usage, architecture,
  testing, CI.
- **[SKILLS.md](SKILLS.md)** — Claude Code Agent Skills bundled with this repo
  (dataset finder, catalogue stats, resource harvest), installable as a plugin.

## Data license

This CLI is a **client** — it accesses data it does not own or redistribute. The
upstream data is © its provider and licensed **separately from this tool's code**.
See **[DATA_LICENSE.md](DATA_LICENSE.md)**.

> **GovData** — catalogue *metadata* is Datenlizenz Deutschland **Zero** 2.0 (≈ CC0,
> no attribution). Each linked **dataset has its own license** set by its publisher
> — always check the dataset's `dct:license` before reusing its contents.

## License

**Dual-licensed** — use it under **either**:

- **[AGPL-3.0-or-later](LICENSE)** (default, free). Note the AGPL's §13 network
  clause: if you run a modified version as a network service, you must offer that
  modified source to the service's users.
- **Commercial license** (paid), for closed-source / proprietary or SaaS use
  without the AGPL's obligations.

See **[LICENSING.md](LICENSING.md)** for details, and **[CONTRIBUTING.md](CONTRIBUTING.md)**
for the contribution policy (this project does not accept external code
contributions). Commercial enquiries: **sebs@2xs.org**.
