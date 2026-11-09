import { test } from "node:test";
import { TextDecoder, inspect } from "node:util";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  MAX_RETRY_AFTER_MS,
  RequestEngine,
  assertHeaderValue,
  parseRetryAfter,
  sanitizeServerText,
  validateBaseUrl,
} from "../src/engine.js";
import {
  GovDataApiError,
  GovDataError,
  GovDataNetworkError,
  GovDataParseError,
  GovDataValidationError,
  redactUrl,
  cutForMessage,
  cutText,
  echoedCredentialForms,
  toWellFormed,
} from "../src/errors.js";
import { GovDataClient } from "../src/client.js";
import * as library from "../src/index.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";
import type { HttpResponse } from "../src/http.js";

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

test("the constructor rejects a non-http(s) base URL as GovDataValidationError, not a network error (GOV-01)", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://x", "not-a-url", ""]) {
    assert.throws(
      () => new RequestEngine({ baseUrl }),
      (err: unknown) =>
        err instanceof GovDataValidationError &&
        !(err instanceof GovDataNetworkError) &&
        err.message.startsWith("Invalid base URL: "),
      JSON.stringify(baseUrl),
    );
  }
});

test("the constructor rejects a base URL with a query or fragment, never echoing userinfo", () => {
  for (const baseUrl of ["https://u:pw@example.test/?x=1", "https://u:pw@example.test/#f"]) {
    assert.throws(
      () => new RequestEngine({ baseUrl }),
      (err: unknown) =>
        err instanceof GovDataValidationError &&
        err.message === "Invalid base URL: A base URL cannot have a query (?) or fragment (#)." &&
        !err.message.includes("pw"),
    );
  }
});

test("validateBaseUrl returns the base URL without trailing slashes and is exported", () => {
  assert.equal(validateBaseUrl("https://ckan.govdata.de//"), "https://ckan.govdata.de");
  assert.equal(validateBaseUrl("http://u:p@mirror.test/ckan"), "http://u:p@mirror.test/ckan");
  assert.throws(() => validateBaseUrl("ftp://x"), GovDataValidationError);
  assert.equal(library.validateBaseUrl, validateBaseUrl);
});

test("the constructor refuses an unsendable userAgent with GovDataValidationError", () => {
  for (const userAgent of ["", "  ", "a\r\nX-Injected: 1", "a\u007fb", "\u20ac"]) {
    assert.throws(
      () => new RequestEngine({ userAgent }),
      (err: unknown) => err instanceof GovDataValidationError && err.message.startsWith("Invalid userAgent: "),
      JSON.stringify(userAgent),
    );
  }
  assert.equal(assertHeaderValue("User-Agent", "caf\u00e9"), "caf\u00e9");
  assert.equal(library.assertHeaderValue, assertHeaderValue);
});

test("the constructor refuses a base URL with whitespace before the trailing-slash strip", () => {
  for (const baseUrl of ["https://ckan.govdata.de/ ", " https://ckan.govdata.de", "https://ckan.govdata.de\n", "https://h.test/a b"]) {
    const mt = makeMockTransport(() => jsonResponse({}));
    assert.throws(
      () => new RequestEngine({ baseUrl, transport: mt.transport }),
      (err: unknown) => err instanceof GovDataValidationError && err.message.startsWith("Invalid base URL: "),
      JSON.stringify(baseUrl),
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("redactUrl hides userinfo and leaves other URLs alone", () => {
  assert.equal(redactUrl("http://user:secret@h.test/p?q=1"), "http://***@h.test/p?q=1");
  assert.equal(redactUrl("https://h.test/p"), "https://h.test/p");
  assert.equal(redactUrl("not a url"), "not a url");
});

test("numeric engine options must be integers in range", () => {
  const cases: Array<[Record<string, number>, string]> = [
    [{ timeoutMs: -1 }, "Invalid option timeoutMs: expected an integer from 0 to 2147483647, got -1."],
    [{ timeoutMs: Number.NaN }, "Invalid option timeoutMs: expected an integer from 0 to 2147483647, got NaN."],
    [{ timeoutMs: 2_147_483_648 }, "Invalid option timeoutMs: expected an integer from 0 to 2147483647, got 2147483648."],
    [{ maxRetries: Infinity }, "Invalid option maxRetries: expected an integer from 0 to 10, got Infinity."],
    [{ maxRetries: 11 }, "Invalid option maxRetries: expected an integer from 0 to 10, got 11."],
    [{ retryDelayMs: 1.5 }, "Invalid option retryDelayMs: expected an integer from 0 to 30000, got 1.5."],
    [{ maxRedirects: Number.NaN }, "Invalid option maxRedirects: expected an integer from 0 to 20, got NaN."],
    [{ maxResponseBytes: -1 }, "Invalid option maxResponseBytes: expected an integer from 0 to 9007199254740991, got -1."],
  ];
  for (const [options, message] of cases) {
    assert.throws(
      () => new RequestEngine(options),
      (err: unknown) => err instanceof GovDataError && err.message === message,
      message,
    );
  }
  // 0 stays valid: no timeout, no retries, no redirects, no size cap.
  new RequestEngine({ timeoutMs: 0, maxRetries: 0, retryDelayMs: 0, maxRedirects: 0, maxResponseBytes: 0 });
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

test("a number the JSON cannot carry exactly is a parse error, never a changed value", async () => {
  // JSON.parse rounds 12345678901234567890 (in any form: .0, e0, E-1) and 9007199254740992.5 to the
  // nearest double, turns 1e400 into Infinity (printed as null) and 1e-400 into 0, silently.
  const body = (n: string) => `{"id":"a","n":${n},"text":"12345678901234567890 in a string"}`;
  for (const n of [
    "12345678901234567890", "-9007199254740993", "1e400", "-1E400", "12345678901234567890.0", "9007199254740993e0",
    "90071992547409930E-1", "9007199254740992.5", "-9007199254740992.5", "1e-400", "-0.0001e-399",
    "123456789012345678901234567890",
    // Below the smallest normal double a subnormal has fewer digits: 3e-324 became 5e-324.
    "3e-324", "4e-324", "-4.9e-324", "1.2345678901234567e-310", "2.225073858507201e-309", "1.234e-322", "7e-324", "-3e-324", "1.2e-323",
  ]) {
    const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(body(n), "application/json")).transport });
    await assert.rejects(e.getJson("/api/3/action/package_show", { id: "a" }), (err: unknown) => {
      assert.ok(err instanceof GovDataParseError, n);
      assert.equal(err.message, `GET https://ckan.govdata.de/api/3/action/package_show?id=a: the number ${n} cannot be represented exactly.`);
      return true;
    });
  }
  // What a double carries exactly, or as JSON means it (a decimal fraction below 2^53), passes.
  const exact: Array<[string, number]> = [
    ["9007199254740991", 9007199254740991], ["9007199254740992.0", 2 ** 53], ["9007199254740992e0", 2 ** 53],
    ["90071992547409920E-1", 2 ** 53], ["1e21", 1e21], ["1.2e21", 1.2e21], ["0", 0], ["-0", -0], ["0.0e-500", 0],
    ["1.10", 1.1], ["0.1", 0.1], ["1.00000000000000001", 1], ["5e-324", 5e-324],
    // A subnormal or the smallest normal double that prints as written.
    ["-5e-324", -5e-324], ["1e-310", 1e-310], ["2.2250738585072014e-308", 2.2250738585072014e-308], ["2.5e-323", 2.5e-323],
    // A double a server printed in its shortest form reads back as that double and prints as the
    // same number: not a changed value, though the decimal is not the double's exact binary value.
    ["1e23", 1e23], ["100000000000000000000000", 1e23], ["1E23", 1e23], ["1.7976931348623157E308", Number.MAX_VALUE], ["-1.7976931348623157e308", -Number.MAX_VALUE],
    ["4.35e30", 4.35e30],
  ];
  for (const [n, value] of exact) {
    const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(body(n), "application/json")).transport });
    assert.equal((await e.getJson<{ n: number }>("/x")).n, value, n);
  }
});

