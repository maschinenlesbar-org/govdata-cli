// Conformance test P10 (fix plan 2026-10-06): a filter the API would ignore never goes out.
// An unknown, misspelled or `__proto__` key, an unknown filter name, an array or NaN where
// the API takes one value are the library's validation error before any data request; a
// filter name that is only spelled differently (NFD, padding, case) is normalised or
// rejected, never sent as typed; a repeated filter flag is combined or rejected, never
// "last one wins". The API answers all of these with the whole unfiltered set or a wrong
// count and HTTP 200. Shared across the *-cli repos with filters; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { run } from "../src/cli/run.js";
import { GovDataClient as Client } from "../src/client/client.js";
import { GovDataValidationError as ValidationError } from "../src/client/errors.js";
/** The library's filtered call, with its query/parameter object passed through as is. */
const call = (client: Client, query: Record<string, unknown>): Promise<unknown> =>
  client.packageSearch(query as never);
/** A valid query, and the filters it sends (read back from the request by `sentFilter`). */
const GOOD = { query: { fq: ["organization:open-nrw", "groups:tran"] } };
const GOOD_SENT = "organization:open-nrw|groups:tran";
/** What a data request carries as its filter: CKAN's fq_list values, joined with "|". */
const sentFilter = (req: HttpRequest): string | null => {
  const values = new URL(req.url).searchParams.getAll("fq_list");
  return values.length === 0 ? null : values.join("|");
};
/** Queries with a key the call doesn't take: unknown, misspelled, `__proto__` (from JSON). */
const BAD_KEYS: Array<[string, Record<string, unknown>]> = [
  ["unknown key", { qq: "Haushalt" }],
  ["misspelled key", { fq_list: ["organization:open-nrw"] }],
  ["wrong-case key", { FQ: ["organization:open-nrw"] }],
  ["__proto__ key", JSON.parse('{"__proto__": {"fq": ["organization:open-nrw"]}}') as Record<string, unknown>],
  ["constructor key", JSON.parse('{"constructor": "x"}') as Record<string, unknown>],
];
/**
 * govdata has no filter-name syntax of its own (an fq is Solr syntax, sent as written); its
 * equivalent is a parameter of another CKAN action, which package_search ignores.
 */
const BAD_FILTER_NAMES: Array<[string, Record<string, unknown>]> = [
  ["a package_list key", { limit: 5 }],
  ["an organization_list key", { all_fields: true }],
  ["a package_show key", { id: "x" }],
];
/** Values of the wrong type: arrays where the API takes one value, NaN, objects, strings for lists. */
const BAD_VALUES: Array<[string, Record<string, unknown>]> = [
  ["array q", { q: ["a", "b"] }],
  ["object sort", { sort: { metadata_modified: "desc" } }],
  ["NaN rows", { rows: Number.NaN }],
  ["array start", { start: [1, 2] }],
  ["string fq", { fq: "organization:open-nrw" }],
  ["string facet_field", { facet_field: "organization" }],
];
/**
 * Not applicable: an fq is a Solr filter query, sent exactly as written (whitespace and case
 * are Solr syntax), so there is no spelling to normalise.
 */
const UNNORMALISED: Array<[string, Record<string, unknown>]> = [];
const UNNORMALISED_POLICY = "normalise" as "normalise" | "reject";
/** The CLI's filter flag given twice (the two halves of GOOD), and what the repo does with it. */
const REPEATED_FLAG_ARGV = ["search", "--fq", "organization:open-nrw", "--fq", "groups:tran"];
const REPEATED_POLICY = "combine" as "combine" | "reject";
/** A single-value option given twice, which must be a usage error. */
const REPEATED_SINGLE_ARGV = ["search", "--rows", "5", "--rows", "50"];
/** govdata's usage errors exit 1 (commander's default). */
const USAGE_EXIT = 1;
/** Every request here fetches data (no lookup requests). */
const isDataRequest = (_req: HttpRequest): boolean => true;
/** The answer to any request. */
const respond = (_req: HttpRequest): HttpResponse => ({
  status: 200,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: Buffer.from(JSON.stringify({ help: "h", success: true, result: { count: 0, results: [] } })),
});
/** CliDeps for this repo. */
const makeDeps = (io: CliDeps["io"], transport: (req: HttpRequest) => Promise<HttpResponse>): CliDeps => ({
  io,
  createClient: (opts) => new Client({ ...opts, transport }),
});
// --------------------------------------------------------------------------------------

function recorder() {
  const requests: HttpRequest[] = [];
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    requests.push(req);
    return respond(req);
  };
  return { transport, data: () => requests.filter(isDataRequest) };
}

async function rejectsBeforeData(label: string, query: Record<string, unknown>): Promise<void> {
  const r = recorder();
  await assert.rejects(call(new Client({ transport: r.transport }), query), ValidationError, label);
  assert.equal(r.data().length, 0, `${label}: a data request went out`);
}

test("P10: the valid query goes out as given", async () => {
  const r = recorder();
  await call(new Client({ transport: r.transport }), GOOD.query);
  assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT]);
});

test("P10: an unknown, misspelled or __proto__ key is a validation error before any data request", async () => {
  for (const [label, query] of BAD_KEYS) await rejectsBeforeData(label, query);
});

test("P10: a filter name the API doesn't have is a validation error before any data request", async () => {
  for (const [label, query] of BAD_FILTER_NAMES) await rejectsBeforeData(label, query);
});

test("P10: an array, object or NaN where the API takes one value is a validation error", async () => {
  for (const [label, query] of BAD_VALUES) await rejectsBeforeData(label, query);
});

test("P10: a filter name spelled differently is normalised or rejected, never sent as typed", async () => {
  for (const [label, query] of UNNORMALISED) {
    if (UNNORMALISED_POLICY === "reject") {
      await rejectsBeforeData(label, query);
      continue;
    }
    const r = recorder();
    await call(new Client({ transport: r.transport }), query);
    assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT], label);
  }
});

test("P10: a repeated filter flag is combined or rejected, never last-one-wins", async () => {
  const r = recorder();
  const err: string[] = [];
  const code = await run(REPEATED_FLAG_ARGV, makeDeps({ out: () => {}, err: (s) => err.push(s) }, r.transport));
  if (REPEATED_POLICY === "combine") {
    assert.equal(code, 0, err.join("\n"));
    assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT]);
  } else {
    assert.equal(code, USAGE_EXIT);
    assert.equal(r.data().length, 0);
  }
});

test("P10: a repeated single-value option is a usage error", async () => {
  const r = recorder();
  const err: string[] = [];
  const code = await run(REPEATED_SINGLE_ARGV, makeDeps({ out: () => {}, err: (s) => err.push(s) }, r.transport));
  assert.equal(code, USAGE_EXIT, err.join("\n"));
  assert.equal(r.data().length, 0);
});
