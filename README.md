# govdata-cli

A TypeScript **API client** and **command-line interface** for the open
[GovData](https://www.govdata.de/) **CKAN Action API** (`ckan.govdata.de`) — the
central German open-data catalogue (Bund/Länder/Kommunen): search datasets,
inspect packages, organizations, groups, tags and resources.

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https` (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed CKAN envelope, search result and parameter objects, plus a generic `action` escape hatch.
- **Well tested** — unit tests on Node's built-in test runner (`node --test`), every HTTP response mocked.
- **Read-only, no auth** — only CKAN read actions are wrapped; no key required.

## Requirements

- Node.js **>= 20** (uses the stable built-in test runner, ESM and top-level `await`).

## Install

```bash
npm install
npm run build        # compiles TypeScript to dist/
```

Run the CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link` / global install:
govdata --help
```

---

## CLI usage

CKAN wraps every response in `{ help, success, result }`; this CLI prints the
unwrapped **`result`** (and exits non-zero if `success` is false). `--compact` for
a single line.

### Global options

| Option | Description |
| --- | --- |
| `--base-url <url>` | API base URL (default `https://ckan.govdata.de`) |
| `--timeout <ms>` | Per-request timeout (default `30000`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |
| `--compact` | Print JSON on a single line |

Global options may be given before or after the command, e.g.
`govdata --compact search Haushalt` or `govdata search Haushalt --compact`.

### Commands

```text
search [query] [--rows <n>] [--start <n>] [--sort <expr>] [--fq <filter> ...]
package <id>                  show one dataset
packages [--limit] [--offset] list dataset names
organizations [--all-fields]  list organizations (publishers)
organization <id>             show one organization
groups [--all-fields]         list groups (themes)
group <id>                    show one group
tags [--query <substring>]    list tags
resource <id>                 show one resource (distribution)
action <name> [--param key=value ...]   call any CKAN action (generic)
```

### Examples

```bash
# Search datasets, newest first
govdata search Haushalt --rows 5 --sort "metadata_modified desc"

# Filter by organization and format
govdata search --fq organization:destatis --fq res_format:CSV

# A specific dataset
govdata package <dataset-id-or-name>

# Publishers
govdata organizations

# Any action not wrapped above
govdata action package_search --param q=Klima --param rows=3
```

Exit codes: `0` success (and for `--help`/`--version`), `4` on a `404` from the API, `1` for any other error (incl. a CKAN `success:false`) and for commander usage/parse errors.

---

## Library usage

```ts
import { GovDataClient, GovDataError } from "@maschinenlesbar.org/govdata-cli";

const client = new GovDataClient(); // defaults to https://ckan.govdata.de

const hits = await client.packageSearch({ q: "Haushalt", rows: 5 });
const dataset = await client.packageShow(hits.results[0]!.id as string);
const orgs = await client.organizationList();

// Generic escape hatch for any read action:
const tags = await client.action<string[]>("tag_list", { query: "energie" });

try {
  await client.packageShow("does-not-exist");
} catch (err) {
  if (err instanceof GovDataError) console.error(err.message);
}
```

### Client options

```ts
new GovDataClient({
  baseUrl: "https://ckan.govdata.de",
  timeoutMs: 15_000,
  maxRetries: 3,              // 429 / 503 are retried with linear backoff
  maxResponseBytes: 50 << 20, // abort responses larger than 50 MiB (0 = unlimited)
  userAgent: "my-app/1.0",
  transport: customTransport, // inject your own HTTP transport
});
```

### Methods

`packageSearch`, `packageShow`, `packageList`, `organizationList`, `organizationShow`,
`groupList`, `groupShow`, `tagList`, `resourceShow`, and the generic `action(name, params)`.

---

## Architecture

```
src/
  client/
    types.ts     # CkanEnvelope, PackageSearchResult + parameter objects
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, redirects, JSON decoding, error mapping
    errors.ts    # GovDataError / GovDataApiError / GovDataNetworkError / GovDataParseError
    client.ts    # GovDataClient — CKAN actions over the engine (with result-unwrapping)
  cli/
    io.ts        # injectable I/O seam (stdout/stderr)
    shared.ts    # option parsers, global-option resolver, JSON renderer
    commands/    # search / package / organizations / groups / tags / resource / action
    program.ts   # assembles the commander program from injectable deps
    run.ts       # parses argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
```

**Design notes**

- The HTTP layer is a single `Transport` function (`(req) => Promise<HttpResponse>`). The default
  uses `node:http`/`node:https`; tests inject a mock. This keeps the client free of any HTTP framework.
- The client unwraps CKAN's `{ help, success, result }` envelope and raises `GovDataError`
  when `success` is false, so callers work directly with `result`.
- A generic `action(name, params)` exposes every read action even where there is no typed convenience method. The action name is validated against `^[a-z0-9_]+$` and URL-encoded, so it cannot inject extra path segments, query string, or fragments into the request URL.
- Redirects are followed up to `maxRedirects`; if a redirect crosses origin, the request headers are dropped so nothing (e.g. a future auth/cookie header) leaks to another host.

---

## Testing

```bash
npm test          # builds, then runs `node --test` over dist/test
```

- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback `http.createServer`.
- **`engine.test.ts`** — URL building, JSON decoding, error mapping, 429/503 retry, redirects — mocked transport.
- **`client.test.ts`** — action URL/param mapping, result unwrapping, success:false handling — mocked transport.
- **`cli.test.ts`** — end-to-end command parsing, `--param`/`--fq` handling and exit codes — mocked client.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 20/22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build TypeDoc API docs and deploy to GitHub Pages on each `v*` tag.

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