test("the number check skips strings and costs one pass over the text", async () => {
  // Escaped quotes and backslashes must not end a string early and expose its digits.
  const tricky = `{"id":"a","s":"\\\\\\"12345678901234567890\\\\","t":"1e400","n":[1,2.5,-3e2]}`;
  const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(tricky, "application/json")).transport });
  assert.deepEqual(await e.getJson("/x"), JSON.parse(tricky));
  // 1 MB of numbers: the scan is linear.
  const big = `[${Array.from({ length: 200_000 }, (_, i) => i * 7).join(",")}]`;
  const f = new RequestEngine({ transport: makeMockTransport(() => rawResponse(big, "application/json")).transport });
  assert.equal((await f.getJson<number[]>("/x")).length, 200_000);
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
      // ...as whole escape sequences, while the printable text (and the __type prefix) survives.
      assert.equal(err.detail, "Internal Server Error: boomred");
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
      assert.equal(err.detail, "Fehlerhafte Anfrage - Action name not known: no_such_action");
      assert.equal(
        err.message,
        "HTTP 400 for GET https://a.example/api/3/action/no_such_action: Fehlerhafte Anfrage - Action name not known: no_such_action",
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

test("sanitizeServerText reads a bounded prefix and drops what the per-character filter dropped", () => {
  // The filter it replaces, one character at a time: C0 but TAB to CR, DEL, C1 and Cf go.
  const perCharacter = (text: string): string =>
    cutForMessage(
      [...text]
        .filter((ch) => {
          const n = ch.codePointAt(0) ?? 0;
          return (n >= 0x09 && n <= 0x0d) || !(n <= 0x1f || (n >= 0x7f && n <= 0x9f) || /\p{Cf}/u.test(ch));
        })
        .join("")
        .replace(/\s+/g, " ")
        .trim(),
    );
  const every = Array.from({ length: 0x3000 }, (_, i) => String.fromCharCode(i)).join("") + "\u{1f600}\u{e0001}\ud800x";
  for (let at = 0; at < every.length; at += 512) {
    const piece = every.slice(at, at + 512).replace(/[\u001b\u0090\u0098\u009b-\u009f]/g, "");
    assert.equal(sanitizeServerText(piece), perCharacter(piece), `from U+${at.toString(16)}`);
  }
  // At most 16 384 units of the text are read, never half a surrogate pair: what follows is
  // never copied, whatever the cleaning would have left of the start.
  assert.equal(sanitizeServerText(`${" ".repeat(16_384)}tail`), "");
  assert.equal(sanitizeServerText(`${"\u0000".repeat(16_383)}\u{1f600}`), "");
  assert.equal(sanitizeServerText(`${"\u0000".repeat(16_382)}\u{1f600}`), "\u{1f600}");
  assert.equal(sanitizeServerText("x".repeat(100_000)), `${"x".repeat(500)}…`);
  // A control string ends at another introducer: the first is dropped by the filter, the second
  // string as a whole.
  const OSC8 = String.fromCharCode(0x9d);
  const ST8 = String.fromCharCode(0x9c);
  assert.equal(sanitizeServerText(`a${OSC8}0;x${OSC8}0;t${ST8}b`), "a0;xb");
  assert.equal(sanitizeServerText(`a${ESC}]0;x${ESC}]0;t${BEL}b`), "a0;xb");
  // Whole escape sequences go, not only their control bytes.
  assert.equal(sanitizeServerText(`a${ESC}]0;title${BEL}b${ESC}[1;31mc${CSI}2Jd`), "abcd");
});

test("sanitizeServerText cleans a huge server text in linear time", () => {
  for (const intro of ["\u009d", "\u0090", "\u0098", "\u009e", "\u009f", `${ESC}]`]) {
    const started = Date.now();
    assert.equal(sanitizeServerText(`${intro}x`.repeat(100_000)).slice(0, 3), "xxx");
    assert.ok(Date.now() - started < 1000, `${JSON.stringify(intro)}: ${Date.now() - started} ms`);
  }
  const started = Date.now();
  assert.equal(sanitizeServerText("A".repeat(20_000_000)).length, 501);
  assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
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
      err.message === "HTTP 302 for GET https://a.example/x: redirect to http://[::1 not followed",
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
      // The base URL's userinfo travels as the Authorization header, never in a URL.
      err.message ===
        "HTTP 302 for GET https://a.example/loop: redirect to https://a.example/loop not followed (stopped after 5 redirects)",
  );
  assert.equal(mt.calls.length, 6);
  for (const call of mt.calls) {
    assert.equal(call.headers?.["Authorization"], `Basic ${Buffer.from("u:pw").toString("base64")}`);
    assert.ok(!call.url.includes("pw"), call.url);
  }

  const zero = makeMockTransport(() => redirect(302, "/loop"));
  await assert.rejects(
    () => new RequestEngine({ transport: zero.transport, baseUrl: "https://a.example", maxRedirects: 0 }).getJson("/x"),
    (err: unknown) =>
      err instanceof GovDataApiError &&
      err.message === "HTTP 302 for GET https://a.example/x: redirect to https://a.example/loop not followed",
  );
});

