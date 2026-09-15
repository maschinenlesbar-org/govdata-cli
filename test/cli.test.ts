import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { GovDataClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse } from "./helpers.js";

const ACTION = "/api/3/action";

function ckan(result: unknown) {
  return { help: "h", success: true, result };
}

function makeCli(responder: (req: HttpRequest) => HttpResponse) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);

  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    },
    createClient: (opts) => new GovDataClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt };
}

test("search passes the query and rows; result is unwrapped", async () => {
  const cli = makeCli(() => jsonResponse(ckan({ count: 1, results: [{ id: "d1" }] })));
  const code = await run(["search", "Haushalt", "--rows", "5"], cli.deps);
  assert.equal(code, 0);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.pathname, `${ACTION}/package_search`);
  assert.equal(url.searchParams.get("q"), "Haushalt");
  assert.deepEqual(JSON.parse(cli.out.join("\n")), { count: 1, results: [{ id: "d1" }] });
});

test("--compact prints JSON on a single line", async () => {
  const cli = makeCli(() => jsonResponse(ckan({ count: 1, results: [{ id: "d1" }] })));
  await run(["--compact", "search", "Haushalt"], cli.deps);
  const printed = cli.out.join("\n");
  assert.equal(printed.includes("\n"), false);
  assert.deepEqual(JSON.parse(printed), { count: 1, results: [{ id: "d1" }] });
});

test("DEL and C1 control characters in server data are escaped in the JSON output", async () => {
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const result = { count: 1, results: [{ id: "d1", title: `Haushalt${controls}`, notes: String.fromCharCode(0x1b) + "[31m" }] };
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(ckan(result)));
    assert.equal(await run([...format, "search", "Haushalt"], cli.deps), 0);
    const text = cli.out.join("\n");
    const raw = [...text].filter((c) => c.charCodeAt(0) < 0x20 ? c !== "\n" : c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f);
    assert.deepEqual(raw, [], format.join(" "));
    assert.match(text, /Haushalt\\u007f\\u0085\\u009b2J/);
    assert.deepEqual(JSON.parse(text), result);
  }
});

test("repeated --fq accumulates into fq_list, never a repeated fq key", async () => {
  // CKAN answers a repeated `fq=` with HTTP 409 (it pastes the list into Solr).
  const cli = makeCli(() => jsonResponse(ckan({ count: 0, results: [] })));
  const code = await run(["search", "--fq", "organization:a", "--fq", "res_format:CSV"], cli.deps);
  assert.equal(code, 0);
  const params = new URL(cli.mt.last().url).searchParams;
  assert.deepEqual(params.getAll("fq"), []);
  assert.deepEqual(params.getAll("fq_list"), ["organization:a", "res_format:CSV"]);
});

test("a single --fq is sent as one fq", async () => {
  const cli = makeCli(() => jsonResponse(ckan({ count: 0, results: [] })));
  await run(["search", "--fq", "organization:a"], cli.deps);
  const params = new URL(cli.mt.last().url).searchParams;
  assert.deepEqual(params.getAll("fq"), ["organization:a"]);
  assert.equal(params.has("fq_list"), false);
});

test("action --param builds query parameters", async () => {
  const cli = makeCli(() => jsonResponse(ckan({ ok: true })));
  await run(["action", "package_show", "--param", "id=abc"], cli.deps);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.pathname, `${ACTION}/package_show`);
  assert.equal(url.searchParams.get("id"), "abc");
});

test("action --param value may contain '='", async () => {
  const cli = makeCli(() => jsonResponse(ckan({ ok: true })));
  await run(["action", "package_search", "--param", "filter=a=b"], cli.deps);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.searchParams.get("filter"), "a=b");
});

test("action rejects an injecting name before any request", async () => {
  const cli = makeCli(() => jsonResponse(ckan({})));
  const code = await run(["action", "../../../etc/passwd"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("action rejects a malformed --param before any request", async () => {
  const cli = makeCli(() => jsonResponse(ckan({})));
  const code = await run(["action", "tag_list", "--param", "nope"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("--base-url with a non-http(s) scheme is rejected before any request", async () => {
  const cli = makeCli(() => jsonResponse(ckan({})));
  const code = await run(["--base-url", "file:///etc/passwd", "search", "x"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("--timeout accepts up to the largest timer Node supports", async () => {
  const cli = makeCli(() => jsonResponse(ckan({ count: 0, results: [] })));
  assert.equal(await run(["--timeout", "2147483647", "search", "x"], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 2_147_483_647);

  const over = makeCli(() => jsonResponse(ckan({ count: 0, results: [] })));
  assert.equal(await run(["--timeout", "2147483648", "search", "x"], over.deps), 1);
  assert.equal(over.mt.calls.length, 0);
  assert.match(over.err.join("\n"), /Must be <= 2147483647/);
});

test("a success:false envelope exits non-zero", async () => {
  const cli = makeCli(() => jsonResponse({ help: "h", success: false, error: { message: "x" } }));
  const code = await run(["package", "nope"], cli.deps);
  assert.notEqual(code, 0);
});

test("a 404 from the API maps to exit code 4", async () => {
  const cli = makeCli(() => jsonResponse({}, 404));
  const code = await run(["package", "nope"], cli.deps);
  assert.equal(code, 4);
});
