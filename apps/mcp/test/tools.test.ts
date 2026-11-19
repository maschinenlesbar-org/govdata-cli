// This server's tools against a mock of GovData's CKAN Action API (the client's live answers of
// 2026-11-20), with the skills' traps as cases: each tool answers through the protocol (its
// structuredContent checked by the SDK against its output schema), the source is the request as
// sent (an organization resolved by name names both requests), licences come from the files, a
// format's spellings are ORed in a filter and folded in a count, links carry their kind, an
// organization that fits several is ambiguous, an unknown dataset is said in words, and every
// result carries the catalogue's licence with the per-file caveat. The rules every server follows
// are the conformance tests (M1–M10).

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatFilter } from "@maschinenlesbar.org/govdata-client";
import { listTools } from "../src/mcp/server.js";
import { connect } from "./harness.js";
import { govdataApi } from "./helpers.js";

const API = "https://ckan.govdata.de/api/3/action";

test("five tools: the three use cases, then one dataset and the organizations", () => {
  assert.deepEqual(listTools().map((t) => t.name), ["findDatasets", "countDatasets", "listFiles", "getDataset", "listOrganizations"]);
});

test("findDatasets: hits with the licences their files carry; the source is the request as sent; the catalogue licence with the per-file caveat", async () => {
  const transport = govdataApi();
  const connection = await connect({ transport });
  const result = await connection.call("findDatasets", { query: "Trinkwasserbrunnen", limit: 3 });
  const content = result.structuredContent ?? {};
  assert.equal(content["status"], "ok", result.content[0]?.text);
  assert.equal(content["total"], 27);
  assert.equal(content["nextOffset"], 3);
  const datasets = content["datasets"] as { name: string; publisher?: string; licences: { label: string }[] }[];
  assert.equal(datasets[0]?.publisher, "Stadt Dortmund");
  assert.deepEqual(datasets[2]?.licences.map((l) => l.label), ["CC BY 4.0"], "the dataset field is empty; the files say CC BY 4.0");
  assert.equal(content["source"], transport.calls[0]?.url);
  assert.match(String(content["licence"]), /^Catalogue metadata: Datenlizenz Deutschland – Zero – Version 2\.0 \(GovData\).*not covered.*DATA_LICENSE\.md$/);
  await connection.close();
});

test("findDatasets: an organization by name resolved (both requests in the source); several fitting are ambiguous, never guessed", async () => {
  const transport = govdataApi();
  const connection = await connect({ transport });
  const content = (await connection.call("findDatasets", { query: "Trinkwasserbrunnen", organization: "Open.NRW", format: "GEOJSON" })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  assert.deepEqual(content["searched"], { query: "Trinkwasserbrunnen", organization: "open-nrw", format: "GEOJSON" });
  const fq = new URL(transport.calls[1]?.url ?? "").searchParams.getAll("fq_list");
  assert.deepEqual(fq, ['organization:"open-nrw"', formatFilter("GEOJSON")]);
  assert.equal(content["source"], `${API}/{${transport.calls.map((c) => c.url.slice(API.length + 1)).join(",")}}`);
  const ambiguous = (await connection.call("findDatasets", { query: "Haushalt", organization: "Brandenburg" })).structuredContent ?? {};
  assert.equal(ambiguous["status"], "ambiguous");
  assert.deepEqual((ambiguous["ambiguous"] as { candidates: { name: string }[] }).candidates.map((c) => c.name), ["open-data-brandenburg", "land-brandenburg"]);
  await connection.close();
});

test("countDatasets: sorted, formats folded into one value with an upper bound, what names no format apart", async () => {
  const connection = await connect({ transport: govdataApi() });
  const content = (await connection.call("countDatasets", { query: "Radverkehr", facets: ["format"], limit: 3 })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  const [formats] = content["facets"] as { values: { value: string; count: number; upperBound?: boolean }[]; complete: boolean; other?: { count: number } }[];
  assert.deepEqual(formats?.values.map((v) => [v.value, v.count]), [["CSV", 84], ["HTML", 72], ["JSON", 53]]);
  assert.equal(formats?.values[0]?.upperBound, true);
  assert.equal(formats?.complete, false);
  assert.ok((formats?.other?.count ?? 0) > 0);
  const bad = await connection.call("countDatasets", { facets: ["publisher"] });
  assert.equal(bad.isError, true, "facets by name only");
  await connection.close();
});

test("listFiles: each link's kind, services left out and counted, links without a URL counted, never listed", async () => {
  const connection = await connect({ transport: govdataApi() });
  const content = (await connection.call("listFiles", { query: "Fahrradzählstellen", limit: 12 })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  const files = (content["datasets"] as { files: { kind: string; url: string }[] }[]).flatMap((d) => d.files);
  assert.ok(files.some((f) => f.kind === "template"));
  assert.ok(files.some((f) => f.kind === "broken"));
  assert.deepEqual((content["skipped"] as { noUrl: number }).noUrl, 2);
  assert.match((content["notes"] as string[]).join(" "), /Not every link is a file/);
  const trink = (await connection.call("listFiles", { query: "Trinkwasserbrunnen" })).structuredContent ?? {};
  assert.ok((trink["skipped"] as { services: number }).services >= 3);
  await connection.close();
});

test("getDataset: by the link to its page, each file with its licence; an unknown name is empty with where to look, not a tool error", async () => {
  const connection = await connect({ transport: govdataApi() });
  const content = (await connection.call("getDataset", { id: "https://www.govdata.de/suche/daten/trinkwasserbrunnen-wuppertal02be6" })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  assert.equal(content["source"], `${API}/package_show?id=trinkwasserbrunnen-wuppertal02be6`);
  const dataset = content["dataset"] as { licences: { label: string }[]; files: { attribution?: string }[] };
  assert.deepEqual(dataset.licences.map((l) => l.label), ["CC BY 4.0", "other open-source licence", "CC0 1.0"]);
  assert.match(dataset.files[0]?.attribution ?? "", /^Datenquelle: CC-BY-4\.0 - Stadt Wuppertal/);
  const unknown = await connection.call("getDataset", { id: "kein-solcher-datensatz-xyz" });
  assert.notEqual(unknown.isError, true);
  assert.equal(unknown.structuredContent?.["status"], "empty");
  assert.match(String(unknown.structuredContent?.["reason"]), /findDatasets/);
  await connection.close();
});

test("listOrganizations: slugs with dataset counts; a city is not one, and the answer says where to look", async () => {
  const connection = await connect({ transport: govdataApi() });
  const content = (await connection.call("listOrganizations", { name: "Statistisches" })).structuredContent ?? {};
  assert.deepEqual(content["organizations"], [{ name: "statistisches-bundesamt", title: "Statistisches Bundesamt", datasets: 3184 }]);
  assert.equal(content["total"], 60);
  const city = (await connection.call("listOrganizations", { name: "Stadt Dortmund" })).structuredContent ?? {};
  assert.equal(city["status"], "empty");
  assert.match(String(city["reason"]), /publisherName/);
  await connection.close();
});