test("a cross-origin redirect keeps only Accept and User-Agent (credential-strip guard)", async () => {
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
    // Crossing origin: only the engine's own Accept and User-Agent go along.
    assert.deepEqual(req.headers, { Accept: "application/json", "User-Agent": "ua/1" });
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

// Findings 04#1–#4 of the 2026-10-05 exploratory test: custom transports.

test("custom transports: timeoutMs and maxResponseBytes hold (04#1)", async () => {
  const slow = new RequestEngine({
    timeoutMs: 100,
    maxRetries: 0,
    transport: () => new Promise((resolve) => setTimeout(() => resolve(jsonResponse({ success: true, result: 1 })), 3000).unref()),
  });
  const started = Date.now();
  await assert.rejects(() => slow.getJson("/x"), GovDataNetworkError);
  assert.ok(Date.now() - started < 2000);
  const big = new RequestEngine({
    maxResponseBytes: 1000,
    transport: async () => rawResponse(Buffer.alloc(5_000_000, 0x20), "application/json"),
  });
  await assert.rejects(
    () => big.getJson("/x"),
    (err) => err instanceof GovDataNetworkError && /size limit of 1000 bytes .*--max-response-bytes/.test(err.message),
  );
});

test("custom transports: Retry-After and Location in any case or a Headers object, byte-array bodies (04#2)", async () => {
  for (const headers of [{ "Retry-After": "31" }, new Headers({ "Retry-After": "31" })]) {
    const mt = makeMockTransport(() => ({ status: 429, headers: headers as unknown as HttpResponse["headers"], body: Buffer.from("{}") }));
    await assert.rejects(() => new RequestEngine({ transport: mt.transport, sleep: async () => {} }).getJson("/x"), GovDataApiError);
    assert.equal(mt.calls.length, 1, "a Retry-After above 30 s is not retried");
  }
  for (const headers of [{ Location: "/moved" }, new Headers({ Location: "/moved" })]) {
    let n = 0;
    const mt = makeMockTransport(() =>
      n++ === 0
        ? { status: 302, headers: headers as unknown as HttpResponse["headers"], body: Buffer.alloc(0) }
        : { status: 200, headers: {}, body: new Uint8Array(Buffer.from('{"ok":1}')) as Buffer },
    );
    assert.deepEqual(await new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport }).getJson("/x"), { ok: 1 });
    assert.equal(new URL(mt.last().url).pathname, "/moved");
  }
});

test("custom transports: a redirect to a non-http(s) URL is refused before the transport sees it (04#3)", async () => {
  for (const target of ["file:///etc/passwd", "data:application/json,{}", "javascript:alert(1)"]) {
    const mt = makeMockTransport(() => ({ status: 302, headers: { location: target }, body: Buffer.alloc(0) }));
    await assert.rejects(
      () => new RequestEngine({ transport: mt.transport }).getJson("/x"),
      (err) => err instanceof GovDataNetworkError && /unsupported protocol/.test(err.message),
    );
    assert.equal(mt.calls.length, 1, target);
  }
});

test("custom transports: a malformed response or a thrown error is a GovDataNetworkError (04#4)", async () => {
  for (const response of [
    { headers: {}, body: Buffer.from("{}") },
    { status: "200", headers: {}, body: Buffer.from("{}") },
    { status: 200, body: Buffer.from("{}") },
    { status: 200, headers: {} },
    { status: 200, headers: {}, body: "{}" },
  ]) {
    const e = new RequestEngine({ transport: async () => response as unknown as HttpResponse });
    await assert.rejects(() => e.getJson("/x"), GovDataNetworkError, JSON.stringify(response));
  }
  const thrower = new RequestEngine({ transport: async () => { throw new Error("boom"); } });
  await assert.rejects(() => thrower.getJson("/x"), (err) => err instanceof GovDataNetworkError && /failed: boom/.test(err.message));
});

test("a server error detail is cut at 500 characters; the body keeps it all (03#2)", async () => {
  const body = { success: false, error: { __type: "Search Error", message: "x".repeat(200_000) } };
  const e = new RequestEngine({ transport: async () => jsonResponse(body, 409) });
  await assert.rejects(
    () => e.getJson("/api/3/action/package_search"),
    (err) =>
      err instanceof GovDataApiError &&
      err.message.length < 700 &&
      err.message.endsWith("…") &&
      err.detail!.length === 501 &&
      err.body.length > 200_000,
  );
});

test("cutText never cuts inside a surrogate pair; toWellFormed replaces half a character", () => {
  assert.equal(cutText("ab\u{1f600}cd", 3), "ab");
  assert.equal(cutText("ab\u{1f600}cd", 4), "ab\u{1f600}");
  assert.equal(cutText("short", 10), "short");
  assert.equal(toWellFormed("a\ud83d b\ude00 \u{1f600}"), "a\ufffd b\ufffd \u{1f600}");
});

test("a server message cut at 500 characters keeps the message well-formed (error answer and success:false)", async () => {
  for (const message of ["\u{1f600}".repeat(400), "a" + "\u{1f600}".repeat(400)]) {
    const error = { __type: "Search Error", message };
    for (const status of [409, 200]) {
      const body = Buffer.from(JSON.stringify({ success: false, error }));
      const client = new GovDataClient({ maxRetries: 0, transport: async () => ({ status, headers: { "content-type": "application/json" }, body }) });
      await assert.rejects(client.organizationList(), (err: Error) => {
        assert.equal(toWellFormed(err.message), err.message);
        assert.match(err.message, /…$/);
        return true;
      });
    }
  }
});

