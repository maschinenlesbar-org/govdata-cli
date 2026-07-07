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

test("repeated --fq accumulates", async () => {
  const cli = makeCli(() => jsonResponse(ckan({ count: 0, results: [] })));
  await run(["search", "--fq", "organization:a", "--fq", "res_format:CSV"], cli.deps);
  const params = new URL(cli.mt.last().url).searchParams.getAll("fq");
  assert.deepEqual(params, ["organization:a", "res_format:CSV"]);
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
