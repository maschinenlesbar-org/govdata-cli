// Conformance test P8 + P9 + P13 (fix plan 2026-10-06): a body is decoded by its declared
// charset (P8); a 2xx body without the documented shape is a parse error, never data or
// "nothing found" (P9); every rejected input is the library's validation error, never a raw
// TypeError or RangeError (P13). Shared across the *-cli repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { GovDataClient as Client } from "../src/client/client.js";
import {
  GovDataError as BaseError,
  GovDataParseError as ParseError,
  GovDataValidationError as ValidationError,
} from "../src/client/errors.js";
/** A call whose answer contains a text field, and how to read that field from the result. */
const textCall = (client: Client): Promise<unknown> => client.tagList();
const textBody = (text: string): unknown => ({ help: "h", success: true, result: [text] });
const readText = (result: unknown): string => (result as string[])[0]!;
/**
 * 2xx bodies the call must reject (error envelopes, empty or wrong shapes). A CKAN
 * `success: false` envelope is not listed: it is the API's own error report and surfaces
 * as a GovDataError with CKAN's message (client.test.ts).
 */
const malformedBodies: unknown[] = [
  null, {}, [], "text", 42, { error: "boom" }, { help: "h", success: "true", result: [] },
  { help: "h", success: true }, { help: "h", success: true, result: "x" }, { help: "h", success: true, result: null },
];
/** Library calls with wrong-typed or out-of-range input. */
const badCalls: Array<[string, () => unknown]> = [
  ["packageShow(5)", () => new Client().packageShow(5 as unknown as string)],
  ["packageShow(null)", () => new Client().packageShow(null as unknown as string)],
  ["organizationShow({})", () => new Client().organizationShow({} as unknown as string)],
  ["tagList(5)", () => new Client().tagList(5 as unknown as string)],
  ["action(5)", () => new Client().action(5 as unknown as string)],
  ["action(null)", () => new Client().action(null as unknown as string)],
  ["action('x', { q: {} })", () => new Client().action("x", { q: {} as unknown as string })],
  ["packageSearch(null)", () => new Client().packageSearch(null as unknown as object)],
  ["packageSearch({ fq: 'x' })", () => new Client().packageSearch({ fq: "x" as unknown as string[] })],
  ["packageSearch({ rows: -1 })", () => new Client().packageSearch({ rows: -1 })],
  ["packageList({ limit: 0 })", () => new Client().packageList({ limit: 0 })],
  ["timeoutMs: 'x'", () => new Client({ timeoutMs: "x" as unknown as number })],
  ["timeoutMs: -1", () => new Client({ timeoutMs: -1 })],
  ["maxRetries: 1.5", () => new Client({ maxRetries: 1.5 })],
  ["maxRedirects: 21", () => new Client({ maxRedirects: 21 })],
  ["retryDelayMs: 3e9", () => new Client({ retryDelayMs: 3_000_000_000 })],
  ["baseUrl: 5", () => new Client({ baseUrl: 5 as unknown as string })],
  ["userAgent: {}", () => new Client({ userAgent: {} as unknown as string })],
  ["transport: 'x'", () => new Client({ transport: "x" as never })],
  ["sleep: 1", () => new Client({ sleep: 1 as never })],
];
// --------------------------------------------------------------------------------------

const respond = (body: Buffer, contentType: string) => async (): Promise<HttpResponse> => ({
  status: 200,
  headers: { "content-type": contentType },
  body,
});

test("P8: a body is decoded by its declared charset", async () => {
  const text = "Müller µg/l";
  for (const [charset, encoding] of [["iso-8859-1", "latin1"], ["utf-8", "utf8"]] as const) {
    const body = Buffer.from(JSON.stringify(textBody(text)), encoding);
    const client = new Client({ transport: respond(body, `application/json; charset=${charset}`) });
    assert.equal(readText(await textCall(client)), text, charset);
  }
});

test("P9: a 2xx body without the documented shape is a parse error", async () => {
  for (const body of malformedBodies) {
    const client = new Client({ transport: respond(Buffer.from(JSON.stringify(body)), "application/json"), maxRetries: 0 });
    await assert.rejects(textCall(client), ParseError, `body ${JSON.stringify(body)}`);
  }
  for (const raw of ["", "<html>maintenance</html>"]) {
    const client = new Client({ transport: respond(Buffer.from(raw), "text/html"), maxRetries: 0 });
    await assert.rejects(textCall(client), BaseError, `raw ${JSON.stringify(raw)}`);
  }
});

test("P13: every rejected input is the validation error, never a raw TypeError", async () => {
  for (const [label, fn] of badCalls) {
    await assert.rejects(async () => fn(), (e: unknown) => e instanceof ValidationError, label);
  }
});