test("an action name, a scheme and a rejected string are quoted at most 500 characters long (L3)", async () => {
  const name = "a".repeat(5000);
  for (const body of [{ success: false, error: { message: "denied" } }, { hello: "world" }, { success: true }]) {
    const client = new GovDataClient({ transport: async () => jsonResponse(body) });
    await assert.rejects(client.action(name), (err: Error) => {
      // The request (the URL holds the name) and the name: two values, each cut at 500.
      assert.ok(err.message.length < 1300, `${err.message.length}: ${err.message.slice(0, 100)}`);
      assert.match(err.message, /a…/);
      return true;
    });
  }
  assert.throws(() => validateBaseUrl(`${"x".repeat(5000)}://host`), (err: Error) => {
    assert.ok(err.message.length < 800, `${err.message.length}`);
    assert.match(err.message, /x…/);
    return true;
  });
  const client = new GovDataClient({ transport: async () => jsonResponse({ success: true, result: [] }) });
  await assert.rejects(client.packageList({ limit: "y".repeat(5000) as unknown as number }), (err: Error) => {
    assert.ok(err.message.length < 800, `${err.message.length}`);
    assert.match(err.message, /y…/);
    return true;
  });
});

test("credentials a server echoes are scrubbed from the error: Basic, user:password, password (L13)", async () => {
  const basic = Buffer.from("alice:pa ss-pw", "utf8").toString("base64");
  const body = JSON.stringify({ success: false, error: { message: `no: Basic ${basic} / alice:pa ss-pw / pa ss-pw` } });
  const engine = new RequestEngine({
    baseUrl: "https://alice:pa%20ss-pw@mirror.example",
    transport: async () => ({ status: 403, headers: { "content-type": "application/json" }, body: Buffer.from(body) }),
  });
  await assert.rejects(engine.getJson("/api/3/action/organization_list"), (err: GovDataApiError) => {
    for (const form of [basic, "alice:pa ss-pw", "pa ss-pw"]) {
      assert.ok(!err.message.includes(form), err.message);
      assert.ok(!err.body.includes(form), err.body);
    }
    assert.match(err.message, /no: Basic \*\*\* \/ \*\*\* \/ \*\*\*/);
    return true;
  });
  // The same echo in a success:false envelope on HTTP 200.
  const client = new GovDataClient({
    baseUrl: "https://alice:pa%20ss-pw@mirror.example",
    transport: async () => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(body) }),
  });
  await assert.rejects(client.organizationList(), (err: Error) => {
    for (const form of [basic, "alice:pa ss-pw", "pa ss-pw"]) assert.ok(!err.message.includes(form), err.message);
    return true;
  });
});

test("echoedCredentialForms treats a userinfo without a password as a token (Basic `TOKEN:`)", () => {
  const basic = (pair: string): string => Buffer.from(pair, "utf8").toString("base64");
  assert.deepEqual(echoedCredentialForms("alice:s3cret"), [basic("alice:s3cret"), "alice:s3cret", "s3cret"]);
  assert.deepEqual(echoedCredentialForms("T0ken"), [basic("T0ken:"), "T0ken:", "T0ken"]);
  assert.deepEqual(echoedCredentialForms("T0ken:"), [basic("T0ken:"), "T0ken:", "T0ken"]);
  assert.deepEqual(echoedCredentialForms("T%C3%B6k"), [basic("Tök:"), "Tök:"]); // short: not alone
  assert.deepEqual(echoedCredentialForms(":pw12"), [basic(":pw12"), ":pw12", "pw12"]);
  assert.deepEqual(echoedCredentialForms(""), []);
  assert.deepEqual(echoedCredentialForms(":"), []);
});

test("a token userinfo (no password) a server echoes is scrubbed from the error in every form", async () => {
  const token = "tok3nSECRETvalue";
  const basic = Buffer.from(`${token}:`, "utf8").toString("base64");
  for (const baseUrl of [`https://${token}@mirror.example`, `https://${token}:@mirror.example`]) {
    const body = JSON.stringify({
      success: false,
      error: { message: `rejected Authorization: Basic ${basic} (decoded ${token}:) token ${token}` },
    });
    const respond = (status: number) => async (): Promise<HttpResponse> => ({
      status,
      headers: { "content-type": "application/json" },
      body: Buffer.from(body),
    });
    const engine = new RequestEngine({ baseUrl, transport: respond(401), maxRetries: 0 });
    await assert.rejects(engine.getJson("/api/3/action/package_show"), (err: GovDataApiError) => {
      for (const text of [err.message, err.body, err.detail ?? ""]) {
        assert.ok(!text.includes(token) && !text.includes(basic), `${baseUrl}: ${text}`);
      }
      return true;
    });
    // The same echo in a success:false envelope on HTTP 200.
    const client = new GovDataClient({ baseUrl, transport: respond(200), maxRetries: 0 });
    await assert.rejects(client.organizationList(), (err: Error) => {
      assert.ok(!err.message.includes(token) && !err.message.includes(basic), err.message);
      return true;
    });
  }
});

test("onRetry is called once per retry, with the event fields, right before the sleep", async () => {
  const log: string[] = [];
  const events: unknown[] = [];
  let n = 0;
  const mt = makeMockTransport(() =>
    n++ < 2
      ? { status: 503, headers: n === 1 ? { "retry-after": "2" } : {}, body: Buffer.from("{}") }
      : jsonResponse({ ok: 1 }),
  );
  const e = new RequestEngine({
    transport: mt.transport,
    baseUrl: "https://user:pw@example.test",
    maxRetries: 3,
    sleep: async (ms) => void log.push(`sleep ${ms}`),
    onRetry: (ev) => {
      events.push(ev);
      log.push("retry");
    },
  });
  await e.getJson("/x");
  assert.deepEqual(log, ["retry", "sleep 2000", "retry", "sleep 400"]);
  assert.deepEqual(events, [
    { retry: 1, maxRetries: 3, delayMs: 2000, status: 503, url: "https://example.test/x" },
    { retry: 2, maxRetries: 3, delayMs: 400, status: 503, url: "https://example.test/x" },
  ]);
});

