import { test } from "node:test";
import assert from "node:assert/strict";
import { GovDataClient } from "../src/client/client.js";
import { GovDataError, GovDataApiError, GovDataParseError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse } from "./helpers.js";

function clientWith(mt: ReturnType<typeof makeMockTransport>): GovDataClient {
  return new GovDataClient({ transport: mt.transport });
}

const ACTION = "/api/3/action";

/** A CKAN-style success envelope. */
function ckan(result: unknown) {
  return { help: "h", success: true, result };
}

test("packageSearch unwraps result and passes params", async () => {
  const mt = makeMockTransport(() => jsonResponse(ckan({ count: 3, results: [] })));
  const res = await clientWith(mt).packageSearch({ q: "Haushalt", rows: 5, fq: ["organization:x"] });
  assert.equal(res.count, 3);
  const url = new URL(mt.last().url);
  assert.equal(url.pathname, `${ACTION}/package_search`);
  assert.equal(url.searchParams.get("q"), "Haushalt");
  assert.equal(url.searchParams.get("rows"), "5");
  assert.equal(url.searchParams.has("fq"), false);
  assert.deepEqual(url.searchParams.getAll("fq_list"), ["organization:x", "organization:x"]);
});

test("packageSearch sends several filters as fq_list, not a repeated fq", async () => {
  const mt = makeMockTransport(() => jsonResponse(ckan({ count: 0, results: [] })));
  await clientWith(mt).packageSearch({ fq: ["organization:x", "", "-groups:tran"] });
  const url = new URL(mt.last().url);
  assert.equal(url.searchParams.has("fq"), false);
  assert.deepEqual(url.searchParams.getAll("fq_list"), ["organization:x", "-groups:tran"]);
});

test("packageSearch sends facet_field as CKAN's facet.field JSON list", async () => {
  // CKAN rejects `facet_field` with HTTP 400 "Invalid search parameters".
  const mt = makeMockTransport(() => jsonResponse(ckan({ count: 0, results: [] })));
  await clientWith(mt).packageSearch({ rows: 0, facet_field: ["organization", "res_format"] });
  const url = new URL(mt.last().url);
  assert.equal(url.searchParams.get("facet.field"), '["organization","res_format"]');
  assert.equal(url.searchParams.has("facet_field"), false);
});

test("packageSearch omits facet.field when no facet fields are given", async () => {
  const mt = makeMockTransport(() => jsonResponse(ckan({ count: 0, results: [] })));
  await clientWith(mt).packageSearch({ q: "x", facet_field: [] });
  assert.equal(new URL(mt.last().url).searchParams.has("facet.field"), false);
});

test("packageSearch never sends a lone fq_list value (CKAN splits it into characters)", async () => {
  const mt = makeMockTransport(() => jsonResponse(ckan({ count: 0, results: [] })));
  await clientWith(mt).packageSearch({ fq: ["", "organization:x OR groups:tran"] });
  const url = new URL(mt.last().url);
  assert.equal(url.searchParams.has("fq"), false);
  assert.deepEqual(url.searchParams.getAll("fq_list"), [
    "organization:x OR groups:tran",
    "organization:x OR groups:tran",
  ]);
});

test("packageShow passes the id", async () => {
  const mt = makeMockTransport(() => jsonResponse(ckan({ id: "abc" })));
  await clientWith(mt).packageShow("abc");
  const url = new URL(mt.last().url);
  assert.equal(url.pathname, `${ACTION}/package_show`);
  assert.equal(url.searchParams.get("id"), "abc");
});

test("organizationList passes all_fields", async () => {
  const mt = makeMockTransport(() => jsonResponse(ckan([])));
  await clientWith(mt).organizationList({ all_fields: true });
  assert.equal(new URL(mt.last().url).searchParams.get("all_fields"), "true");
});

