// CLI <-> library parity: the same input through run() and through the library
// call the CLI makes, on one recording mock transport, gives the same outcome.

import { test } from "node:test";
import { GovDataClient } from "../src/client/client.js";
import type { QueryParams } from "../src/client/query.js";
import { assertBothReject, assertSameRequests, jsonResponse, parity } from "./helpers.js";

const ok = (result: unknown) => () => jsonResponse({ help: "h", success: true, result });

test("action: a blank parameter value or name is refused by the CLI and the library", async () => {
  const cases: Array<[string, string, QueryParams]> = [
    ["package_search", "q=", { q: "" }],
    ["package_search", "q=  ", { q: "  " }],
    ["package_search", "q=\t", { q: "\t" }],
    ["package_search", "fq= ", { fq: " " }],
    ["tag_list", "query=", { query: "" }],
    ["package_search", "=x", { "": "x" }],
    ["package_search", " =x", { " ": "x" }],
  ];
  for (const [name, param, params] of cases) {
    const result = await parity(
      ["--compact", "action", name, "--param", param],
      (transport) => new GovDataClient({ transport }).action(name, params),
      { responder: ok({ count: 7, results: [] }) },
    );
    assertBothReject(result);
  }
});

test("action: a non-blank parameter is sent the same way by the CLI and the library", async () => {
  const result = await parity(
    ["--compact", "action", "package_search", "--param", "q=Klima"],
    (transport) => new GovDataClient({ transport }).action("package_search", { q: "Klima" }),
    { responder: ok({ count: 1, results: [] }) },
  );
  assertSameRequests(result);
});

test("--user-agent / userAgent: an unsendable value is refused by the CLI and the library", async () => {
  const cases: Array<[string, RegExp]> = [
    ["", /Expected a non-empty value\./],
    ["  ", /Expected a non-empty value\./],
    ["\t", /Expected a non-empty value\./],
    ["a\r\nX-Injected: 1", /Value contains control characters\./],
    ["a\nb", /Value contains control characters\./],
    ["a" + String.fromCharCode(0x7f) + "b", /Value contains control characters\./],
    ["€", /Value contains characters outside Latin-1 \(above U\+00FF\)\./],
    ["agenté☃", /Value contains characters outside Latin-1 \(above U\+00FF\)\./],
  ];
  for (const [userAgent, message] of cases) {
    const result = await parity(
      ["--compact", "--user-agent", userAgent, "packages", "--limit", "1"],
      (transport) => new GovDataClient({ transport, userAgent }).packageList({ limit: 1 }),
      { responder: ok(["ds-1"]) },
    );
    assertBothReject(result, message);
  }
});

test("--user-agent / userAgent: a Latin-1 value with a tab is sent the same way", async () => {
  for (const userAgent of ["café", "Mein Bot\tü/1"]) {
    const result = await parity(
      ["--compact", "--user-agent", userAgent, "packages", "--limit", "1"],
      (transport) => new GovDataClient({ transport, userAgent }).packageList({ limit: 1 }),
      { responder: ok(["ds-1"]) },
    );
    assertSameRequests(result);
  }
});

test("--base-url / baseUrl: whitespace around or in it is refused by the CLI and the library", async () => {
  const cases: Array<[string, RegExp]> = [
    ["https://ckan.govdata.de/ ", /A base URL cannot have surrounding whitespace\./],
    [" https://ckan.govdata.de", /A base URL cannot have surrounding whitespace\./],
    ["\thttp://h.test", /A base URL cannot have surrounding whitespace\./],
    ["https://ckan.govdata.de\n", /A base URL cannot have surrounding whitespace\./],
    ["http://h.test ", /A base URL cannot have surrounding whitespace\./],
    ["https://ckan.gov\tdata.de", /A base URL cannot contain whitespace or control characters\./],
    ["https://ckan.govdata.de/a b", /A base URL cannot contain whitespace or control characters\./],
  ];
  for (const [baseUrl, message] of cases) {
    const result = await parity(
      ["--compact", "--base-url", baseUrl, "packages", "--limit", "1"],
      (transport) => new GovDataClient({ transport, baseUrl }).packageList({ limit: 1 }),
      { responder: ok(["ds-a"]) },
    );
    assertBothReject(result, message);
  }
});

test("--base-url / baseUrl: a clean base URL (trailing slash included) is used the same way", async () => {
  for (const baseUrl of ["https://ckan.govdata.de/", "http://mirror.test/ckan"]) {
    const result = await parity(
      ["--compact", "--base-url", baseUrl, "packages", "--limit", "1"],
      (transport) => new GovDataClient({ transport, baseUrl }).packageList({ limit: 1 }),
      { responder: ok(["ds-a"]) },
    );
    assertSameRequests(result);
  }
});
