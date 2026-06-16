# Data license

> **This tool does not include, host, or redistribute any data.**
> `govdata-cli` is a *client*. It only accesses records served live by
> **GovData.de** (operated by FITKO for the Bund and Länder). Those records are
> governed by **GovData's** terms, summarized below. The license of this CLI's own
> source code is a separate matter — see [LICENSING.md](LICENSING.md).

> [!IMPORTANT]
> **Two layers — do not conflate them.** This CLI returns catalogue **metadata**,
> which is freely reusable. The **actual datasets** that metadata points to each
> carry their **own** license, set by the publishing authority. Always check a
> dataset's own license before reusing its *contents*.

| | |
|---|---|
| **Data provider** | GovData (FITKO, for Bund/Länder) |
| **API / source** | `https://ckan.govdata.de` (CKAN Action API) · portal: https://www.govdata.de/ |
| **Metadata license** | **Datenlizenz Deutschland – Zero – Version 2.0 (`dl-de/zero-2-0`)** — equivalent to CC0; the license text explicitly covers "Daten und Metadaten". |
| **License text** | https://www.govdata.de/dl-de/zero-2-0 |
| **Attribution (metadata)** | **Not required** (CC0-equivalent). |
| **Commercial use (metadata)** | Allowed, without conditions. |
| **Redistribution / modification (metadata)** | Fully permitted, no conditions. |

## The per-dataset layer (read this)

Each catalogued dataset's **own** license is chosen by its publishing authority
and is **heterogeneous** — `dl-de/zero-2-0`, `dl-de/by-2-0`, `CC0`, `CC BY 4.0`,
and others, including some non-open terms. GovData's FAQ states it plainly:
*"Die Datenbereitstellenden entscheiden darüber, welche Nutzungsbestimmungen für
ihre Datensätze und Dokumente gelten sollen."*

When you download or redistribute actual dataset content (via a resource `url`),
you **must** check and comply with that dataset's:

- `dct:license` — the governing license (decisive at the Distribution level), and
- `dcatde:licenseAttributionByText` — any required attribution string.

## Attribution

```
Metadata from GovData (https://www.govdata.de), licensed under
Datenlizenz Deutschland – Zero – Version 2.0 (dl-de/zero-2-0).
Individual datasets carry their own per-dataset licenses — check each
dataset's dct:license before reuse.
```

## Sources

- https://www.govdata.de/dl-de/zero-2-0 — DL-DE Zero 2.0 (covers "Daten und Metadaten")
- https://www.govdata.de/informationen/faq — publishers set per-dataset terms
- https://www.dcat-ap.de/ — `dct:license` / `dcatde:licenseAttributionByText`

---

*Good-faith summary compiled 2026-06-16; not legal advice. GovData's terms are
authoritative and can change. The metadata is CC0-equivalent, but **per-dataset
licenses vary** — always verify the individual dataset's terms before reuse.*
