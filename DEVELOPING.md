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
  maxRetries: 3,              // 429 / 503 are retried (Retry-After, else linear backoff)
  maxResponseBytes: 50 << 20, // abort responses larger than 50 MiB (0 = unlimited)
  userAgent: "my-app/1.0",    // not blank; no control characters but tab; Latin-1 only
  transport: customTransport, // inject your own HTTP transport
});
```

`userAgent` goes through `assertHeaderValue` (exported; the rule is `headerValueProblem`,
which `--user-agent` uses too): a blank value, a C0 control other than tab (CR/LF
included), DEL or a character above U+00FF throws `GovDataValidationError` at
construction, so it never reaches a custom transport as a forged header. Only `undefined`
selects the default `govdata-cli`. Should a transport call still be handed a header Node
cannot send, the default transport rejects with `GovDataNetworkError` `Invalid request: …`,
never a raw `TypeError`.

`baseUrl` is checked as given, before its trailing slashes are stripped, by the exported
`validateBaseUrl()` (the rule is `baseUrlProblem`, which `--base-url` uses too): a blank
value, whitespace around or in it or a control character (`new URL()` trims and drops
tab/newline silently, but the engine glues the raw value into every request URL, so
`https://ckan.govdata.de/ ` would otherwise request `/%20/api/3/...`), anything but an
absolute http(s) URL, a query or fragment, and a `%` in the user name or password that
doesn't start an escape (write a literal `%` as `%25`) all throw `GovDataValidationError`
`Invalid base URL: …` at construction — a configuration mistake, never a
`GovDataNetworkError`. Only `undefined` selects the default. Userinfo is allowed (sent as
Basic auth) and never quoted in a message. The CLI also redacts on output: `run.ts`
(`withRedactedOutput`) takes the exact userinfo of every argument (`credentialsIn`,
exported) and replaces it with `***` in everything it prints — commander's usage errors,
which echo rejected values (a `--base-url` with a query, an excess argument), and its own
messages (unknown command, a rejected `--param`) — so a password with spaces, quotes, `#`,
`?` or `/` is caught as well as an ordinary one. `redactUrl` falls back to the same
text-based cut (`redactCredentials`, exported) for a value that doesn't parse as a URL.

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
    errors.ts    # GovDataError / GovDataApiError / GovDataNetworkError / GovDataParseError / GovDataValidationError
    validate.ts  # the input rules (`…Problem` functions) and assertValid
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

- **Input validation.** The library owns every input rule. The rules are pure `…Problem`
  functions in `validate.ts` (the reason a value is invalid, or `undefined`); the library
  enforces them with `assertValid` before any request and throws (a promise-returning method
  rejects with) `GovDataValidationError`, a `GovDataError`, with the message
  `Invalid <name>: <reason>`. The CLI's value parsers call the same functions, so the CLI and
  the library refuse the same inputs, and `run.ts` reports a `GovDataValidationError` as a
  usage error (exit 1).
- The HTTP layer is a single `Transport` function (`(req) => Promise<HttpResponse>`). The default
  uses `node:http`/`node:https`; tests inject a mock. This keeps the client free of any HTTP framework.
- The client unwraps CKAN's `{ help, success, result }` envelope and raises `GovDataError`
  when `success` is false, so callers work directly with `result`. A body that is not an
  envelope (`null`, an array, no boolean `success`) or has no `result` is a
  `GovDataParseError` (`Unexpected response shape from /api/3/action/<name>: expected …`), and
  the typed methods check the result's top-level shape (an object for `*_show`, an array for
  the lists, `count` + `results` for `package_search`); the generic `action` passes any result
  through. A response nested too deeply to print is a clear error, not a stack overflow.
- Library input is checked before any request, as the CLI checks its options: a blank `q`,
  `sort`, `fq`/`facet_field` entry, tag query or id, a blank `action()` parameter name or
  value (or list entry), an invalid action name, or a paging value that is not a
  non-negative integer throws `GovDataValidationError` (`Invalid <name>: expected …, got …`;
  blank is `isBlank`/`textProblem` in `validate.ts`, which the CLI's `parseNonEmpty` and
  `--param` use too; `undefined`/`null` still mean "not given"), and the
  engine's numeric options must be integers in range (`timeoutMs` 0..2^31 − 1, `maxRetries`
  0..10, `retryDelayMs` 0..30000, `maxRedirects` 0..20, `maxResponseBytes` ≥ 0; `0` disables
  the timeout, retries, redirects or size cap).
- A generic `action(name, params)` exposes every read action even where there is no typed
  convenience method. The action name is validated against `^[a-z0-9_]+$` and URL-encoded, so
  it cannot inject extra path segments, query string, or fragments into the request URL.
- Redirects are followed up to `maxRedirects`; if a redirect crosses origin (scheme + host + port,
  so a same-host `https:` -> `http:` downgrade counts), only the engine's own `Accept` and
  `User-Agent` headers go along, so nothing else (e.g. a future auth/cookie header) leaks to
  another host or crosses the wire in cleartext.

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
keys (`?fq_list=a&fq_list=b`), stringifies booleans/Dates, and encodes spaces as
`%20`. CKAN does not accept every parameter repeated: a repeated `fq` fails with
HTTP 409 and a lone `fq_list` is split into characters. A single `fq` is no way
out either: CKAN puts `+capacity:public` in front of it, and a top-level `OR` in
the filter then stops filtering. So `packageSearch` sends every filter as
`fq_list`, a single one twice (parentheses would break a negated filter: Solr
matches nothing for a nested `(-organization:x)`). Facet fields go out as the
JSON list `facet.field` expects.

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](src/cli/io.ts)): a client factory plus an I/O object (`out`/`err`).
Lets the whole CLI run in tests with a mocked client and captured output — no
subprocess.