test("onRetry reports a reset connection without a status", async () => {
  let n = 0;
  const events: unknown[] = [];
  const mt = makeMockTransport(() => {
    if (n++ === 0) throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    return jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {}, onRetry: (ev) => void events.push(ev) });
  await e.getJson("/x");
  assert.equal(events.length, 1);
  assert.equal((events[0] as { status?: number }).status, undefined);
  assert.equal((events[0] as { retry: number }).retry, 1);
});

test("a throw in onRetry is swallowed", async () => {
  let n = 0;
  const mt = makeMockTransport(() => (n++ === 0 ? { status: 503, headers: {}, body: Buffer.from("{}") } : jsonResponse({ ok: 1 })));
  const e = new RequestEngine({
    transport: mt.transport,
    sleep: async () => {},
    onRetry: () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
});

test("onRetry is never called without a retry", async () => {
  const events: unknown[] = [];
  const onRetry = (ev: unknown) => void events.push(ev);
  const ok = new RequestEngine({ transport: makeMockTransport(() => jsonResponse({})).transport, sleep: async () => {}, onRetry });
  await ok.getJson("/x");
  const notFound = new RequestEngine({
    transport: makeMockTransport(() => jsonResponse({ detail: "no" }, 404)).transport,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(notFound.getJson("/x"), GovDataApiError);
  // retries exhausted: the last 503 is an error, not a retry
  const down = new RequestEngine({
    transport: makeMockTransport(() => ({ status: 503, headers: {}, body: Buffer.from("{}") })).transport,
    maxRetries: 1,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(down.getJson("/x"), GovDataApiError);
  assert.equal(events.length, 1);
  // a Retry-After over the cap is not retried
  const long = new RequestEngine({
    transport: makeMockTransport(() => ({ status: 503, headers: { "retry-after": "999999" }, body: Buffer.from("{}") })).transport,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(long.getJson("/x"), GovDataApiError);
  assert.equal(events.length, 1);
});

test("onRetry must be a function", () => {
  assert.throws(() => new RequestEngine({ onRetry: 5 as never }), GovDataValidationError);
});

test("a header named __proto__ is an ordinary header, never the prototype of the headers read (T12)", async () => {
  // A JavaScript transport may return any object; JSON.parse makes "__proto__" an own key.
  const headers = JSON.parse('{"__proto__":{"content-type":"text/html"}}') as Record<string, string>;
  const e = new RequestEngine({ transport: async () => ({ status: 200, headers, body: Buffer.from("<html>") }) });
  // With the prototype set, "text/html" was read as the Content-Type and named in the message.
  await assert.rejects(e.getJson("/x"), (err: Error) => err instanceof GovDataParseError && !err.message.includes("text/html"));
  const fetchLike = new Headers([["__proto__", "x"], ["content-type", "application/json"]]);
  const f = new RequestEngine({ transport: async () => ({ status: 200, headers: fetchLike as unknown as Record<string, string>, body: Buffer.from('{"a":1}') }) });
  assert.deepEqual(await f.getJson("/x"), { a: 1 });
});

test("an answer error names the request: method and URL, userinfo left out (D9)", async () => {
  const answers: Array<[string, () => HttpResponse]> = [
    ['the answer is not valid JSON (expected JSON, got Content-Type "text/html").', () => rawResponse("<html>", "text/html")],
    ["the answer is not valid JSON.", () => rawResponse("{", "application/json")],
    ["empty response body.", () => rawResponse(" ", "application/json")],
    ["the number 1e400 cannot be represented exactly.", () => rawResponse('{"n":1e400}', "application/json")],
    ['unsupported response charset "x-bogus".', () => rawResponse("{}", "application/json; charset=x-bogus")],
  ];
  for (const [what, respond] of answers) {
    const e = new RequestEngine({ baseUrl: "https://alice:s3cret@ckan.example.test", transport: makeMockTransport(respond).transport });
    await assert.rejects(e.getJson("/items", { q: "x" }), (err: unknown) => {
      assert.ok(err instanceof GovDataParseError, what);
      assert.equal(err.message, `GET https://ckan.example.test/items?q=x: ${what}`);
      return true;
    });
  }
});

test("text that is not valid is replaced with U+FFFD and reported through onWarning, never silently (D2)", async () => {
  const cases: Array<[string, Buffer, string, unknown, number]> = [
    // A lone surrogate written as an escape (high alone, low alone); a real pair and an escaped backslash stay.
    ["lone escapes", Buffer.from('{"a":"x\\ud800y","b":"\\udc00","c":"\\ud83d\\ude00","d":"\\\\ud800"}'), "application/json", { a: "x\ufffdy", b: "\ufffd", c: "\u{1f600}", d: "\\ud800" }, 2],
    // A lone surrogate in a member name.
    ["lone in a key", Buffer.from('{"\\udbff":1}'), "application/json", { "\ufffd": 1 }, 1],
    // Invalid UTF-8 bytes; a U+FFFD the server sent is not counted.
    ["invalid bytes", Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff, 0xc3]), Buffer.from('","b":"\ufffd"}')]), "application/json", { a: "\ufffd\ufffd", b: "\ufffd" }, 2],
    // A byte undefined in a single-byte charset.
    ["iso-8859-3", Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xa5]), Buffer.from('"}')]), "application/json; charset=iso-8859-3", { a: "\ufffd" }, 1],
  ];
  for (const [label, body, type, expected, count] of cases) {
    const warnings: string[] = [];
    const e = new RequestEngine({ onWarning: (m) => warnings.push(m), transport: makeMockTransport(() => rawResponse(body, type)).transport });
    const value = await e.getJson("/items", { q: "x" });
    assert.deepEqual(value, expected, label);
    assert.ok(!/[\ud800-\udfff]/u.test(JSON.stringify(value)), `${label}: well-formed`);
    assert.deepEqual(warnings, [
      `GET https://ckan.govdata.de/items?q=x: ${count} ${count === 1 ? "character" : "characters"} of the answer ${count === 1 ? "was" : "were"} not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.`,
    ], label);
  }
  // Valid text: no warning; a throwing hook never fails the request.
  const quiet: string[] = [];
  const ok = new RequestEngine({ onWarning: (m) => quiet.push(m), transport: makeMockTransport(() => rawResponse('{"a":"\\u00fc\ufffd"}', "application/json")).transport });
  assert.deepEqual(await ok.getJson("/x"), { a: "ü\ufffd" });
  assert.deepEqual(quiet, []);
  const throwing = new RequestEngine({ onWarning: () => { throw new Error("hook"); }, transport: makeMockTransport(() => rawResponse('"\\ud800"', "application/json")).transport });
  assert.equal(await throwing.getJson("/x"), "\ufffd");
  assert.throws(() => new RequestEngine({ onWarning: "log" as unknown as () => void }), GovDataValidationError);
});

