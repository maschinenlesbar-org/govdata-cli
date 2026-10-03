import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, headerValueProblem, isBlank, textProblem } from "../src/client/validate.js";
import { GovDataError, GovDataValidationError } from "../src/client/errors.js";
import * as library from "../src/index.js";
import { GovDataClient } from "../src/client/client.js";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import { assertSameRequests, jsonResponse, parity } from "./helpers.js";

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
  assert.deepEqual(err, ["Error: Invalid rows: Expected a positive number."]);
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

test("isBlank: empty or whitespace-only", () => {
  for (const v of ["", " ", "\t", " \n "]) assert.equal(isBlank(v), true, JSON.stringify(v));
  for (const v of ["x", " x ", "0"]) assert.equal(isBlank(v), false, JSON.stringify(v));
});

test("textProblem: a string with non-whitespace content, else the reason", () => {
  assert.equal(textProblem("Klima"), undefined);
  assert.equal(textProblem(" a "), undefined);
  assert.equal(textProblem(""), 'expected a non-empty string, got "".');
  assert.equal(textProblem("\t"), 'expected a non-empty string, got "\\t".');
  assert.equal(textProblem(undefined), "expected a non-empty string, got undefined.");
  assert.equal(textProblem(5), "expected a non-empty string, got 5.");
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