test("packageList refuses a limit that is not a positive integer, before any request", async () => {
  for (const limit of [0, -1, 1.5, Number.NaN, Infinity]) {
    const mt = makeMockTransport(() => jsonResponse(ckan([])));
    await assert.rejects(
      () => clientWith(mt).packageList({ limit }),
      (err: unknown) =>
        err instanceof GovDataError &&
        err.message === `Invalid limit: expected a positive integer, got ${String(limit)}. Leave it out for the whole list.`,
    );
    assert.equal(mt.calls.length, 0, String(limit));
  }
});

test("organizationList and groupList forward limit and offset", async () => {
  for (const method of ["organizationList", "groupList"] as const) {
    const mt = makeMockTransport(() => jsonResponse(ckan([])));
    await clientWith(mt)[method]({ limit: 5, offset: 10, all_fields: true });
    const params = new URL(mt.last().url).searchParams;
    assert.equal(params.get("limit"), "5", method);
    assert.equal(params.get("offset"), "10", method);
    assert.equal(params.get("all_fields"), "true", method);

    const zero = makeMockTransport(() => jsonResponse(ckan([])));
    await assert.rejects(() => clientWith(zero)[method]({ limit: 0 }), GovDataError);
    assert.equal(zero.calls.length, 0, method);
  }
});

test("a body that is not a CKAN envelope is a GovDataParseError, not a TypeError", async () => {
  for (const body of [null, [1, 2], {}, { result: [] }, "text", 5]) {
    const mt = makeMockTransport(() => jsonResponse(body));
    await assert.rejects(
      () => clientWith(mt).packageSearch({ q: "x" }),
      (err: unknown) =>
        err instanceof GovDataParseError &&
        err.message ===
          "Unexpected response shape from /api/3/action/package_search: expected a CKAN envelope (a JSON object with a boolean success).",
      JSON.stringify(body),
    );
  }
});

test("a success envelope without a result is a GovDataParseError; a null result is kept", async () => {
  const mt = makeMockTransport(() => jsonResponse({ success: true }));
  await assert.rejects(
    () => clientWith(mt).action("status_show"),
    (err: unknown) =>
      err instanceof GovDataParseError &&
      err.message === "Unexpected response shape from /api/3/action/status_show: expected a result in the envelope.",
  );
  const nul = makeMockTransport(() => jsonResponse(ckan(null)));
  assert.equal(await clientWith(nul).action("status_show"), null);
});

test("typed methods check the top-level shape of the result", async () => {
  const cases: Array<[string, (c: GovDataClient) => Promise<unknown>, unknown, string]> = [
    ["package_search", (c) => c.packageSearch({ q: "x" }), { count: "3", results: [] }, "an object with a numeric count and a results array"],
    ["package_search", (c) => c.packageSearch({ q: "x" }), { count: 3 }, "an object with a numeric count and a results array"],
    ["package_show", (c) => c.packageShow("x"), [], "a JSON object"],
    ["organization_show", (c) => c.organizationShow("x"), null, "a JSON object"],
    ["group_show", (c) => c.groupShow("x"), "g", "a JSON object"],
    ["resource_show", (c) => c.resourceShow("x"), 1, "a JSON object"],
    ["package_list", (c) => c.packageList(), {}, "an array"],
    ["organization_list", (c) => c.organizationList(), null, "an array"],
    ["group_list", (c) => c.groupList({ all_fields: true }), { a: 1 }, "an array"],
    ["tag_list", (c) => c.tagList(), "t", "an array"],
  ];
  for (const [name, call, result, expected] of cases) {
    const mt = makeMockTransport(() => jsonResponse(ckan(result)));
    await assert.rejects(
      () => call(clientWith(mt)),
      (err: unknown) =>
        err instanceof GovDataParseError &&
        err.message === `Unexpected response shape from /api/3/action/${name}: expected ${expected}.`,
      name,
    );
  }
  // The generic action passes any result through.
  const any = makeMockTransport(() => jsonResponse(ckan("plain")));
  assert.equal(await clientWith(any).action("package_search"), "plain");
});

