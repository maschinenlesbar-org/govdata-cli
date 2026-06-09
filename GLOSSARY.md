# Glossary

A reference for the domain concepts and project-specific terms used throughout
`govdata-cli`. This tool wraps the **GovData CKAN Action API** (`ckan.govdata.de`),
so the vocabulary is split between the **GovData** open-data programme, the
**CKAN** software that powers the catalogue (and its quirks, e.g. "package" ==
"dataset"), and the **project's own** client/CLI terms.

---

## The GovData programme

**GovData.** The central open-data portal for Germany (`govdata.de`), federating
open datasets from the federal government (Bund), the federal states (Länder) and
municipalities (Kommunen). It is the German node that feeds the European
[data.europa.eu](https://data.europa.eu) portal.

**Open data.** Data published under an open licence for anyone to use, reuse and
redistribute. Everything this tool reaches is open and requires no API key.

**CKAN.** The open-source data-management/cataloguing software (originally by the
Open Knowledge Foundation) that GovData runs on. Its HTTP interface is the
**Action API**, which this client wraps.

**DCAT-AP.de.** The German application profile of the W3C **DCAT** (Data Catalog
Vocabulary) metadata standard. GovData's dataset metadata follows it; it is why a
dataset's raw fields are catalogue-specific and exposed here as untyped JSON.

---

## CKAN core objects

**Dataset (`Package`).** The primary catalogue unit: a described collection of
data on one topic (title, description, publisher, tags, licence, and one or more
resources). CKAN historically calls a dataset a **"package"**, so the API action
names use `package_*` even though the user-facing concept is "dataset". Exposed
as a raw `JsonObject` (`Package`). CLI: `package`, `packages`, `search`.

**Resource (distribution / `Resource`).** A single distributable file or service
endpoint *within* a dataset — e.g. one CSV, JSON, XLSX or WMS URL. A dataset
usually has several. In DCAT terms a resource is a *distribution*. Identified by
its own id. CLI: `resource <id>`.

**Organization (`Organization`).** A data **publisher** — the body that owns and
maintains datasets (e.g. a federal statistics office). Organizations have
membership/ownership semantics in CKAN. CLI: `organizations`, `organization`.

**Group (`Group`).** A thematic grouping / **category** of datasets (e.g. an
open-data theme). Unlike an organization, a group does not own datasets; it
classifies them. CLI: `groups`, `group`.

**Tag.** A free keyword attached to a dataset for discovery. Tags can be listed
and filtered by substring. CLI: `tags [--query <substring>]`.

**Facet.** A field CKAN aggregates over a search result to give value counts
(e.g. how many hits per `organization` or `res_format`). Requested via
`facet_field` and returned under `facets` / `search_facets` in a
`PackageSearchResult`.

---

## CKAN Action API mechanics

**Action API.** CKAN's RPC-style HTTP API, rooted at `/api/3/action/`. Each
endpoint is an **action** addressed by name, e.g. `package_search`,
`package_show`, `organization_list`. This client targets the open, read-only
(`GET`) actions only.

**Action name.** The `[a-z0-9_]+` identifier of an action. The client validates
every name against `^[a-z0-9_]+$` (and URL-encodes it) so the generic escape
hatch cannot inject extra path segments, a query string or a fragment into the
request URL.

**CKAN envelope (`CkanEnvelope`).** Every Action API response is wrapped in
`{ help, success, result }` (or `{ help, success, error }` when `success` is
false). `help` is a docstring URL/text, `success` is the status flag, `result`
is the payload. The client **unwraps `result`** for callers and raises an error
on `success: false`.

**`package_search`.** The full-text / faceted dataset search action. Returns a
`PackageSearchResult` (`count`, `results`, `facets`, `search_facets`, `sort`).
CLI: `search`. Parameters: `q`, `fq`, `rows`, `start`, `sort`, `facet_field`.

**`package_show` / `package_list`.** Fetch one dataset by id/name; list dataset
names with `limit`/`offset`. CLI: `package`, `packages`.

**`organization_show` / `organization_list`, `group_show` / `group_list`.**
Show one / list organizations or groups. The `_list` actions return bare **names**
by default, or full objects with `all_fields`. CLI: `organization(s)`,
`group(s)` (`--all-fields`).

**`tag_list`, `resource_show`.** List tags (optional `query` substring filter);
show one resource by id. CLI: `tags`, `resource`.

**Generic action (escape hatch).** `client.action(name, params)` / the CLI
`action <name> [--param key=value …]` command call **any** read action — even
those without a typed convenience method — and return the unwrapped `result`.

---

## Search parameters (Solr)

CKAN search is backed by **Apache Solr**, so its parameters use Solr syntax.

**`q` (query).** The Solr query string, e.g. `title:Haushalt` or a bare term.
CLI positional: `search [query]`.

**`fq` (filter query).** A repeatable Solr filter constraining results without
affecting relevance scoring, e.g. `organization:destatis`, `res_format:CSV`.
CLI: `--fq` (repeatable).

**`rows` / `start`.** Page size and zero-based offset for paging through search
hits. CLI: `--rows`, `--start`. (The `*_list` actions instead use
`limit` / `offset`.)

**`sort`.** A Solr sort expression, e.g. `metadata_modified desc`. CLI: `--sort`.

**`facet_field`.** The fields to compute facet counts over (see *Facet*).

**`res_format`.** A common facet/filter value: the format of a resource (`CSV`,
`JSON`, `WMS`, …). Used inside an `fq`, not a dedicated flag.

**`metadata_modified` / `metadata_created`.** Timestamp fields on a dataset; the
former is the usual sort key for "newest first".

---

## Identifiers & pagination

**id / name (slug).** Datasets, organizations and groups can be addressed by
either their CKAN **id** (UUID) or their human-readable **name** (URL slug). The
`*_show` actions accept either. Resources are addressed by id only.

**`limit` / `offset` (`ListParams`).** Pagination for the `*_list` actions: page
size and number of records to skip. (Distinct from search's `rows` / `start`.)

**`all_fields`.** On `organization_list` / `group_list`, return full objects
instead of just names. CLI: `--all-fields`.

---

> **Library & internals.** Terms for the TypeScript client and its internals —
> `GovDataClient`, the request engine, transport, retry/backoff, error types,
> query builder — now live in **[DEVELOPING.md](DEVELOPING.md)**.
