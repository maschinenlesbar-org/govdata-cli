import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_RETRY_AFTER_MS, RequestEngine, parseRetryAfter } from "../src/client/engine.js";
import {
  GovDataApiError,
  GovDataNetworkError,
  GovDataParseError,
  redactUrl,
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

test("the constructor rejects a base URL with a query or fragment, redacting userinfo", () => {
  for (const baseUrl of ["https://u:pw@example.test/?x=1", "https://u:pw@example.test/#f"]) {
    assert.throws(
      () => new RequestEngine({ baseUrl }),
      (err: unknown) =>
        err instanceof GovDataNetworkError &&
        err.message.startsWith("Base URL must not contain a query or fragment: https://***@example.test/") &&
        !err.message.includes("pw"),
    );
  }
});

test("redactUrl hides userinfo and leaves other URLs alone", () => {
  assert.equal(redactUrl("http://user:secret@h.test/p?q=1"), "http://***@h.test/p?q=1");
  assert.equal(redactUrl("https://h.test/p"), "https://h.test/p");
  assert.equal(redactUrl("not a url"), "not a url");
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

test("a bare JSON string error body (CKAN's unknown-action answer) becomes the detail", async () => {
  const mt = makeMockTransport(() =>
    jsonResponse(`Fehlerhafte Anfrage - Action name not known: no_such_action${ESC}[2J`, 400),
  );
  const e = new RequestEngine({ transport: mt.transport, baseUrl: "https://a.example" });
  await assert.rejects(
    () => e.getJson("/api/3/action/no_such_action"),
    (err: unknown) => {
      assert.ok(err instanceof GovDataApiError);
      assert.equal(err.detail, "Fehlerhafte Anfrage - Action name not known: no_such_action[2J");
      assert.equal(
        err.message,
        "HTTP 400 for GET https://a.example/api/3/action/no_such_action: Fehlerhafte Anfrage - Action name not known: no_such_action[2J",
      );
      return true;
    },
  );
});

test("error detail loses newlines and bidi overrides, so it cannot forge stderr lines", async () => {
  const RLO = String.fromCharCode(0x202e);
  const mt = makeMockTransport(() =>
    jsonResponse(
      { success: false, error: { __type: "Not Found Error", message: `Not found\nOK: 0 problems ${RLO}` } },
      404,
    ),
  );
  const e = new RequestEngine({ transport: mt.transport, baseUrl: "https://a.example" });
  await assert.rejects(
    () => e.getJson("/x"),
    (err: unknown) => {
      assert.ok(err instanceof GovDataApiError);
      assert.equal(err.detail, "Not Found Error: Not found OK: 0 problems");
      assert.ok(!err.message.includes("\n"));
      return true;
    },
  );
});

function redirect(status: number, location?: string): HttpResponse {
  return { status, headers: location === undefined ? {} : { location }, body: Buffer.from("") };
}

test("only 301/302/303/307/308 are followed; other 3xx name the target", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let n = 0;
    const mt = makeMockTransport(() => (++n === 1 ? redirect(status, "/ok") : jsonResponse({ ok: status })));
    const e = new RequestEngine({ transport: mt.transport, baseUrl: "https://a.example" });
    assert.deepEqual(await e.getJson("/x"), { ok: status });
  }
  for (const status of [300, 304, 305, 306]) {
    const mt = makeMockTransport(() => redirect(status, "/ok"));
    const e = new RequestEngine({ transport: mt.transport, baseUrl: "https://a.example" });
    await assert.rejects(
      () => e.getJson("/x"),
      (err: unknown) =>
        err instanceof GovDataApiError &&
        err.location === "https://a.example/ok" &&
        err.message === `HTTP ${status} for GET https://a.example/x: redirect to https://a.example/ok not followed`,
      String(status),
    );
    assert.equal(mt.calls.length, 1);
  }
});

test("a malformed or missing Location is an API error, not an Unexpected error", async () => {
  const bad = makeMockTransport(() => redirect(302, `http://[::1${ESC}[2J`));
  await assert.rejects(
    () => new RequestEngine({ transport: bad.transport, baseUrl: "https://a.example" }).getJson("/x"),
    (err: unknown) =>
      err instanceof GovDataApiError &&
      err.message === "HTTP 302 for GET https://a.example/x: redirect to http://[::1[2J not followed",
  );
  const none = makeMockTransport(() => redirect(302));
  await assert.rejects(
    () => new RequestEngine({ transport: none.transport, baseUrl: "https://a.example" }).getJson("/x"),
    (err: unknown) =>
      err instanceof GovDataApiError &&
      err.message === "HTTP 302 for GET https://a.example/x: redirect not followed (no Location header)",
  );
});

test("the redirect limit names the loop", async () => {
  const mt = makeMockTransport((req) => redirect(302, new URL(req.url).pathname));
  const e = new RequestEngine({ transport: mt.transport, baseUrl: "https://u:pw@a.example" });
  await assert.rejects(
    () => e.getJson("/loop"),
    (err: unknown) =>
      err instanceof GovDataApiError &&
      err.message ===
        "HTTP 302 for GET https://***@a.example/loop: redirect to https://***@a.example/loop not followed (stopped after 5 redirects)",
  );
  assert.equal(mt.calls.length, 6);

  const zero = makeMockTransport(() => redirect(302, "/loop"));
  await assert.rejects(
    () => new RequestEngine({ transport: zero.transport, baseUrl: "https://a.example", maxRedirects: 0 }).getJson("/x"),
    (err: unknown) =>
      err instanceof GovDataApiError &&
      err.message === "HTTP 302 for GET https://a.example/x: redirect to https://a.example/loop not followed",
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

// ---- Retry-After ----

function retryingEngine(retryAfter: string | undefined, maxRetries = 2) {
  const delays: number[] = [];
  const mt = makeMockTransport(() => ({
    status: 429,
    headers: {
      "content-type": "application/json",
      ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
    },
    body: Buffer.from(JSON.stringify({ detail: "slow down" })),
  }));
  const engine = new RequestEngine({
    transport: mt.transport,
    maxRetries,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  return { engine, mt, delays };
}

test("a 429 with Retry-After in seconds waits that long before each retry", async () => {
  const { engine, mt, delays } = retryingEngine("1");
  await assert.rejects(() => engine.getJson("/x"), (e: unknown) => e instanceof GovDataApiError && e.status === 429);
  assert.equal(mt.calls.length, 3);
  assert.deepEqual(delays, [1000, 1000]);
});

test("without a usable Retry-After the retries back off linearly", async () => {
  for (const header of [undefined, "", "-1", "1.5", "soon", "1e3", "2026-09-26T10:00:00Z"]) {
    const { engine, delays } = retryingEngine(header);
    await assert.rejects(() => engine.getJson("/x"));
    assert.deepEqual(delays, [200, 400], String(header));
  }
});

test("a Retry-After above MAX_RETRY_AFTER_MS is not retried: the error surfaces at once", async () => {
  for (const header of ["31", "999999", "99999999999999999999", "Fri, 31 Dec 9999 23:59:59 GMT"]) {
    const { engine, mt, delays } = retryingEngine(header);
    await assert.rejects(() => engine.getJson("/x"), (e: unknown) => e instanceof GovDataApiError && e.status === 429);
    assert.equal(mt.calls.length, 1, header);
    assert.deepEqual(delays, [], header);
  }
});

test("parseRetryAfter reads delay-seconds and IMF-fixdate HTTP-dates", () => {
  const now = Date.parse("Sat, 26 Sep 2026 10:00:00 GMT");
  assert.equal(parseRetryAfter("0", now), 0);
  assert.equal(parseRetryAfter(" 30 ", now), 30_000);
  assert.equal(parseRetryAfter(["2", "9"], now), 2000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 10:00:05 GMT", now), 5000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 09:00:00 GMT", now), 0); // past date: retry now
  for (const bad of [undefined, "", "-1", "+5", "1.5", "1e3", "0x10", "Saturday, 26-Sep-26 10:00:05 GMT"]) {
    assert.equal(parseRetryAfter(bad, now), undefined, String(bad));
  }
  assert.equal(MAX_RETRY_AFTER_MS, 30_000);
});