test("bigIntegerKeys: a declared member's number is its exact literal as a string; others keep the rule (D3)", async () => {
  const { bigIntegerKeysOption, firstInexactNumber, scanNumbers } = await import("../src/engine.js");
  const { GovDataValidationError } = await import("../src/errors.js");
  const body = '{"_version_":1858054135406919680,"small":{"_version_":5},"neg":{"\\u005fversion_":-12345678901234567890},' +
    '"s":{"_version_":"text"},"n":{"_version_":null},"arr":{"_version_":[1]},"t":"\\"_version_\\":1","n2":42}';
  const e = new RequestEngine({
    bigIntegerKeys: new Set(["_version_"]),
    transport: makeMockTransport(() => rawResponse(body, "application/json")).transport,
  });
  assert.deepEqual(await e.getJson("/x"), {
    _version_: "1858054135406919680", small: { _version_: "5" }, neg: { _version_: "-12345678901234567890" },
    s: { _version_: "text" }, n: { _version_: null }, arr: { _version_: [1] }, t: '"_version_":1', n2: 42,
  });
  assert.deepEqual([...e.bigIntegerKeys], ["_version_"]);
  // An undeclared big number is still refused; a declared member doesn't make others exact.
  const other = new RequestEngine({
    bigIntegerKeys: ["_version_"] as unknown as ReadonlySet<string>,
    transport: makeMockTransport(() => rawResponse('{"_version_":1858054135406919680,"id":12345678901234567890}', "application/json")).transport,
  });
  await assert.rejects(other.getJson("/x"), /the number 12345678901234567890 cannot be represented exactly/);
  // Malformed stays malformed: a declared member with a leading zero still fails JSON.parse.
  const malformed = new RequestEngine({ bigIntegerKeys: new Set(["_version_"]), transport: makeMockTransport(() => rawResponse('{"_version_":01}', "application/json")).transport });
  await assert.rejects(malformed.getJson("/x"), /not valid JSON/);
  for (const bad of [new Set([""]), new Set([1]), "x", 5, null]) {
    assert.throws(() => new RequestEngine({ bigIntegerKeys: bad as unknown as ReadonlySet<string> }),
      (err: unknown) => err instanceof GovDataValidationError && err.message === "Invalid option bigIntegerKeys: expected a set of non-empty member names.");
  }
  // The option reader copies a set or a list; undefined is none.
  const names = new Set(["a"]);
  const copy = bigIntegerKeysOption(names);
  names.add("b");
  assert.deepEqual([...copy], ["a"]);
  assert.deepEqual([...bigIntegerKeysOption(["x", "y"] as unknown as ReadonlySet<string>)], ["x", "y"]);
  assert.equal(bigIntegerKeysOption(undefined).size, 0);
  // Without declarations the scan is the plain number check.
  assert.equal(firstInexactNumber('{"a":"1e400","b":3e-324}'), "3e-324");
  assert.deepEqual(scanNumbers('{"a":1}'), { json: '{"a":1}', inexact: undefined });
});

test("an answer longer than V8's longest string is a GovDataParseError naming the request, not a plain Error (T14)", async (t) => {
  // A real one needs a body of 512 MB and more (possible with maxResponseBytes 0): V8's own
  // error is stood in for, for the body marked by its length.
  const huge = Buffer.from('{"help":"h","success":true,"result":{}}    ');
  const tooLong = Object.assign(new Error("Cannot create a string longer than 0x1fffffe8 characters"), { code: "ERR_STRING_TOO_LONG" });
  const decode = TextDecoder.prototype.decode;
  t.mock.method(TextDecoder.prototype, "decode", function (this: InstanceType<typeof TextDecoder>, input?: Uint8Array, options?: { stream?: boolean }) {
    if (input !== undefined && input.byteLength === huge.length) throw tooLong;
    return decode.call(this, input, options);
  });
  const toString = Buffer.prototype.toString;
  t.mock.method(Buffer.prototype, "toString", function (this: Buffer, ...args: Parameters<Buffer["toString"]>) {
    if (this.length === huge.length && args[0] === "utf8") throw tooLong;
    return toString.apply(this, args);
  });
  const e = new RequestEngine({ maxResponseBytes: 0, transport: makeMockTransport(() => rawResponse(huge, "application/json")).transport });
  await assert.rejects(e.getJson("/api/3/action/package_show", { id: "x" }), (err: unknown) => {
    assert.ok(err instanceof GovDataParseError, String(err));
    assert.equal(
      err.message,
      `GET https://ckan.govdata.de/api/3/action/package_show?id=x: the answer is too large to read as text (${huge.length} bytes; the longest string is 536870888 characters).`,
    );
    return true;
  });
  // An error status with such a body is still the API error, without the unreadable body.
  const failing = new RequestEngine({ maxResponseBytes: 0, transport: makeMockTransport(() => rawResponse(huge, "text/plain", 500)).transport });
  await assert.rejects(failing.getJson("/x"), (err: unknown) => err instanceof GovDataApiError && err.status === 500 && err.body === "");
});

