// Conformance test P24 (trend analysis 2026-10-21): an input is canonicalised or refused, never
// sent raw. One corpus of tricky values goes through every text filter and every id the repo
// declares, on the CLI and in the library. Either both refuse it before any request (exit 2,
// the validation error), or both send the same request with the value in canonical form: a
// text without surrounding whitespace, in composed Unicode, never blank; an id as the adapter
// canonicalises it, never empty, a dot segment or with a "/". Each value here was once sent raw
// by some *-cli and matched nothing, or the wrong thing, with exit 0. Shared across the *-cli
// repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/govdata-client/internal/http";

// ---- adapter (per repo) -------------------------------------------------------------
import { jsonResponse, parity as govdataParity } from "./helpers.js";
import type { Transport } from "@maschinenlesbar.org/govdata-client/internal/http";
/** The exit code of a usage error in this repo: govdata keeps commander's default, 1. */
const USAGE_EXIT = 1;
import { GovDataClient as Client } from "@maschinenlesbar.org/govdata-client/internal/client";
interface Input {
  name: string;
  /** CLI argv that sends `value`. */
  argv: (value: string) => string[];
  /** The same in the library. */
  lib: (client: Client, value: string) => Promise<unknown>;
  /** The value as it went out, read from the request URL (null when it wasn't sent). */
  sent: (url: URL) => string | null;
}
/**
 * Every text filter (sent as a query parameter): the search text `q` and the tag query, the
 * two free-text values (normalizeText). Solr filters (`--fq`) and `--sort` are query syntax
 * over exact-match fields and field names, sent as written, so they are not text filters here.
 */
const textInputs: Input[] = [
  { name: "search [query]", argv: (v) => ["search", v], lib: (c, v) => c.packageSearch({ q: v }), sent: (u) => u.searchParams.get("q") },
  { name: "tags --query", argv: (v) => ["tags", "--query", v], lib: (c, v) => c.tagList(v), sent: (u) => u.searchParams.get("query") },
];
/**
 * Every id that goes into a request path (sent as its last segment). In CKAN that is only the
 * action name of `govdata action <name>` (`/api/3/action/<name>`, `^[a-z0-9_]+$`); the dataset,
 * resource, organization and group ids of the `*_show` commands go out as the `id` query
 * parameter, never into the path.
 */
const idInputs: Input[] = [
  { name: "action", argv: (v) => ["action", v], lib: (c, v) => c.action(v), sent: (u) => decodeURIComponent(u.pathname.slice(u.pathname.lastIndexOf("/") + 1)) },
];
/** The id as the repo sends it (trimmed; a repo with numeric ids may drop leading zeros). */
const canonicalId = (value: string): string => value.trim();
/** A valid answer to any of these requests (a CKAN envelope of the shape each action expects). */
const respond = (req: HttpRequest): HttpResponse => {
  const action = new URL(req.url).pathname.split("/").pop() ?? "";
  if (action === "package_search") return jsonResponse({ help: "h", success: true, result: { count: 0, results: [] } });
  return jsonResponse({ help: "h", success: true, result: action === "tag_list" ? [] : { id: action } });
};
/** govdata's harness in the kit's shape: the responder as the third argument, the library's error as `{ name, message }`. */
async function parity(argv: string[], call: (transport: Transport) => unknown, responder: (req: HttpRequest) => HttpResponse) {
  const o = await govdataParity(argv, async (t) => call(t), { responder });
  const e = o.lib.error;
  return { cli: o.cli, lib: { ...o.lib, error: e instanceof Error ? { name: e.constructor.name, message: e.message } : undefined } };
}
// --------------------------------------------------------------------------------------

const TEXT_CORPUS = [
  "Müller", "Müller", "  Müller  ", " Müller ", "Müller\n", "\tMüller", "a  b", "Å",
  "ﬁ", "x".repeat(5000), "", " ", " ", "\n\t", "　",
];
const ID_CORPUS = ["a1", " a1 ", "a1\n", " a1", ".", "..", " .. ", "a1/../a2", "a1/", "/a1", "", "  ", "%2e%2e", "a b"];

type Outcome = Awaited<ReturnType<typeof parity>>;

/** Both sides refused before any request, or both sent the same requests. Returns the one sent URL, if any. */
function sameOutcome(o: Outcome, label: string): URL | undefined {
  if (o.cli.code === USAGE_EXIT) {
    assert.deepEqual(o.cli.requests, [], `${label}: the CLI refused but sent a request`);
    assert.equal(o.lib.ok, false, `${label}: the CLI refused, the library resolved`);
    assert.deepEqual(o.lib.requests, [], `${label}: the library sent a request`);
    assert.match(o.lib.error?.name ?? "", /ValidationError$/, `${label}: ${String(o.lib.error)}`);
    return undefined;
  }
  assert.equal(o.cli.code, 0, `${label}: CLI exit ${o.cli.code}: ${o.cli.err}`);
  assert.equal(o.lib.ok, true, `${label}: the library rejected: ${String(o.lib.error)}`);
  assert.deepEqual(o.lib.requests.map((r) => r.url), o.cli.requests.map((r) => r.url), `${label}: different requests`);
  assert.equal(o.cli.requests.length, 1, label);
  return new URL(o.cli.requests[0]!.url);
}

test("P24: a text filter is sent trimmed and in composed Unicode, or refused; never blank", async () => {
  for (const input of textInputs) {
    for (const value of TEXT_CORPUS) {
      const label = `${input.name} ${JSON.stringify(value.length > 20 ? `${value.slice(0, 20)}…` : value)}`;
      const url = sameOutcome(await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond), label);
      if (value.trim() === "") {
        assert.equal(url, undefined, `${label}: a blank value was sent (it reads as "no filter")`);
        continue;
      }
      if (url === undefined) continue;
      const sent = input.sent(url);
      assert.ok(sent !== null && sent !== "", `${label}: not sent`);
      const canonical = [value.trim().normalize("NFC"), value.trim().normalize("NFKC")];
      assert.ok(canonical.includes(sent), `${label}: sent ${JSON.stringify(sent)}`);
    }
  }
});

test("P24: an id is sent in its canonical form, or refused; never empty, a dot segment or with a slash", async () => {
  for (const input of idInputs) {
    for (const value of ID_CORPUS) {
      const label = `${input.name} ${JSON.stringify(value)}`;
      const url = sameOutcome(await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond), label);
      const id = canonicalId(value);
      if (id === "" || id === "." || id === ".." || id.includes("/")) {
        assert.equal(url, undefined, `${label}: sent although it would re-target the request`);
        continue;
      }
      if (url === undefined) continue;
      assert.equal(input.sent(url), id, label);
    }
  }
});
