import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertValid,
  baseUrlProblem,
  fieldProblem,
  headerValueProblem,
  idProblem,
  isBlank,
  listProblem,
  normalizeToken,
  queryValueProblem,
  sortProblem,
  textProblem,
  tokenProblem,
} from "@maschinenlesbar.org/govdata-client/internal/validate";
import { GovDataError, GovDataValidationError } from "@maschinenlesbar.org/govdata-client/internal/errors";
import * as library from "../src/index.js";
import { GovDataClient } from "@maschinenlesbar.org/govdata-client/internal/client";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import { assertSameRequests, jsonResponse, parity, untimed } from "./helpers.js";

const positive = (n: number): string | undefined => (n > 0 ? undefined : "Expected a positive number.");

test("assertValid returns a valid value unchanged", () => {
  assert.equal(assertValid("rows", 5, positive), 5);
});

test("assertValid throws GovDataValidationError 'Invalid <name>: <reason>'", () => {
  assert.throws(
    () => assertValid("rows", 0, positive),
    (err: unknown) =>
      err instanceof GovDataValidationError &&
      err instanceof GovDataError &&
      err.name === "GovDataValidationError" &&
      err.message === "Invalid rows: Expected a positive number.",
  );
});

test("the package root exports GovDataValidationError and assertValid", () => {
  assert.equal(library.GovDataValidationError, GovDataValidationError);
  assert.equal(library.assertValid, assertValid);
});

test("run() reports a GovDataValidationError from an action as a usage error", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: (): GovDataClient => {
      throw new GovDataValidationError("Invalid rows: Expected a positive number.");
    },
  };
  assert.equal(await run(["tags"], deps), 1);
  assert.deepEqual(err.map(untimed), ["ERROR [govdata.cli] Invalid rows: Expected a positive number."]);
  assert.deepEqual(out, []);
});

test("parity() runs the CLI and the library on one transport and splits their requests", async () => {
  const result = await parity(["--compact", "tags"], (transport) => new GovDataClient({ transport }).tagList(), {
    responder: () => jsonResponse({ help: "h", success: true, result: ["a", "b"] }),
  });
  assert.equal(result.cli.out, '["a","b"]');
  assert.deepEqual(result.lib.value, ["a", "b"]);
  assert.equal(result.cli.requests.length, 1);
  assertSameRequests(result);
});

test("isBlank: nothing but whitespace, control and format characters or combining marks (D8)", () => {
  for (const v of ["", " ", "\t", " \n ", "\u00a0", "\u3000", "\u200b", "\u00ad", "\ufeff", "\u0301\u0308", " \u200b "]) {
    assert.equal(isBlank(v), true, JSON.stringify(v));
  }
  for (const v of ["x", " x ", "0", "a\u200bb", "\u00e9"]) assert.equal(isBlank(v), false, JSON.stringify(v));
});

test("textProblem: not blank, no lone surrogate, no control or format character but TAB/LF/CR and ZWNJ/ZWJ; quoted visibly (D8, D10)", () => {
  for (const v of ["Klima", " a ", "Mu\u0308ller", "a\tb", "a\nb", "a\u200db", "\ud83d\ude00"]) assert.equal(textProblem(v), undefined, JSON.stringify(v));
  assert.equal(textProblem(""), "Expected a non-empty value.");
  assert.equal(textProblem("\u200b"), "Expected a non-empty value.");
  assert.equal(textProblem(undefined as unknown as string), "Expected a string.");
  assert.equal(textProblem(5 as unknown as string), "Expected a string.");
  assert.equal(textProblem("el\u200bbe"), '"el\\u200bbe" contains an invisible character (U+200B).');
  assert.equal(textProblem("a\u0000b"), '"a\\u0000b" contains a control character (U+0000).');
  assert.equal(textProblem("a\ud800"), '"a\\ud800" contains half of a character (a lone surrogate).');
});

test("tokenProblem, idProblem, sortProblem, fieldProblem: tokens are trimmed, never invisible (D8)", () => {
  for (const v of ["haushalt", " haushalt ", "haushalt\n"]) {
    assert.equal(tokenProblem(v), undefined, JSON.stringify(v));
    assert.equal(idProblem(v), undefined, JSON.stringify(v));
    assert.equal(normalizeToken(v), "haushalt");
  }
  assert.equal(tokenProblem("a\u200db"), '"a\\u200db" contains an invisible or control character (U+200D).');
  assert.equal(idProblem("a/b"), '"a/b" is not an id or name: it contains "/".');
  assert.equal(idProblem(" .. "), '"." and ".." are not ids.');
  for (const v of ["metadata_modified desc", "name asc, metadata_modified desc", " score DESC "]) assert.equal(sortProblem(v), undefined, v);
  assert.match(sortProblem("metadata_modified") ?? "", /is not a sort expression/);
  assert.match(sortProblem("metadata_modified sideways") ?? "", /is not a sort expression/);
  assert.equal(fieldProblem("res_format"), undefined);
  assert.match(fieldProblem("res format") ?? "", /is not a Solr field name/);
});

