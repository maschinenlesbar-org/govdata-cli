# Developing & integrating

This document covers `govdata-cli` as a **TypeScript library**, plus its
architecture, testing and release setup. If you just want to use the
command-line tool, start with the **[README](README.md)** and
**[Usage.md](Usage.md)** instead.

The package ships both a CLI (`govdata`) and a typed API client
(`GovDataClient`) for the [GovData CKAN Action API](https://www.govdata.de/)
(`ckan.govdata.de`).

**Design goals**

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https` (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed CKAN envelope, search result and parameter objects, plus a generic `action` escape hatch.
- **Well tested** — unit tests on Node's built-in test runner (`node --test`), every HTTP response mocked.
- **Read-only, no auth** — only CKAN read actions are wrapped; no key required.

## Build from source

```bash
npm install
npm run build        # compiles TypeScript to dist/
```

Run the locally built CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link`:
govdata --help
```

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
- A generic `action(name, params)` exposes every read action even where there is no typed
  convenience method. The action name is validated against `^[a-z0-9_]+$` and URL-encoded, so
  it cannot inject extra path segments, query string, or fragments into the request URL.
- Redirects are followed up to `maxRedirects`; if a redirect crosses origin, the request headers
  are dropped so nothing (e.g. a future auth/cookie header) leaks to another host.

### Library / technical terms

**API client.** [`GovDataClient`](src/client/client.ts) — the typed wrapper over
the CKAN Action API, with result-unwrapping and a generic `action` escape hatch.
Usable as a library independently of the CLI.

**Request engine.** [`RequestEngine`](src/client/engine.ts) — builds URLs,
serialises queries, applies retry/backoff, follows redirects, decodes JSON and
maps errors. Sits between the client's action methods and the transport.
`DEFAULT_BASE_URL` is `https://ckan.govdata.de`.

**Transport.** A single function `(HttpRequest) => Promise<HttpResponse>`
([`http.ts`](src/client/http.ts)). The default (`nodeHttpTransport`) uses Node's
built-in `http`/`https`; tests inject a mock. This is the only HTTP seam.

**Query builder.** [`query.ts`](src/client/query.ts) — a dependency-free
query-string serialiser: omits `undefined`/`null`, repeats arrays as repeated
keys (`?fq=a&fq=b`), stringifies booleans/Dates, and encodes spaces as `%20`.

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](src/cli/io.ts)): a client factory plus an I/O object (`out`/`err`).
Lets the whole CLI run in tests with a mocked client and captured output — no
subprocess.

**Error types.** [`errors.ts`](src/client/errors.ts): `GovDataApiError`
(non-2xx, carries `status`/`detail`/`url`, with `isRetryable`),
`GovDataNetworkError` (transport failure/timeout), `GovDataParseError` (bad
JSON), and a `success: false` envelope surfacing the base `GovDataError` — all
extending `GovDataError`. The CLI maps a `404` to exit code `4`, other errors to
`1`.

**Retry / backoff.** Transient `429` (rate limit) and `503` responses are
retried automatically with linear backoff, up to `maxRetries` (`--max-retries`,
default `2`).

**Redirect credential-strip.** Redirects are followed up to `maxRedirects`; if
a redirect crosses origin, request headers are dropped so nothing (e.g. a future
auth/cookie header) leaks to another host.

**`maxResponseBytes`.** A hard cap on response body size (default 100 MiB; `0` =
unlimited) defending against memory exhaustion from a hostile/buggy endpoint.

**`RawResponse`.** The engine's raw-response shape (`data`/`contentType`/`status`)
— exported for completeness; action endpoints return decoded JSON.

**Global options.** CLI-wide flags resolved for every command and translated to
`EngineOptions`: `--base-url`, `--timeout`, `--user-agent`, `--max-retries`,
`--max-response-bytes`, `--compact`. May appear before or after the subcommand.

## Testing

```bash
npm test          # builds, then runs `node --test` over dist/test
```

- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback `http.createServer`.
- **`engine.test.ts`** — URL building, JSON decoding, error mapping, 429/503 retry, redirects — mocked transport.
- **`client.test.ts`** — action URL/param mapping, result unwrapping, `success:false` handling — mocked transport.
- **`cli.test.ts`** — end-to-end command parsing, `--param`/`--fq` handling and exit codes — mocked client.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 20/22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build TypeDoc API docs and deploy to GitHub Pages on each `v*` tag.

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.