test("a number with a long run of zeros is refused in linear time (A)", async () => {
  // The trailing-zero regex `/0+$/` tried a match at every zero of a run that doesn't end the
  // literal: 1.<100 000 zeros>1e300 took about 15 s, past --timeout (the scan runs once the answer is in).
  const literal = `1.${"0".repeat(100_000)}1e300`;
  const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(`{"n":${literal}}`, "application/json")).transport });
  const start = performance.now();
  await assert.rejects(e.getJson("/x"), (err: unknown) => err instanceof GovDataParseError && /cannot be represented exactly/.test(err.message));
  const ms = performance.now() - start;
  assert.ok(ms < 1000, `${Math.round(ms)} ms`);
  // The count of zeros still sets the exponent: trailing zeros in the fraction are no digits.
  const g = new RequestEngine({ transport: makeMockTransport(() => rawResponse(`{"n":9007199254740992.${"0".repeat(50_000)}}`, "application/json")).transport });
  assert.equal((await g.getJson<{ n: number }>("/x")).n, 2 ** 53);
});

/** How long `work` takes, in milliseconds. */
function elapsed(work: () => unknown): number {
  const start = performance.now();
  work();
  return performance.now() - start;
}

test("redactUrlUserinfo hides every URL's userinfo in one linear pass, however many URLs (B)", async () => {
  const { redactUrlUserinfo } = await import("../src/errors.js");
  // The URL regex this replaces (a scheme tried at every word start) takes about 3 s on this.
  assert.ok(elapsed(() => redactUrlUserinfo("a.".repeat(30_000))) < 1000);
  assert.equal(redactUrlUserinfo("a -https://u:p@h/x and x-ftp://v@w?q, mail@example.org"), "a -https://***@h/x and x-ftp://***@w?q, mail@example.org");
  assert.equal(redactUrlUserinfo("argument 'ftp://user:s3cret@h.example' is invalid"), "argument 'ftp://***@h.example' is invalid");
  assert.equal(redactUrlUserinfo("1://u:p@h ://u:p@h"), "1://u:p@h ://u:p@h");
  assert.equal(redactUrlUserinfo("https://h/p?u=a@b"), "https://h/p?u=a@b");
  for (const text of ["a".repeat(1_000_000), "a.".repeat(500_000), "://".repeat(100_000), `https://${"u".repeat(1_000_000)}`]) {
    assert.equal(redactUrlUserinfo(text), text);
  }
  assert.equal(redactUrlUserinfo("https://u:p@h ".repeat(100_000)), "https://***@h ".repeat(100_000));
});

test("redactUrlUserinfo hides the userinfo of a URL glued onto the one before it, still linear (B2)", async () => {
  const { redactUrlUserinfo } = await import("../src/errors.js");
  // The authority read for the first `://` ends at the `/` of the second; the second URL starts
  // inside it (its scheme is the first one's host, or follows a redacted `@`), so the search goes
  // on after each `://`, not after the authority.
  assert.equal(redactUrlUserinfo("https://host://u:p@h"), "https://host://***@h");
  assert.equal(redactUrlUserinfo("https://u:p@x://v:q@w"), "https://***@x://***@w");
  assert.equal(redactUrlUserinfo("see https://h.example:/x://u:p@h"), "see https://h.example:/x://***@h");
  assert.equal(redactUrlUserinfo("https://u:p@1://v:q@w"), "https://***@1://v:q@w");
  // Many glued URLs, unredacted and redacted, and long scheme-character runs: one pass each.
  const n = 100_000;
  for (const [text, want] of [
    [`${"a://".repeat(n)}u:p@h`, `${"a://".repeat(n)}***@h`],
    ["x://u:p@".repeat(n), "x://***@".repeat(n)],
    [`${"a.".repeat(500_000)}://u:p@h`, `${"a.".repeat(500_000)}://***@h`],
    [`https://${"a.".repeat(500_000)}://u:p@h`, `https://${"a.".repeat(500_000)}://***@h`],
    ["a:".repeat(500_000), "a:".repeat(500_000)],
  ] as const) {
    let got = "";
    const ms = elapsed(() => (got = redactUrlUserinfo(text)));
    assert.ok(got === want, `${text.slice(0, 40)}…`);
    assert.ok(ms < 1000, `${Math.round(ms)} ms on ${text.slice(0, 40)}…`);
  }
});

test("a TextBuilder joins its pieces in order across batches", async () => {
  const { TextBuilder } = await import("../src/errors.js");
  const b = new TextBuilder();
  const expected: string[] = [];
  for (let i = 0; i < 40_000; i++) {
    b.push(String(i), ",");
    expected.push(String(i), ",");
  }
  assert.equal(b.toString(), expected.join(""));
  assert.equal(new TextBuilder().toString(), "");
});

test("scanNumbers quotes millions of declared members within a small heap (C)", { timeout: 30_000 }, () => {
  // Starts a process with a 128 MB heap: 30 s instead of the suite's 5 s.
  // One `+=` per quoted member made a rope node each: 3 million of them exhausted a 128 MB heap.
  const engine = new URL("../src/engine.js", import.meta.url).href;
  const n = 3_000_000;
  const script =
    `const { scanNumbers } = await import(${JSON.stringify(engine)});` +
    `const json = "[" + '{"k":1},'.repeat(${n - 1}) + '{"k":1}]';` +
    `process.stdout.write(String(scanNumbers(json, new Set(["k"])).json.length));`;
  const out = execFileSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(out, String(n * 10 + 1));
});

// A password with characters a JSON writer escapes (a quote) or may write as \u00XX (an umlaut).
const ECHO_PW = "pä\"s's-W0rd";
const ECHO_BASE = `https://alice:${encodeURIComponent(ECHO_PW)}@mirror.example`;
const ECHO_BASIC = Buffer.from(`alice:${ECHO_PW}`, "utf8").toString("base64");
/** The forms of the credential an error must not carry: decoded, and as a quoted value spells them (`\"`). */
const ECHO_SECRETS = [ECHO_PW, `alice:${ECHO_PW}`, ECHO_BASIC].flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)]);

