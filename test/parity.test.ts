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
