# govdata-cli — Claude Code Skills

A set of [Claude Code](https://code.claude.com/docs/en/skills) **Agent Skills** for
exploring Germany's central open-data catalogue, all powered by the **[govdata](README.md)**
CLI over the open [GovData CKAN Action API](https://www.govdata.de/) (`ckan.govdata.de`).

Each skill teaches Claude how to drive the `govdata` CLI to answer a specific, real-world
question — "what open data is there on air quality?", "which organizations publish the
most transport datasets?", "get me all the CSVs about household statistics" — and to
report the answer with evidence rather than guesswork. They encode the parts of CKAN that
are easy to get wrong (the empty package-level licence, the format values stored twice, the
cryptic theme codes, the unsorted facets) so Claude doesn't have to rediscover them each
time.

## Skills

| Skill | What it does | Ask it… |
|---|---|---|
| **govdata-dataset-finder** | Searches a topic, ranks and dedupes hits, and enriches each with publisher, formats, the *real* per-resource licence and download links. | "find datasets about Luftqualität", "newest open data from destatis", "is there CSV data on Haushalt?" |
| **govdata-catalogue-stats** | Builds counts and rankings via CKAN facets — publishers, formats, licences, themes — folding the duplicated/messy facet values into a clean breakdown. | "which orgs publish the most Verkehr datasets?", "what file formats dominate the catalogue?", "the licence landscape on GovData" |
| **govdata-resource-harvest** | Flattens many datasets into a manifest of downloadable files with direct URLs, format, size and licence — handling the format-filter trap. | "get all the CSVs about flood maps", "download links for one publisher's data", "build a file list for X" |

## Requirements

- **[Claude Code](https://code.claude.com/docs/en/overview)** (or any harness that loads
  Agent Skills).
- **The `govdata` CLI** installed globally:
  ```bash
  npm i -g @maschinenlesbar.org/govdata-cli   # installs the `govdata` bin
  ```
  No API key is required — the GovData CKAN API is free, open, and read-only.

## Installation

### Plugin marketplace (recommended)

This repo is a Claude Code **plugin marketplace**, so installation is two commands inside
Claude Code:

```
/plugin marketplace add maschinenlesbar-org/govdata-cli
/plugin install govdata@govdata-skills
```

The first command registers the marketplace; the second installs the `govdata` plugin,
which bundles all three skills. Update later with `/plugin marketplace update`.

### Manual (copy the skill folders)

Prefer not to use the marketplace? Copy the skills into your **personal** directory
(available across all your projects):

```bash
git clone https://github.com/maschinenlesbar-org/govdata-cli tmp-skills
mkdir -p ~/.claude/skills
cp -R tmp-skills/skills/* ~/.claude/skills/
rm -rf tmp-skills
```

…or into a single project's `.claude/skills/` by swapping `~/.claude/skills` for
`.claude/skills`. Each skill lives in its own directory with a `SKILL.md`, e.g.
`skills/govdata-dataset-finder/SKILL.md`. Start a new Claude Code session and the skills
are picked up automatically.

## Usage

You don't normally invoke these by name — Claude auto-selects the right skill from your
request. Just ask in natural language:

> Find recent open datasets about Luftqualität and show me the download formats.

> Which organizations publish the most datasets about Verkehr?

> Build me a manifest of all the CSV files about Haushalt I can download.

You can also invoke a skill explicitly with its slash command, e.g. `/govdata-dataset-finder`.

## How it works

Every skill is a single `SKILL.md` — a short, model-facing playbook describing which
`govdata` subcommands to call, in what order, and how to interpret the JSON. The skills
encode the non-obvious parts of this catalogue, for example:

- **the package-level licence is unreliable** — `license_id` / `license_title` are empty
  and `isopen` is `false` for the vast majority of datasets even when the data is openly
  licensed; the real licence is a DCAT-AP URI on each `resources[].license`
  (see **govdata-dataset-finder**);
- **formats are stored twice** — the same format appears as a clean string (`CSV`) *and*
  an EU-vocabulary URI (`…/file-type/CSV`), with the URI variant the more common one, so
  a naive `--fq res_format:CSV` misses most matches and a naive format tally undercounts
  every format (see **govdata-resource-harvest**, **govdata-catalogue-stats**);
- **facets aren't sorted** — `search_facets.<field>.items[]` come back unordered and must
  be sorted by `count`; use `display_name`, not the slug/URI `name`, for org and licence
  labels (see **govdata-catalogue-stats**);
- **themes are cryptic codes** — group names are 4-letter DCAT codes (`tran`, `envi`,
  `soci`); resolve them via `govdata groups --all-fields`;
- the `search` command exposes no facet flags — facet breakdowns go through the generic
  `action package_search` escape hatch, whose `--param` keys must be unique;
- a `num_resources: 0` dataset is a **metadata-only stub** with nothing to download, and
  WMS/WFS/`view` "formats" are map service endpoints, not files;
- an empty search is `{"count":0,"results":[]}` at exit `0` (a valid "nothing matched"),
  exit `4` is a not-found id, exit `1` is a real error.

## Contributing

This project does not accept external code contributions (see
[CONTRIBUTING.md](CONTRIBUTING.md)). When adding a skill internally, keep `SKILL.md`
focused, give it a `description` with concrete trigger phrases, and follow the
[official skill format](https://code.claude.com/docs/en/skills).

## License

[AGPL-3.0-or-later](LICENSE) © Sebastian Schürmann. See [LICENSING.md](LICENSING.md) for
the dual-licensing / commercial option.
