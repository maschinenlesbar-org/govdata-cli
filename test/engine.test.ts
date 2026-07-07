import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine } from "../src/client/engine.js";
import {
  GovDataApiError,
  GovDataNetworkError,
  GovDataParseError,
} from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";
import type { HttpResponse } from "../src/client/http.js";

// Control characters built via char codes so no raw control byte ever appears in
// this source file.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI = String.fromCharCode(0x9b); // a C1 control

/** True if the string contains any C0/C1 control char except tab/newline. */
function hasControlChars(s: string): boolean {
  return [...s].some((c) => {
    const n = c.charCodeAt(0);
    return n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f);
  });
}

test("the constructor rejects a non-http(s) base URL (GOV-01)", () => {
  assert.throws(
    () => new RequestEngine({ baseUrl: "file:///etc/passwd" }),
    GovDataNetworkError,
  );
  assert.throws(() => new RequestEngine({ baseUrl: "not a url" }), GovDataNetworkError);
});

test("buildUrl normalises the path and appends the query", () => {
  const e = new RequestEngine({ baseUrl: "https://example.test/" });
  assert.equal(e.buildUrl("api/"), "https://example.test/api/");
  assert.equal(
    e.buildUrl("/x", { a: "1", b: ["2", "3"] }),
    "https://example.test/x?a=1&b=2&b=3",
  );
});

test("getJson parses a JSON body", async () => {
  const mt = makeMockTransport(() => jsonResponse({ ok: true }));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.getJson("/x"), { ok: true });
});

test("getJson throws GovDataParseError on invalid JSON", async () => {
  const mt = makeMockTransport(() => rawResponse("not json", "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.getJson("/x"), GovDataParseError);
});

test("a 503 is retried up to maxRetries then surfaces as GovDataApiError", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return jsonResponse({ detail: "busy" }, 503);
  });
  const e = new RequestEngine({
    transport: mt.transport,
    maxRetries: 2,
    sleep: async () => {},
  });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof GovDataApiError && err.status === 503,
  );
  assert.equal(calls, 3); // initial + 2 retries
});

test("a retried request that then succeeds resolves", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1 ? jsonResponse({}, 503) : jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {} });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
  assert.equal(calls, 2);
});

test("the User-Agent and Accept headers are sent", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const e = new RequestEngine({ transport: mt.transport, userAgent: "ua/1" });
  await e.getJson("/x");
  assert.equal(mt.last().headers?.["User-Agent"], "ua/1");
  assert.equal(mt.last().headers?.["Accept"], "application/json");
});

test("a same-origin redirect is followed with headers preserved", async () => {
  let calls = 0;
  const mt = makeMockTransport((req) => {
    calls += 1;
    if (calls === 1) {
      return { status: 302, headers: { location: "/moved" }, body: Buffer.from("") };
    }
    // Second request must still carry the User-Agent (same origin).
    assert.equal(req.headers?.["User-Agent"], "ua/1");
    assert.ok(new URL(req.url).pathname === "/moved");
    return jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({
    transport: mt.transport,
    baseUrl: "https://example.test",
    userAgent: "ua/1",
  });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
  assert.equal(calls, 2);
});

test("error detail is stripped of terminal control characters (GOV-02)", async () => {
  // A CKAN-shaped error body whose message interleaves ESC/CSI/BEL escapes with
  // printable text. JSON.parse turns the escaped bytes into real control bytes.
  const evil = `boom${ESC}[31mred${BEL}${CSI}2J`;
  const body: HttpResponse = {
    status: 500,
    headers: { "content-type": "application/json" },
    body: Buffer.from(
      JSON.stringify({ error: { __type: "Internal Server Error", message: evil } }),
    ),
  };
  const mt = makeMockTransport(() => body);
  const e = new RequestEngine({
    transport: mt.transport,
    baseUrl: "https://a.example",
    maxRetries: 0,
  });

  await assert.rejects(
    () => e.getJson("/x"),
    (err: unknown) => {
      assert.ok(err instanceof GovDataApiError);
      // Control bytes are gone from both the structured detail and the
      // human-readable message that run.ts prints to stderr...
      assert.ok(!hasControlChars(err.detail ?? ""));
      assert.ok(!hasControlChars(err.message));
      // ...while the printable characters (and the __type prefix) survive.
      assert.equal(err.detail, "Internal Server Error: boom[31mred2J");
      return true;
    },
  );
});

test("a cross-origin redirect drops the request headers (credential-strip guard)", async () => {
  let calls = 0;
  const mt = makeMockTransport((req) => {
    calls += 1;
    if (calls === 1) {
      return {
        status: 302,
        headers: { location: "https://evil.test/x" },
        body: Buffer.from(""),
      };
    }
    // Crossing origin: User-Agent must NOT be re-sent to the new host.
    assert.equal(req.headers?.["User-Agent"], undefined);
    assert.equal(req.headers?.["Accept"], "application/json");
    return jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({
    transport: mt.transport,
    baseUrl: "https://example.test",
    userAgent: "ua/1",
  });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
  assert.equal(calls, 2);
});
