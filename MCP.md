# govdata-mcp

An [MCP](https://modelcontextprotocol.io/) server for [GovData](https://www.govdata.de/),
Germany's central open-data catalogue: about 170,000 datasets of federal, Land and city bodies,
harvested from their portals, to find, count by organization, format, licence or theme, and to
list their download links, as tools for AI agents. Read-only, no API key. The catalogue's
metadata are DL-DE Zero 2.0; the files a dataset links to carry their publisher's own licence (see
Licence).

It is the MCP side of [govdata-cli](https://github.com/maschinenlesbar-org/govdata-cli),
built on the same typed client, and released with it.

## Install

```bash
npm i -g @maschinenlesbar.org/govdata-mcp
```

This installs the **`govdata-mcp`** command (Node.js 22.12+). Or run the container
image, for linux/amd64 and linux/arm64, which needs no Node.js:

```bash
docker run -i --rm ghcr.io/maschinenlesbar-org/govdata-mcp:latest
```

## Connect a client

The server speaks MCP on stdio by default.

**Claude Code**

```bash
claude mcp add govdata -- govdata-mcp
# or with the image:
claude mcp add govdata -- docker run -i --rm ghcr.io/maschinenlesbar-org/govdata-mcp:latest
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{ "mcpServers": { "govdata": { "command": "govdata-mcp" } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "govdata": { "type": "stdio", "command": "govdata-mcp" } } }
```

**Over HTTP** (Streamable HTTP, one endpoint `POST /mcp`):

```bash
govdata-mcp --transport http            # http://127.0.0.1:3000/mcp
claude mcp add --transport http govdata http://127.0.0.1:3000/mcp
```

In a container, publish the port on loopback only:
`docker run --rm -p 127.0.0.1:3000:3000 ghcr.io/maschinenlesbar-org/govdata-mcp:latest --transport http --host 0.0.0.0 --allowed-hosts localhost,127.0.0.1`.

For scripts and shared configs, pin a release and its digest from the
[release notes](https://github.com/maschinenlesbar-org/govdata-cli/releases) instead of
`latest`: `…/govdata-mcp:<version>@sha256:<digest>`. Check an image's provenance with
`gh attestation verify oci://ghcr.io/maschinenlesbar-org/govdata-mcp:<version> --repo maschinenlesbar-org/govdata-cli`.

## Tools

| Tool | What it answers |
|---|---|
| `findDatasets` | Datasets for a topic and filters (organization by name, publisher, theme, file format, only with files), a page at a time: name, title, organization, publisher, dates, number of files, formats and the licences the files carry. |
| `countDatasets` | How many datasets match, and their distribution by organization, file format, licence, theme or tag: sorted, a format's spellings and a licence's variants folded into one value. |
| `listFiles` | The files of the matching datasets as a download manifest, grouped by dataset: each link with its kind (file, generated on request, service, landing page, template, broken), format, size, its own licence and attribution text. |
| `getDataset` | One dataset by its name, id or page link: description, publisher and contact, themes, tags, dates, where it was harvested from, every file with its licence. |
| `listOrganizations` | The catalogue's organizations (Länder portals and federal bodies) with their slugs and dataset counts; by name, those that contain it. |

Every tool only reads. An answer is JSON (`structuredContent` and the same as text), with the
`source` it came from and the data licence. Counts come from the catalogue's total, never from
paging. GovData stores one format under two spellings (CSV and an EU vocabulary URI): a format
filter matches both, a count folds them (and says when the sum is an upper bound). The licence is
read from each file, since the dataset-level field is empty for most datasets. An organization
that fits several is reported with the candidates, never guessed; an unknown dataset or an empty
search is said in words, with what to try. A failure is a tool error that says what to change.

## Options

```
--transport <stdio|http>   stdio (default), or Streamable HTTP on POST /mcp
--host <address>           HTTP: the address to listen on (default 127.0.0.1)
--port <n>                 HTTP: the port (default 3000)
--allowed-hosts <list>     HTTP: Host header names to answer (default localhost,127.0.0.1,[::1])
--allowed-origins <list>   HTTP: browser origins allowed to call, exactly (https://app.example.org); none by default
--auth-token-file <path>   HTTP: a file with the bearer token every request must send (mode 600, 32+ characters)
--base-url <url>           API base URL (default https://ckan.govdata.de)
--timeout <ms>             per upstream request (default 30000)
--call-timeout <ms>        per tool call, retries included (default 45000)
--max-result-chars <n>     cap on one tool result's JSON (default 25000)
--max-pages <n>            pages a tool reads per list and call (default 10)
--user-agent <ua>          User-Agent header value (Latin-1, one line)
--log-format <text|jsonl>  the log records on stderr (default text)
```

## What it does and doesn't do

- **Read-only.** No tool changes anything, here or upstream.
- **No authentication** on HTTP unless you give one. It listens on loopback by default; it checks
  the `Host` header and, from a browser, the `Origin` (only the origins given with
  `--allowed-origins`, matched exactly) against DNS rebinding and other web pages; a page on one of
  those origins gets CORS (its preflight answered, the answers readable). With `--auth-token-file
  <path>` every request must send `Authorization: Bearer <token>` (the file holds one token of at
  least 32 characters, mode 600, owned by the user the server runs as, a regular file (a FIFO is
  refused at once, never waited on); read once at start; `(umask 077; openssl rand -hex 32 >
  mcp-token)` makes one); anything else is answered 401. Exposed beyond localhost (it logs a warning
  then), it belongs behind a proxy that authenticates or at least terminates TLS.
- **Gentle with the upstream.** One server process sends at most 2 requests at a time and 120 a
  minute to the API, pauses on HTTP 429 (as long as its Retry-After asks, at most 30 s), and stops a
  tool call after its deadline (a tool that has read part of its answer by then may answer with that
  part, and says so). A request those limits would hold longer than it or its call may wait is not
  sent: the call fails at once, naming the limit and when to ask again (and the log says so).
- **Results are data.** Text from the API is cleaned (control, bidi and zero-width characters
  removed), but it is still other people's text: a model can be told things in it. The server
  can't act on that (it has no tool that writes), but other tools in the same session could.
- **Stops cleanly.** On `docker stop` (SIGTERM) or Ctrl-C the HTTP server takes no new connection
  and lets calls in flight answer for up to 5 s, then exits 143 (130); a second signal ends it at
  once. On stdio a signal ends it at once; when stdin ends, it first answers the requests it has
  read (each within its call deadline), then exits.
- **In a container** it needs at least 12 processes and threads (`--pids-limit`) and about
  256 MB of memory. The answers it reads are small (a search reads at most 50 datasets; a
  facet count reads no datasets).
- **Logs** go to stderr, one record per line; stdout carries only the protocol. A call that fails
  upstream or reaches its deadline leaves a WARN record naming the tool.
- **Never installs anything.**

## Licence

Code: AGPL-3.0-or-later or commercial
([LICENSING.md](https://github.com/maschinenlesbar-org/govdata-cli/blob/main/LICENSING.md)).
Data: GovData's catalogue metadata are under the Datenlizenz Deutschland – Zero – Version 2.0
(https://www.govdata.de/dl-de/zero-2-0): free to use, commercially too, no attribution required
([DATA_LICENSE.md](https://github.com/maschinenlesbar-org/govdata-cli/blob/main/DATA_LICENSE.md)).
The files a dataset links to are not covered: each carries the licence its publisher chose
(DL-DE BY 2.0, DL-DE Zero 2.0, CC BY 4.0, CC0, and some that are not open, such as other-closed),
sometimes with an attribution text it asks for. One dataset can mix licences. Every result
carries this note in its `licence` field; `findDatasets`, `listFiles` and `getDataset` give the
licence of each dataset's files and of each file. Check a file's own licence before reusing it.
We provide the tool, not the data.