test("action returns the unwrapped result", async () => {
  const mt = makeMockTransport(() => jsonResponse(ckan(["a", "b"])));
  const result = await clientWith(mt).action<string[]>("tag_list");
  assert.deepEqual(result, ["a", "b"]);
});

test("a success:false envelope raises GovDataError surfacing error.message", async () => {
  const mt = makeMockTransport(() =>
    jsonResponse({ help: "h", success: false, error: { message: "Not found", __type: "Not Found Error" } }),
  );
  await assert.rejects(
    () => clientWith(mt).packageShow("x"),
    (err) =>
      err instanceof GovDataError &&
      err.message.includes("Not found") &&
      !err.message.includes("__type"),
  );
});

test("a success:false envelope without error.message falls back to JSON", async () => {
  const mt = makeMockTransport(() =>
    jsonResponse({ help: "h", success: false, error: { __type: "Validation Error" } }),
  );
  await assert.rejects(
    () => clientWith(mt).packageShow("x"),
    (err) => err instanceof GovDataError && err.message.includes("Validation Error"),
  );
});

test("a success:false envelope on HTTP 200 is stripped of terminal escapes, bidi and newlines", async () => {
  // Built from char codes so the source stays free of control bytes.
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const CSI8 = String.fromCharCode(0x9b);
  const RLO = String.fromCharCode(0x202e);
  const errors: unknown[] = [
    { message: `evil${ESC}[31mRED${ESC}]0;TITLE${BEL} ${ESC}[2J${CSI8}31m` },
    { __type: `X${CSI8}31m`, detail: `d${ESC}[2J` },
    `str ${ESC}[31merr\nError: forged ${RLO}line`,
  ];
  const expected = [
    'CKAN action "package_show" failed: evil[31mRED]0;TITLE [2J31m',
    'CKAN action "package_show" failed: {"__type":"X31m","detail":"d\\u001b[2J"}',
    'CKAN action "package_show" failed: str [31merr Error: forged line',
  ];
  for (const [i, error] of errors.entries()) {
    const mt = makeMockTransport(() => jsonResponse({ help: "h", success: false, error }));
    await assert.rejects(
      () => clientWith(mt).packageShow("x"),
      (err: unknown) => err instanceof GovDataError && err.message === expected[i],
    );
  }
});

test("action rejects a name with path-traversal / query chars before any request", async () => {
  for (const bad of ["../../../etc/passwd", "package_search?rows=9999", "a/b/c", "pkg#frag", ""]) {
    const mt = makeMockTransport(() => jsonResponse(ckan({})));
    await assert.rejects(() => clientWith(mt).action(bad), GovDataError);
    assert.equal(mt.calls.length, 0, `expected no request for "${bad}"`);
  }
});

test("action encodes a valid name into exactly /api/3/action/<name>", async () => {
  const mt = makeMockTransport(() => jsonResponse(ckan(["a"])));
  await clientWith(mt).action("organization_list");
  assert.equal(new URL(mt.last().url).pathname, `${ACTION}/organization_list`);
});

test("prune keeps falsy values (0/false) but drops undefined", async () => {
  const mt = makeMockTransport(() => jsonResponse(ckan({ count: 0, results: [] })));
  // rows: 0 should be sent; start is undefined and must be omitted.
  await clientWith(mt).packageSearch({ q: "x", rows: 0 });
  const url = new URL(mt.last().url);
  assert.equal(url.searchParams.get("rows"), "0");
  assert.equal(url.searchParams.has("start"), false);
});

test("a 404 raises GovDataApiError with status 404", async () => {
  const mt = makeMockTransport(() => jsonResponse({}, 404));
  await assert.rejects(
    () => clientWith(mt).packageShow("x"),
    (err) => err instanceof GovDataApiError && err.status === 404,
  );
});