test("listProblem and queryValueProblem: no empty list, no blank or missing item (D8, Bug 01-2)", () => {
  assert.equal(listProblem(["a", "b"]), undefined);
  assert.equal(listProblem([]), "Expected at least one value.");
  assert.equal(listProblem(["a", " "]), "item 2 of 2: Expected a non-empty value.");
  for (const v of ["x", 5, true, new Date(0), ["a", 1], null, undefined]) assert.equal(queryValueProblem(v), undefined, String(v));
  assert.equal(queryValueProblem([null]), "item 1 of 1 is null; a list holds values only (leave the parameter out instead).");
  assert.equal(queryValueProblem(["a", undefined]), "item 2 of 2 is undefined; a list holds values only (leave the parameter out instead).");
  assert.equal(queryValueProblem([]), "Expected at least one value; leave the parameter out instead.");
  assert.match(queryValueProblem({}) ?? "", /^Expected a string, a finite number/);
  assert.equal(queryValueProblem(["a", ""]), "item 2 of 2: Expected a non-empty value.");
});

test("headerValueProblem: not blank, no control characters but tab, Latin-1 only", () => {
  for (const v of ["govdata-cli", "caf\u00e9", "a\tb", "\u00ff"]) assert.equal(headerValueProblem(v), undefined, JSON.stringify(v));
  for (const v of ["", " ", "\t"]) assert.equal(headerValueProblem(v), "Expected a non-empty value.", JSON.stringify(v));
  for (const v of ["a\r\nb", "a\nb", "a\u0000b", "a\u007fb"]) {
    assert.equal(headerValueProblem(v), "Value contains control characters.", JSON.stringify(v));
  }
  for (const v of ["\u20ac", "\u0100", "a\u2603"]) {
    assert.equal(headerValueProblem(v), "Value contains characters outside Latin-1 (above U+00FF).", JSON.stringify(v));
  }
});

test("baseUrlProblem: no surrounding or embedded whitespace, no control characters", () => {
  for (const v of ["https://ckan.govdata.de", "https://ckan.govdata.de/", "http://u:p@h.test/ckan"]) {
    assert.equal(baseUrlProblem(v), undefined, v);
  }
  for (const v of [" https://h.test", "https://h.test/ ", "https://h.test\n", "\thttps://h.test"]) {
    assert.equal(baseUrlProblem(v), "A base URL cannot have surrounding whitespace.", JSON.stringify(v));
  }
  for (const v of ["https://h.test/a b", "https://h.\ttest", "https://h.test/a\u0000b", "https://h.test/\u007f", "https://h.test/a\u00a0b"]) {
    assert.equal(baseUrlProblem(v), "A base URL cannot contain whitespace or control characters.", JSON.stringify(v));
  }
});

test("baseUrlProblem: an absolute http(s) URL without a query or fragment", () => {
  assert.equal(baseUrlProblem(""), "Expected an absolute http(s) URL.");
  assert.equal(baseUrlProblem("  "), "Expected an absolute http(s) URL.");
  assert.equal(baseUrlProblem("not-a-url"), "Expected an absolute http(s) URL.");
  assert.equal(baseUrlProblem("ftp://x"), 'Unsupported scheme "ftp:". Expected an http(s) URL.');
  // A scheme is named only when the value spells `<scheme>://`: without it, it is a user name or a token (F5).
  for (const v of ["alice:s3cret@h.example", "T0kenS3cret:@h.example", "mailto:a@b.example", "data:text/plain,x"]) {
    assert.equal(baseUrlProblem(v), "Expected an absolute http(s) URL.", v);
  }
  assert.equal(baseUrlProblem("https://x/?q=1"), "A base URL cannot have a query (?) or fragment (#).");
  assert.equal(baseUrlProblem("https://x/#f"), "A base URL cannot have a query (?) or fragment (#).");
});

test("baseUrlProblem: no backslash, and the scheme followed by exactly // and the host (F, F4)", () => {
  // WHATWG ends an http(s) authority at "\" and repairs `http:host`, `http:/host`, `http:///host`
  // silently: the host requested would not be the one typed. The reasons quote nothing of the value.
  for (const v of ["https://h.example\\@other.example", "https://u:pw@h.example\\x", "https:\\\\h.example", "https://h.example/a\\b"]) {
    assert.equal(baseUrlProblem(v), 'A base URL cannot contain a backslash (\\); write "/" instead.', v);
  }
  for (const v of ["http:h.example", "http:/h.example", "http:///h.example", "HTTPS:h.example", "https:////h.example"]) {
    assert.equal(baseUrlProblem(v), 'Expected an absolute http(s) URL ("https://" and the host).', v);
  }
  assert.equal(baseUrlProblem("HTTPS://H.example"), undefined);
  assert.equal(baseUrlProblem("http:///user:s3cret@h.example/?q=1"), "A base URL cannot have a query (?) or fragment (#).");
});