**Error types.** [`errors.ts`](src/client/errors.ts): `GovDataApiError`
(non-2xx, carries `status`/`detail`/`url`, with `isRetryable`),
`GovDataNetworkError` (transport failure/timeout, including the default transport's
per-hop scheme check), `GovDataParseError` (bad JSON, or an answer that is not a CKAN
envelope of the expected shape), `GovDataValidationError` (an input refused before any
request: a bad client option such as the base URL or User-Agent, or a bad method
parameter), and a `success: false` envelope surfacing the base `GovDataError` — all
extending `GovDataError`. Whatever an injected transport throws becomes a
`GovDataNetworkError` (`GET <url> failed: <reason>`, the original as `cause`); the
default transport's network errors read the same way, so they name the request. No
error and no client shows the base URL's password: the engine keeps the base URL in a
real `#private` field (so `console.log(client)`, `util.inspect` and `JSON.stringify`
don't reveal it), every URL in a message goes through `redactUrl`, and the base URL's
userinfo (raw and percent-decoded) is scrubbed from error bodies and details, redirect
targets, transport error text and the `cause` chain. The CLI maps a `404` to exit code
`4`, other errors to `1`.

**Retry / backoff.** Transient `429` (rate limit) and `503` responses are
retried automatically, up to `maxRetries` (`--max-retries`, `0`–`10`, default
`2`). Each retry waits the response's `Retry-After` (delay-seconds or an
IMF-fixdate, parsed strictly by `parseRetryAfter`); without a usable one the
backoff is linear (200 ms, 400 ms, …). A `Retry-After` above 30 s
(`MAX_RETRY_AFTER_MS`) is not retried: the error surfaces at once.

**Redirect credential-strip.** The one credential the client can send is the
userinfo of a base URL you set (`https://user:pw@mirror/`, for a mirror behind a
login). The engine never puts it into the URL a transport sees: it sends it as an
`Authorization: Basic` header per hop. Redirects are followed up to `maxRedirects`; a
redirect to the same origin, with a relative or an absolute `Location`, keeps the
header. If a redirect crosses origin — comparing the full origin (scheme + host +
port), so a same-host `https:` -> `http:` *downgrade* and an `http:` -> `https:`
upgrade count too — only the engine's own `Accept` and `User-Agent` are kept (an
allowlist, not a list of credential headers, which is never complete), so nothing
else leaks to another host or crosses the wire in cleartext; a `401`/`403` from the
target then says so ("the server redirected http→https, which dropped the base URL's
credentials; use an https base URL"). Userinfo in a `Location` is never used.
Transports are told `redirect: "manual"` (`HttpRequest.redirect`): the engine follows
redirects itself, and a response whose `HttpResponse.url` lies on another origin (a
fetch transport that followed one) is rejected as a `GovDataNetworkError`. Redirects to a non-`http(s)` scheme are rejected
(the transport re-checks the scheme per hop). A redirect *is* still followed to
any origin, including private/link-local addresses; because this CLI is keyless
and only renders the response to the local user's terminal, that pivot yields an
attacker nothing, so no private-address block is imposed. Only 301/302/303/307/308
with a parseable `Location` are followed; any other 3xx (300, 304, 305, 306), a
missing or malformed `Location` and the redirect limit surface as a
`GovDataApiError` with a `location` field: `HTTP 302 for GET …: redirect to <target>
not followed`, plus `(stopped after 5 redirects)` at the limit.

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
- **`parity.test.ts`** — CLI ↔ library parity: one input through `run()` and through the library on one mock transport (`parity()` in `helpers.ts`), same outcome on both sides.
- **`validate.test.ts`** — `assertValid`, the `…Problem` rules, and how `run.ts` reports a `GovDataValidationError`.
- **`cli.test.ts`** — end-to-end command parsing, `--param`/`--fq` handling and exit codes — mocked client.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 20/22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build the project website (`site/`, English and German) with the TypeDoc API docs
  under `/api/`, and deploy both to GitHub Pages on each `v*` tag.
  TypeDoc runs from the isolated, lockfile-pinned `tools/docs/` toolchain because it
  needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships; locally,
  run `npm ci --prefix tools/docs` once before `npm run docs`.

## Website

The project website — <https://maschinenlesbar-org.github.io/govdata-cli/> in English and
<https://maschinenlesbar-org.github.io/govdata-cli/de/> in German — is built from `site/` with
[Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web components and
[Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the TypeDoc API
reference under `/api/`. Its content comes from this repository: the README intro and quick
start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`), `Usage.md`,
`GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill examples in
`EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are `site/_config.yml` and
`site/_data/project.yml` (the German intro and the access requirements); the rest of `site/` is
identical in every maschinenlesbar.org CLI, so change it in all of them together. When the
README intro changes, update the German intro in `site/_data/project.yml`.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/govdata-cli/
```

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.