/** Everything a library user may log of an error: inspect, message, detail, errorType, and the decoded body. */
function everythingOf(err: unknown): string {
  let text = inspect(err, { depth: 10, showHidden: true });
  const e = err as { message?: unknown; detail?: unknown; errorType?: unknown; body?: unknown };
  text += [e.message, e.detail, e.errorType, e.body].map(String).join("\n");
  let decoded: unknown;
  try {
    decoded = typeof e.body === "string" ? JSON.parse(e.body) : undefined;
  } catch {
    // not JSON: the body as sent is all a caller reads
  }
  const walk = (v: unknown): void => {
    if (typeof v === "string") text += `\n${v}`;
    else if (v !== null && typeof v === "object") {
      for (const [k, w] of Object.entries(v)) {
        text += `\n${k}`;
        walk(w);
      }
    }
  };
  walk(decoded);
  return text;
}

/** `text` as a JSON writer that escapes every non-ASCII character writes it (Python's json.dumps). */
const asciiJson = (text: string): string =>
  JSON.stringify(text).replace(/[\u0080-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
/** `text` with every character written as a \uXXXX escape: no spelling of it as sent matches. */
const escapedJson = (text: string): string => `"${[...text].map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}"`;

test("a credential echoed with JSON escapes is scrubbed from the message, the detail and the decoded body (D)", async () => {
  const echoes: Array<[string, string]> = [
    ["the password, ASCII-only JSON", asciiJson(`wrong password ${ECHO_PW}`)],
    ["the user:password, minimal JSON", JSON.stringify(`bad login alice:${ECHO_PW}`)],
    ["the password, every character escaped", escapedJson(ECHO_PW)],
    ["the site URL as the server decoded it", JSON.stringify(`no access to https://alice:${ECHO_PW}@mirror.example/x`)],
  ];
  const shapes: Array<[string, (json: string) => string]> = [
    ["CKAN's error object", (json) => `{"help":"h","success":false,"error":{"__type":"Authorization Error","message":${json}}}`],
    ["CKAN's validation error (no message)", (json) => `{"help":"h","success":false,"error":{"__type":"Validation Error","name":[${json}]}}`],
    ["a plain message", (json) => `{"message":${json}}`],
    ["a bare JSON string", (json) => json],
  ];
  for (const status of [401, 500]) {
    for (const [shape, bodyWith] of shapes) {
      for (const [label, json] of echoes) {
        const e = new RequestEngine({ baseUrl: ECHO_BASE, maxRetries: 0, transport: async () => rawResponse(bodyWith(json), "application/json", status) });
        const err = await e.getJson("/api/3/action/status_show").catch((caught: unknown) => caught);
        assert.ok(err instanceof GovDataApiError && err.message.startsWith(`HTTP ${status} `), `${shape}, ${label}: ${String(err)}`);
        const seen = everythingOf(err);
        for (const secret of ECHO_SECRETS) assert.ok(!seen.includes(secret), `${status} ${shape}, ${label}: ${seen.slice(0, 2000)}`);
      }
    }
  }
});

test("a credential in CKAN's success:false error on HTTP 200 is scrubbed, its __type and a validation error too (D)", async () => {
  for (const json of [asciiJson(ECHO_PW), JSON.stringify(`alice:${ECHO_PW}`), escapedJson(ECHO_PW)]) {
    for (const body of [
      `{"help":"h","success":false,"error":{"__type":${json},"message":${json}}}`,
      `{"help":"h","success":false,"error":{"__type":"Validation Error","name":[${json}]}}`,
    ]) {
      const client = new GovDataClient({ baseUrl: ECHO_BASE, transport: async () => rawResponse(body, "application/json") });
      const err = await client.packageShow("a1").catch((caught: unknown) => caught);
      assert.ok(err instanceof Error, String(err));
      const seen = everythingOf(err);
      for (const secret of ECHO_SECRETS) assert.ok(!seen.includes(secret), `${body}: ${seen.slice(0, 2000)}`);
    }
  }
});

test("an error body keeps its spelling unless a credential hides behind an escape (D)", async () => {
  const base = "https://alice:s3cret-pw@mirror.example";
  const bodyOf = async (body: string): Promise<string> => {
    const e = new RequestEngine({ baseUrl: base, maxRetries: 0, transport: async () => rawResponse(body, "application/json", 500) });
    const err = await e.getJson("/x").catch((caught: unknown) => caught);
    assert.ok(err instanceof GovDataApiError, String(err));
    return err.body;
  };
  // No credential, or one spelled as sent: the body as sent (scrubbed), escapes kept.
  assert.equal(await bodyOf('{"m":"caf\\u00e9 \\"x\\""}'), '{"m":"caf\\u00e9 \\"x\\""}');
  assert.equal(await bodyOf('{"m":"pw s3cret-pw \\u00e9"}'), '{"m":"pw *** \\u00e9"}');
  // Escaped: written again decoded, scrubbed in that spelling.
  assert.equal(await bodyOf('{"m":"pw s3cret\\u002dpw \\u00e9"}'), '{"m":"pw *** é"}');
  // Not JSON: nobody decodes it, it stays as sent.
  assert.equal(await bodyOf("pw s3cret\\u002dpw"), "pw s3cret\\u002dpw");
  // Too deep to write again: left out.
  assert.equal(await bodyOf(`${"[".repeat(20_000)}"s3cret\\u002dpw"${"]".repeat(20_000)}`).then((b) => b.length < 100_000), true);
});

test("a credential in an answer's Content-Type or charset is scrubbed from the parse error (D)", async () => {
  for (const contentType of [`text/html; x=${ECHO_PW}`, `application/json; charset=${encodeURIComponent(ECHO_PW)}`, `text/${encodeURIComponent(`alice:${ECHO_PW}`)}`]) {
    const e = new RequestEngine({ baseUrl: ECHO_BASE, transport: async () => rawResponse("<html>", contentType) });
    const err = await e.getJson("/x").catch((caught: unknown) => caught);
    assert.ok(err instanceof GovDataParseError, String(err));
    const seen = everythingOf(err);
    for (const secret of ECHO_SECRETS) assert.ok(!seen.includes(secret) && !seen.includes(encodeURIComponent(secret)), `${contentType}: ${seen.slice(0, 2000)}`);
  }
});
