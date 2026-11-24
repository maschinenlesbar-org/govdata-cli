// The use cases (operations.ts) against the recorded answers (govdata.ts), with the skills' traps
// as cases: one format under two spellings (the bare name and the EU URI, plus free-text and MIME
// variants), so a filter must OR them and a count must fold them (an upper bound); facet values
// unsorted and cut at CKAN's limit without a sign; the licence on the files, not on the dataset
// (and one dataset mixing licences); the organization is often the harvesting portal, not the
// publisher; links that are templates, landing pages, services, cut off or carry a key; files
// labelled with the wrong format; metadata-only records; one dataset under two portals.

import { test } from "node:test";
import assert from "node:assert/strict";
import { GovDataClient } from "../src/client.js";
import { GovDataApiError, GovDataParseError, GovDataValidationError } from "../src/errors.js";
import {
  countDatasets,
  datasetIdFrom,
  extensionOf,
  findDatasets,
  formatFilter,
  formatOf,
  getDataset,
  licenceOf,
  linkKind,
  listFiles,
  listOrganizations,
  requestsOf,
  themeCode,
} from "../src/operations.js";
import type { HttpRequest } from "../src/http.js";
import { govdataApi } from "./govdata.js";
import { jsonResponse, makeMockTransport, rawResponse } from "./helpers.js";

const clientOf = (mock: ReturnType<typeof govdataApi>) => new GovDataClient({ transport: mock.transport, maxRetries: 0 });
const params = (request: HttpRequest | undefined) => new URL(request?.url ?? "http://x/").searchParams;
const EU = "http://publications.europa.eu/resource/authority/file-type/";

// ---- formats, licences, links ----------------------------------------------------------------

test("a format value becomes one short name: the EU URI's tail, _SRVC dropped, free-text and MIME spellings mapped; no name for what names no format", () => {
  assert.equal(formatOf(`${EU}CSV`), "CSV");
  assert.equal(formatOf("CSV"), "CSV");
  assert.equal(formatOf("gpx"), "GPX");
  assert.equal(formatOf(`${EU}WMS_SRVC`), "WMS");
  assert.equal(formatOf("Shapefiles"), "SHP");
  assert.equal(formatOf("Shape"), "SHP");
  assert.equal(formatOf("Geopackage"), "GPKG");
  assert.equal(formatOf("https://www.iana.org/assignments/media-types/text/csv"), "CSV");
  assert.equal(formatOf("text/csv"), "CSV");
  assert.equal(formatOf("application/vnd.geo+json"), "GEOJSON");
  assert.equal(formatOf("https://data-lra-cha.opendata.arcgis.com/api/feed/dcat-ap/ftype/GEOJSON"), "GEOJSON", "ArcGIS Hub's own format URIs (seen live, 2026-11-20)");
  assert.equal(formatOf("https://w3id.org/mdp/schema/file_media_type#ANY_OTHER_MEDIATYPE"), undefined);
  assert.equal(formatOf("application/x-7z-compressed"), undefined);
  assert.equal(formatOf("Shape, CSV"), undefined);
  assert.equal(formatOf("ESRI Hub"), undefined);
  assert.equal(formatOf("Download"), undefined);
  assert.equal(formatOf(""), undefined);
  assert.equal(formatOf(null), undefined);
});

test("a format filter ORs every spelling: res_format:CSV alone misses most CSV datasets", () => {
  assert.equal(formatFilter("CSV"), `res_format:("CSV" OR "csv" OR "${EU}CSV" OR "text/csv")`);
  assert.match(formatFilter("WMS"), new RegExp(`"${EU}WMS_SRVC"`), "a service's EU URI carries _SRVC");
  assert.match(formatFilter("SHP"), /"Shapefiles"/);
});

test("licences get a short name: 2.0 and 2_0 are one, govdata.de's own URIs and Creative Commons links are known, other-closed is not open", () => {
  assert.deepEqual(licenceOf("http://dcat-ap.de/def/licenses/dl-by-de/2.0"), { uri: "http://dcat-ap.de/def/licenses/dl-by-de/2.0", label: "DL-DE BY 2.0", open: true });
  assert.equal(licenceOf("http://dcat-ap.de/def/licenses/dl-by-de/2_0")?.label, "DL-DE BY 2.0");
  assert.equal(licenceOf("https://www.govdata.de/dl-de/zero-2-0")?.label, "DL-DE Zero 2.0", "Dortmund's licence is not under dcat-ap.de");
  assert.equal(licenceOf("https://creativecommons.org/licenses/by/4.0/legalcode.de")?.label, "CC BY 4.0");
  assert.equal(licenceOf("http://dcat-ap.de/def/licenses/other-closed")?.open, false);
  assert.equal(licenceOf("http://dcat-ap.de/def/licenses/cc-zero")?.label, "CC0 1.0");
  assert.equal(licenceOf("http://dcat-ap.de/def/licenses/official-work")?.label, "Amtliches Werk (§ 5 UrhG)", "seen live, 2026-11-20");
  assert.equal(licenceOf("http://dcat-ap.de/def/licenses/cc-by/4_0")?.label, "CC BY 4.0");
  assert.deepEqual(licenceOf("http://example.org/licences/hausrecht"), { uri: "http://example.org/licences/hausrecht", label: "hausrecht" }, "unknown: the tail, open not claimed");
  assert.equal(licenceOf(""), undefined);
});

test("a link's kind: templates, cut-off links, landing pages, services, generated files; a key in the link is found through a percent-encoded query", () => {
  assert.equal(linkKind("https://mobidata-bw.de/daten/eco-counter/v2/fahrradzaehler_tageswerten_%7byyyymm%7d.json.gz", "JSON"), "template");
  assert.equal(linkKind("https://mobidata-bw.de/daten/eco-counter/v2/fahrradzaehler_tageswerten_yyyy.json.gz", "JSON"), "template");
  assert.equal(linkKind("https://opendata.stadt-muenster.de/dataset/verkehrsz%C3%A4hlung-fahrradverkehr-tagesaktuelle-daten/resource/c072d000-ffb3-4e79-8811", "CSV"), "broken");
  assert.equal(linkKind("https://opendata.stadt-muenster.de/dataset/verkehrsz%C3%A4hlung-fahrradverkehr-daten-der-z%C3%A4hlstellen-m%C3%BCnster-kanalpromenade/resource", "XLSX"), "broken");
  assert.equal(linkKind("https://opendata.stadt-muenster.de/dataset/verkehrsz%C3%A4hlung-fahrradverkehr-daten-der-z%C3%A4hlstellen-m%C3%BCnster-kanalpromenade/resource-0", "XLSX"), "broken");
  assert.equal(linkKind("https://opendata.stadt-muenster.de/dataset/verkehrsz%C3%A4hlung-fahrradverkehr/resource/01c3e796-f4a6-44c0-9d45-1dc68f57a055", "HTML"), "page");
  assert.equal(linkKind("https://mobidata-bw.de/fahrradzaehldaten/", "XLSX"), "page", "a landing page labelled XLSX");
  assert.equal(linkKind("https://geodienste.hamburg.de/wfs_trinkwasserbrunnen?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&typename=de.hh.up:trinkwasserbrunnen", "GML"), "generated");
  assert.equal(linkKind("https://gdi.berlin.de/services/wfs/trinkwasserbrunnen?request=GetCapabilities&service=WFS", "HTML"), "service");
  assert.equal(linkKind("http://www.gis-rest.nrw.de/atomFeed/rest/atom/c0a79c52-f193-4443-b484-cb0fa29cfc9d", "ATOM"), "service");
  assert.equal(linkKind("https://open-data.dortmund.de/api/v2/catalog/datasets/trinkwasserbrunnen/exports/csv?use_labels=true", "CSV"), "generated");
  assert.equal(linkKind("https://www.augsburg.de/fileadmin/user_upload/buergerservice_rathaus/Smart_City/opendata/Trinkwasserbrunnen.geojson", "GEOJSON"), "file");
  const keyed = "https://api.datenplattform.heidelberg.de/ckan/or/mobility/main/eco-counter/v2/entities%3flimit%3d50%26api-key%3d360d5d1b-42d9-4562-9261-a70c1c027f79";
  assert.equal(linkKind(keyed, "JSON"), "api");
  assert.equal(extensionOf("https://opendata.stadt-muenster.de/sites/default/files/Zaehlstelle_Kanalpromenade_Stundenauswertung_2022.xlsx"), "XLSX");
  assert.equal(extensionOf("https://x.de/a/fahrradzaehler.csv.gz"), "CSV");
});

test("themes by code or German title; dataset ids from a link to their page", () => {
  assert.equal(themeCode("Verkehr"), "tran");
  assert.equal(themeCode("TRAN"), "tran");
  assert.equal(themeCode("bevölkerung und gesellschaft"), "soci");
  assert.equal(themeCode("Mobilität"), undefined);
  assert.equal(datasetIdFrom("https://www.govdata.de/suche/daten/trinkwasserbrunnen-wuppertal02be6"), "trinkwasserbrunnen-wuppertal02be6");
  assert.equal(datasetIdFrom("https://ckan.govdata.de/dataset/haushalt-2020/"), "haushalt-2020");
  assert.equal(datasetIdFrom(" haushalt-2020 "), "haushalt-2020");
});

// ---- findDatasets ----------------------------------------------------------------------------

test("findDatasets: the total, the licences the files carry (not the empty dataset field), the publisher behind the portal, repeated titles noted", async () => {
  const mock = govdataApi();
  const answer = await findDatasets(clientOf(mock), { query: "Trinkwasserbrunnen", limit: 6 });
  assert.equal(answer.status, "ok");
  assert.equal(answer.total, 27, "count all matches with total, never by paging");
  assert.equal(answer.nextOffset, 6);
  const [dortmund, berlin, wuppertal] = answer.datasets;
  assert.deepEqual(dortmund?.licences.map((l) => l.label), ["DL-DE Zero 2.0"]);
  assert.equal(dortmund?.organization?.title, "Open.NRW", "the organization is the portal that harvested it");
  assert.equal(dortmund?.publisher, "Stadt Dortmund", "the publisher is in the metadata");
  assert.equal(dortmund?.files, 15);
  assert.ok(dortmund?.formats.includes("CSV") && dortmund.formats.includes("GEOJSON"), "formats folded from the EU URIs");
  assert.deepEqual(berlin?.licences.map((l) => l.label), ["DL-DE Zero 2.0"]);
  assert.deepEqual(wuppertal?.licences.map((l) => l.label), ["CC BY 4.0"], "license_id is empty; the files carry CC BY 4.0");
  const mixed = answer.datasets.find((d) => d.name === "trinkwasserbrunnen-wuppertal02be6");
  assert.deepEqual(mixed?.licences.map((l) => l.label), ["CC BY 4.0", "other open-source licence", "CC0 1.0"], "one dataset, three licences: each shown");
  assert.ok(answer.notes.some((n) => n.includes('"Trinkwasserbrunnen Wuppertal"') && n.includes("harvested by two portals")));
  assert.deepEqual(requestsOf(answer), ["package_search?q=Trinkwasserbrunnen&rows=6&start=0"]);
});

test("findDatasets with a format: the filter ORs its spellings, and each hit says whether it has the format", async () => {
  const mock = govdataApi();
  const answer = await findDatasets(clientOf(mock), { query: "Trinkwasserbrunnen", format: "geojson", withFiles: true });
  const fq = params(mock.last()).getAll("fq_list");
  assert.ok(fq.includes(formatFilter("GEOJSON")), "the bare name, the lower case and the EU URI");
  assert.ok(fq.includes("num_resources:[1 TO *]"));
  assert.deepEqual(answer.searched, { query: "Trinkwasserbrunnen", format: "GEOJSON", withFiles: true });
  assert.ok(answer.datasets.length > 0);
  assert.ok(answer.datasets.every((d) => d.hasFormat === true));
});

test("findDatasets: an organization by name is resolved to its slug; several fitting are ambiguous (no search sent); none is empty with where to look", async () => {
  const mock = govdataApi();
  const exact = await findDatasets(clientOf(mock), { query: "Trinkwasserbrunnen", organization: "open.nrw" });
  assert.equal(exact.searched["organization"], "open-nrw");
  assert.deepEqual(params(mock.last()).getAll("fq_list"), ['organization:"open-nrw"', 'organization:"open-nrw"']);
  assert.ok(exact.datasets.every((d) => d.organization?.name === "open-nrw"));
  assert.equal(requestsOf(exact).length, 2, "the organizations, then the search");

  const before = mock.calls.length;
  const ambiguous = await findDatasets(clientOf(mock), { query: "Haushalt", organization: "Brandenburg" });
  assert.equal(ambiguous.status, "ambiguous");
  assert.deepEqual(ambiguous.ambiguous?.candidates.map((c) => c.name), ["open-data-brandenburg", "land-brandenburg"]);
  assert.equal(mock.calls.length, before + 1, "only the organizations were read: never guessed");

  const none = await findDatasets(clientOf(mock), { organization: "Stadtwerke Nirgendwo" });
  assert.equal(none.status, "empty");
  assert.match(none.reason ?? "", /listOrganizations.*publisherName/);
});

test("findDatasets: a theme by its German title, a publisher as a phrase; a refused value sends nothing", async () => {
  const mock = govdataApi();
  await findDatasets(clientOf(mock), { query: "Trinkwasserbrunnen", theme: "Gesundheit", publisherName: 'Stadt "Dortmund"' });
  const fq = params(mock.last()).getAll("fq_list");
  assert.ok(fq.includes("groups:heal"));
  assert.ok(fq.includes('extras_publisher_name:"Stadt \\"Dortmund\\""'), "quotes in the phrase escaped");
  const sent = mock.calls.length;
  await assert.rejects(findDatasets(clientOf(mock), { theme: "Mobilität" }), GovDataValidationError);
  await assert.rejects(findDatasets(clientOf(mock), { format: "Shape, CSV" }), GovDataValidationError);
  await assert.rejects(findDatasets(clientOf(mock), { limit: 51 }), GovDataValidationError);
  await assert.rejects(findDatasets(clientOf(mock), { query: "  " }), GovDataValidationError);
  assert.equal(mock.calls.length, sent);
});

test("findDatasets: nothing matching is empty with what to try, not an error; a page past the end says how many match", async () => {
  const none = await findDatasets(clientOf(govdataApi()), { query: "Zeitmaschinenwartung" });
  assert.equal(none.status, "empty");
  assert.match(none.reason ?? "", /broader words/);
  const past = await findDatasets(clientOf(govdataApi()), { query: "Fahrradzählstellen", offset: 12 });
  assert.equal(past.status, "empty");
  assert.match(past.reason ?? "", /past the end: 16 datasets match/);
});

test("findDatasets: metadata-only records are noted, sorted by when the record changed on request", async () => {
  const mock = govdataApi();
  const answer = await findDatasets(clientOf(mock), { query: "Fahrradzählstellen", sort: "modified", limit: 12 });
  assert.equal(params(mock.last()).get("sort"), "metadata_modified desc");
  assert.equal(answer.searched["sort"], "modified");
  assert.ok(answer.datasets.every((d) => d.files > 0));
  assert.ok(!answer.notes.some((n) => n.includes("metadata only")));
});

// ---- countDatasets ---------------------------------------------------------------------------

test("countDatasets: sorted by count (CKAN sends them unsorted), titles as labels, complete false when CKAN's list was cut", async () => {
  const mock = govdataApi();
  const answer = await countDatasets(clientOf(mock), { query: "Verkehr", facets: ["organization", "theme"], limit: 5 });
  assert.equal(answer.total, 14338);
  const organizations = answer.facets[0];
  assert.equal(organizations?.facet, "organization");
  assert.deepEqual(organizations?.values.map((v) => v.count), [5883, 3500, 1251, 1000, 672]);
  assert.equal(organizations?.values[1]?.label, "open.bydata");
  assert.equal(organizations?.complete, false);
  assert.equal(params(mock.last()).get("facet.limit"), "6", "limit + 1, to tell a cut list from a complete one");
  assert.equal(answer.facets[1]?.values[0]?.label, "Regierung und öffentlicher Sektor");
  assert.equal(requestsOf(answer).length, 1);
});

test("countDatasets: a format's spellings folded into one value (an upper bound), every value read first; what names no format kept apart", async () => {
  const mock = govdataApi();
  const answer = await countDatasets(clientOf(mock), { query: "Radverkehr", facets: ["format"], limit: 5 });
  assert.equal(params(mock.last()).get("facet.limit"), "-1", "a cut list could lose one spelling");
  const formats = answer.facets[0];
  assert.deepEqual(formats?.values[0], { value: "CSV", count: 84, variants: [`${EU}CSV`, "CSV"], upperBound: true });
  const shp = (await countDatasets(clientOf(mock), { query: "Radverkehr", facets: ["format"], limit: 100 })).facets[0]?.values.find((v) => v.value === "SHP");
  assert.equal(shp?.count, 21, "the EU URI, SHP, Shape and Shapefiles");
  assert.equal(formats?.complete, false);
  assert.ok(formats?.other !== undefined && formats.other.variants.includes("Shape, CSV") && formats.other.variants.includes("application/x-7z-compressed"));
  assert.ok(answer.notes.some((n) => n.includes("upperBound")));
});

test("countDatasets: licence variants (2.0, 2_0, the older DCAT-AP.de version) are one; the note says the dataset-level licence is sparse", async () => {
  const answer = await countDatasets(clientOf(govdataApi()), { query: "Verkehr", facets: ["licence", "organization"] });
  const licences = answer.facets.find((f) => f.facet === "licence");
  assert.deepEqual(licences?.values[0], {
    value: "DL-DE BY 2.0",
    count: 6,
    variants: ["http://dcat-ap.de/def/licenses/dl-by-de/2.0", "http://dcat-ap.de/def/licenses/dl-by-de/2_0"],
    upperBound: true,
  });
  assert.ok(answer.notes.some((n) => n.includes("only 13 of 14338")));
  assert.equal(requestsOf(answer).length, 2, "every licence value, then the organizations at limit + 1");
});

test("countDatasets: no facets is the total alone; nothing matching is empty", async () => {
  const mock = govdataApi();
  const total = await countDatasets(clientOf(mock), { publisherName: "Stadt Dortmund" });
  assert.equal(total.total, 792);
  assert.deepEqual(total.facets, []);
  assert.equal(params(mock.last()).get("rows"), "0", "no datasets fetched");
  const none = await countDatasets(clientOf(mock), { query: "Zeitmaschinenwartung", facets: ["format"] });
  assert.equal(none.status, "empty");
});

// ---- listFiles -------------------------------------------------------------------------------

test("listFiles: each link with its kind; templates, landing pages and cut-off links named, links without a URL counted, never listed", async () => {
  const answer = await listFiles(clientOf(govdataApi()), { query: "Fahrradzählstellen", limit: 12 });
  const all = answer.datasets.flatMap((d) => d.files);
  const mobidata = answer.datasets.find((d) => d.name.startsWith("gebundelte"));
  assert.deepEqual(mobidata?.files.filter((f) => f.kind === "template").map((f) => f.url.split("/").pop()), [
    "fahrradzaehler_tageswerten_%7byyyymm%7d.json.gz",
    "fahrradzaehler_tageswerten_yyyy.json.gz",
    "fahrradzaehler_tageswerten_%7byyyymm%7d.csv.gz",
  ]);
  assert.equal(answer.skipped.noUrl, 2, "MobiData's two files without a link");
  const kanalpromenade = answer.datasets.find((d) => d.name.endsWith("kanalpromenade"))?.files ?? [];
  assert.deepEqual(kanalpromenade.slice(0, 2).map((f) => f.kind), ["broken", "broken"], "resource links cut off before the id");
  assert.ok(all.some((f) => f.kind === "page" && f.url.endsWith("/resource/01c3e796-f4a6-44c0-9d45-1dc68f57a055")), "a CKAN resource page, not the file");
  const heidelberg = answer.datasets.find((d) => d.name === "fahrradzahlstellen-in-heidelberg");
  assert.ok(heidelberg?.files.some((f) => f.keyInLink === true));
  const xls = all.find((f) => f.url.endsWith("Stundenauswertung_2022.xlsx"));
  assert.deepEqual([xls?.format, xls?.extension, xls?.kind], ["XLS", "XLSX", "file"], "a file labelled with the wrong format");
  assert.equal(answer.counts.files, all.length);
  assert.equal(answer.counts.fetchable, all.filter((f) => f.kind === "file" || f.kind === "generated").length);
  assert.ok(answer.notes.some((n) => /template.*broken|broken.*template/.test(n) || (n.includes("template") && n.includes("broken"))));
  assert.ok(answer.notes.some((n) => n.includes("keyInLink")));
});

test("listFiles: services left out unless asked for, the same link listed once, each file with its own licence and plain-text attribution", async () => {
  const answer = await listFiles(clientOf(govdataApi()), { query: "Trinkwasserbrunnen" });
  assert.equal(answer.datasetsScanned, 6);
  assert.ok(answer.skipped.services >= 3, "Berlin's GetCapabilities, Wuppertal's ATOM feed and WFS");
  assert.ok(answer.skipped.duplicates >= 1, "Wuppertal's GeoJSON under two portals");
  assert.equal(answer.skipped.datasetsWithoutFiles, 1, "Berlin has only a service");
  const wuppertal = answer.datasets.find((d) => d.name === "trinkwasserbrunnen-wuppertal02be6");
  assert.deepEqual([...new Set(wuppertal?.files.map((f) => f.licence?.label))], ["other open-source licence", "CC0 1.0"], "its CC BY files were listed under the other portal's copy");
  const withServices = await listFiles(clientOf(govdataApi()), { query: "Trinkwasserbrunnen", includeServices: true });
  assert.equal(withServices.skipped.services, 0);
  assert.ok(withServices.datasets.flatMap((d) => d.files).some((f) => f.kind === "service"));
});

test("listFiles with a format: datasets found by both spellings, files kept by format or by file extension", async () => {
  const mock = govdataApi();
  const answer = await listFiles(clientOf(mock), { query: "Fahrradzählstellen", format: "XLSX" });
  assert.ok(params(mock.last()).getAll("fq_list").includes(formatFilter("XLSX")));
  const files = answer.datasets.flatMap((d) => d.files);
  assert.ok(files.length > 0);
  assert.ok(files.every((f) => f.format === "XLSX" || extensionOf(f.url) === "XLSX"));
  assert.ok(files.some((f) => f.format === "XLS"), "the .xlsx files labelled XLS are kept");
  assert.ok(answer.skipped.otherFormat > 0);
});

// ---- getDataset, listOrganizations ------------------------------------------------------------

test("getDataset: by a link to its page; publisher and contact from the metadata, every file with its licence; an unknown name is empty, not an error", async () => {
  const mock = govdataApi();
  const answer = await getDataset(clientOf(mock), { id: "https://www.govdata.de/suche/daten/trinkwasserbrunnen-wuppertal02be6" });
  assert.equal(answer.status, "ok");
  const dataset = answer.dataset;
  assert.equal(dataset?.name, "trinkwasserbrunnen-wuppertal02be6");
  assert.equal(dataset?.publisher?.name, "Stadt Wuppertal, Ressort 102 Vermessung, Katasteramt und Geodaten");
  assert.deepEqual(dataset?.licences.map((l) => l.label), ["CC BY 4.0", "other open-source licence", "CC0 1.0"]);
  assert.equal(dataset?.licence, undefined, "the dataset-level licence is empty");
  assert.doesNotMatch(dataset?.description ?? "", /<\/?p>/, "the description as plain text");
  assert.ok(dataset?.files.every((f) => typeof f.id === "string"));
  assert.equal(dataset?.files[0]?.attribution, "Datenquelle: CC-BY-4.0 - Stadt Wuppertal - offenedaten-wuppertal.de", "the attribution text the publisher asks for, as plain text");
  assert.ok(answer.notes.some((n) => n.includes("different licences")));
  assert.deepEqual(requestsOf(answer), ["package_show?id=trinkwasserbrunnen-wuppertal02be6"]);

  const missing = await getDataset(clientOf(mock), { id: "kein-solcher-datensatz-xyz" });
  assert.equal(missing.status, "empty");
  assert.match(missing.reason ?? "", /findDatasets/);
  assert.equal(missing.dataset, undefined);
});

test("listOrganizations: all 60 with dataset counts, most first; by name, those containing it; none is empty with where to look", async () => {
  const all = await listOrganizations(clientOf(govdataApi()));
  assert.equal(all.total, 60);
  assert.deepEqual(all.organizations[0], { name: "gdi-de", title: "GDI-DE", datasets: 31753 });
  const bund = await listOrganizations(clientOf(govdataApi()), { name: "bundesministerium" });
  assert.ok(bund.organizations.length > 5);
  assert.ok(bund.organizations.every((o) => o.title.toLowerCase().includes("bundesministerium")));
  const umlaut = await listOrganizations(clientOf(govdataApi()), { name: "Württemberg" });
  assert.deepEqual(umlaut.organizations.map((o) => o.name), ["open-data-baden-wurttemberg"], "ü matches the slug's u");
  const none = await listOrganizations(clientOf(govdataApi()), { name: "Stadt Dortmund" });
  assert.equal(none.status, "empty");
  assert.match(none.reason ?? "", /publisherName/);
});

// ---- publisher text --------------------------------------------------------------------------

/** A client whose package_show answers `dataset` (as GovData's envelope). */
const showing = (dataset: Record<string, unknown>) =>
  new GovDataClient({ transport: makeMockTransport(() => jsonResponse({ help: "", success: true, result: dataset })).transport, maxRetries: 0 });

test("getDataset: a description full of \"<\" without \">\" is read in linear time, its tags stripped by the same rules", async () => {
  const ok = await getDataset(showing({ name: "d", notes: "<p>Daten</p> für x < y", resources: [{ url: "https://x.example/a.csv", licenseAttributionByText: "<b>Quelle:</b> Stadt" }] }), { id: "d" });
  assert.equal(ok.dataset?.description, "Daten für x < y", "a \"<\" with no \">\" after it is text");
  assert.equal(ok.dataset?.files[0]?.attribution, "Quelle: Stadt");
  const hostile = "<a".repeat(100_000);
  const started = performance.now();
  const answer = await getDataset(showing({ name: "d", notes: hostile, resources: [{ url: `https://x.example/${"{".repeat(100_000)}.csv`, licenseAttributionByText: hostile }] }), { id: "d" });
  const took = performance.now() - started;
  assert.ok(took < 1000, `took ${Math.round(took)} ms: the tag strip rescans the text at every "<"`);
  assert.equal(answer.dataset?.description?.slice(0, 4), "<a<a");
  assert.equal(answer.dataset?.files[0]?.kind, "file", "a \"{\" with no \"}\" after it is no placeholder");
});

test("getDataset: markup the publisher escaped stays out of the plain text, other entities are decoded, a comparison is no tag", async () => {
  const answer = await getDataset(
    showing({
      name: "d",
      notes: "<p>Beschreibung &lt;img src=x onerror=alert(1)&gt; M&auml;rz &#252;ber &#x2013; a &lt; b, x < y > z, &amp;lt;i&amp;gt;</p>",
      resources: [{ url: "https://x.example/a.csv", licenseAttributionByText: "<b>Quelle:</b> &lt;a href=javascript:x&gt;Stadt&lt;/a&gt; &copy; 2026" }],
    }),
    { id: "d" },
  );
  assert.equal(answer.dataset?.description, "Beschreibung März über – a < b, x < y > z, &lt;i&gt;");
  assert.equal(answer.dataset?.files[0]?.attribution, "Quelle: Stadt © 2026");
});

// ---- licences --------------------------------------------------------------------------------

/** A client whose package_search answers `count` and these facets, whatever is asked. */
const facetsClient = (count: number, searchFacets: Record<string, unknown>) =>
  new GovDataClient({ transport: makeMockTransport(() => jsonResponse({ help: "", success: true, result: { count, results: [], search_facets: searchFacets } })).transport, maxRetries: 0 });

const items = (pairs: [string, number][]) => ({ items: pairs.map(([name, count]) => ({ name, display_name: name, count })) });

test("every Creative Commons licence of the DCAT-AP.de vocabulary is named, its non-commercial and no-derivatives kinds not open; an unknown licence's version keeps its name", () => {
  const dcat = "http://dcat-ap.de/def/licenses/";
  assert.deepEqual(licenceOf(`${dcat}cc-by-nc-de/3.0`), { uri: `${dcat}cc-by-nc-de/3.0`, label: "CC BY-NC 3.0 DE", open: false }, "seen live, 2026-11-22");
  assert.deepEqual([licenceOf(`${dcat}cc-by-nd-de/3_0`)?.label, licenceOf(`${dcat}cc-by-nd-de/3_0`)?.open], ["CC BY-ND 3.0 DE", false]);
  assert.deepEqual([licenceOf(`${dcat}cc-by-nc-nd/4.0`)?.label, licenceOf(`${dcat}cc-by-nc-nd/4.0`)?.open], ["CC BY-NC-ND 4.0", false]);
  assert.deepEqual([licenceOf(`${dcat}cc-by-nc-sa/4.0`)?.label, licenceOf(`${dcat}cc-by-nc-sa/4.0`)?.open], ["CC BY-NC-SA 4.0", false]);
  assert.deepEqual([licenceOf(`${dcat}cc-by-nd`)?.label, licenceOf(`${dcat}cc-by-nd`)?.open], ["CC BY-ND", false]);
  assert.deepEqual([licenceOf(`${dcat}cc-by-sa-de/3.0`)?.label, licenceOf(`${dcat}cc-by-sa-de/3.0`)?.open], ["CC BY-SA 3.0 DE", true]);
  assert.deepEqual(licenceOf(`${dcat}gpl/3.0`), { uri: `${dcat}gpl/3.0`, label: "gpl 3.0" }, "not a bare version number");
  assert.deepEqual(licenceOf("http://example.org/licences/hausrecht/1_0"), { uri: "http://example.org/licences/hausrecht/1_0", label: "hausrecht 1_0" });
});

test("countDatasets: two different licences are never folded into one value", async () => {
  const dcat = "http://dcat-ap.de/def/licenses/";
  const answer = await countDatasets(facetsClient(5000, { license_id: items([[`${dcat}cc-by-nc-nd/4.0`, 300], [`${dcat}cc-by-nc-sa/4.0`, 200]]) }), { facets: ["licence"] });
  assert.deepEqual(answer.facets[0]?.values.map((v) => [v.value, v.count, v.upperBound]), [["CC BY-NC-ND 4.0", 300, undefined], ["CC BY-NC-SA 4.0", 200, undefined]]);
});

test("countDatasets: the licence note counts every dataset with a licence, not only the values listed", async () => {
  const dcat = "http://dcat-ap.de/def/licenses/";
  const answer = await countDatasets(
    facetsClient(5000, { license_id: items([[`${dcat}dl-by-de/2.0`, 900], [`${dcat}dl-by-de/2_0`, 800], [`${dcat}cc-zero`, 300], [`${dcat}other-closed`, 200]]) }),
    { facets: ["licence"], limit: 1 },
  );
  assert.equal(answer.facets[0]?.values.length, 1);
  assert.ok(answer.notes.some((n) => n.includes("only 2200 of 5000 datasets carry")), answer.notes.join(" | "));
});

test("countDatasets: a value folded from many spellings lists ten of them and counts the rest", async () => {
  const hubs = Array.from({ length: 1500 }, (_, i): [string, number] => [`https://hub-${i}.opendata.arcgis.com/api/feed/dcat-ap/ftype/CSV`, 3]);
  const answer = await countDatasets(facetsClient(5000, { res_format: items([...hubs, ["application/x-foo", 7]]) }), { facets: ["format"], limit: 5 });
  const csv = answer.facets[0]?.values[0];
  assert.deepEqual([csv?.value, csv?.count, csv?.upperBound, csv?.variants?.length, csv?.moreVariants], ["CSV", 4500, true, 10, 1490]);
  assert.ok(JSON.stringify(answer).length < 5000);
});

// ---- upstream failures -----------------------------------------------------------------------

test("getDataset: only CKAN's own \"Not Found Error\" means no such dataset; another 404 (a proxy's page, a wrong base path) is an error", async () => {
  const html = new GovDataClient({ transport: makeMockTransport(() => rawResponse("<html>Seite nicht gefunden</html>", "text/html", 404)).transport, maxRetries: 0 });
  await assert.rejects(getDataset(html, { id: "luftqualitat" }), (err: unknown) => err instanceof GovDataApiError && err.status === 404);
  const foreign = new GovDataClient({ transport: makeMockTransport(() => jsonResponse({ detail: "Not Found" }, 404)).transport, maxRetries: 0 });
  await assert.rejects(getDataset(foreign, { id: "luftqualitat" }), GovDataApiError);
  const ckan = await getDataset(clientOf(govdataApi()), { id: "luftqualitat" });
  assert.equal(ckan.status, "empty", "CKAN's envelope with HTTP 404");
});

test("a facet missing from the answer, or not in CKAN's shape, is a shape error naming the request, never \"no such organization\" or no values", async () => {
  const missing = facetsClient(10, {});
  await assert.rejects(findDatasets(missing, { query: "x", organization: "open-nrw" }), (err: unknown) => err instanceof GovDataParseError && /^package_search\?.*facet\.field.*search_facets\.organization/.test(err.message));
  const textCount = facetsClient(10, { organization: { items: [{ name: "open-nrw", display_name: "Open.NRW", count: "5" }] } });
  await assert.rejects(findDatasets(textCount, { query: "x", organization: "open-nrw" }), GovDataParseError);
  const objectItems = facetsClient(10, { res_format: { items: { CSV: 5 } } });
  await assert.rejects(countDatasets(objectItems, { facets: ["format"] }), GovDataParseError);
  const zero = await countDatasets(facetsClient(10, { tags: { items: [{ name: "a", count: 0 }, { name: "b", count: 2 }] } }), { facets: ["tag"] });
  assert.deepEqual(zero.facets[0]?.values.map((v) => v.value), ["b"], "a value with no datasets is left out, as before");
});

// ---- paging ----------------------------------------------------------------------------------

/** A client whose package_search matches `count` datasets, each with one CSV file, paged by start and rows. */
const pagedClient = (count: number) => {
  const mock = makeMockTransport((request) => {
    const url = new URL(request.url);
    const start = Number(url.searchParams.get("start") ?? "0");
    const rows = Number(url.searchParams.get("rows") ?? "10");
    const results = Array.from({ length: Math.max(0, Math.min(rows, count - start)) }, (_, i) => ({ name: `d${start + i}`, num_resources: 1, resources: [{ format: "CSV", url: `https://x.example/${start + i}.csv` }] }));
    return jsonResponse({ help: "", success: true, result: { count, results, search_facets: {} } });
  });
  return { mock, client: new GovDataClient({ transport: mock.transport, maxRetries: 0 }) };
};

test("findDatasets and listFiles never give a nextOffset past MAX_OFFSET: the last page stops there and says so", async () => {
  for (const operation of [findDatasets, listFiles] as const) {
    const { mock, client } = pagedClient(200_000);
    const answer = await operation(client, { query: "x", offset: 99_990, limit: 50 });
    assert.equal(params(mock.last()).get("rows"), "11", "the results up to offset 100000, so no cut of the page can point past it either");
    assert.equal(answer.nextOffset, undefined);
    assert.ok(answer.notes.some((n) => n.includes("100000") && /narrow/i.test(n)), answer.notes.join(" | "));
    const before = await operation(client, { query: "x", offset: 99_900, limit: 50 });
    assert.equal(before.nextOffset, 99_950);
  }
});

test("a link that is not an absolute http(s) URL is kind invalid, never fetchable: another scheme, a relative path, a line break or control inside", async () => {
  for (const url of ["javascript:alert(document.cookie)", "data:text/html;base64,PHNjcmlwdD4=", "file:///etc/passwd", "ftp://ftp.example.org/data.csv", "/relative/path/file.csv", "https://x.example/data.csv\n.exe", "https://x.example/a\u0007.csv", "HTTPS:/x.example/a.csv"]) {
    assert.equal(linkKind(url, "CSV"), "invalid", url);
  }
  assert.equal(linkKind("HTTPS://x.example/a.csv", "CSV"), "file");
  assert.equal(linkKind("https://x.example/Daten 2020.csv", "CSV"), "file", "a space is left to the fetcher");
  const answer = await getDataset(showing({ name: "d", resources: [{ url: "javascript:alert(1)", format: "HTML" }, { url: "ftp://ftp.example.org/data.csv", format: "CSV" }] }), { id: "d" });
  assert.deepEqual(answer.dataset?.files.map((f) => f.kind), ["invalid", "invalid"]);
  const files = await listFiles(new GovDataClient({ transport: makeMockTransport(() => jsonResponse({ help: "", success: true, result: { count: 1, results: [{ name: "d", resources: [{ url: "/relative/file.csv", format: "CSV" }, { url: "https://x.example/a.csv", format: "CSV" }] }], search_facets: {} } })).transport, maxRetries: 0 }), { query: "x" });
  assert.deepEqual([files.counts.files, files.counts.fetchable], [2, 1]);
  assert.ok(files.notes.some((n) => n.includes("1 invalid")), files.notes.join(" | "));
});

test("\"online\" in the format field names no format: counted in other, refused as a format filter", async () => {
  for (const value of ["ONLINE", "onLine", "online"]) assert.equal(formatOf(value), undefined, value);
  await assert.rejects(findDatasets(clientOf(govdataApi()), { format: "ONLINE" }), GovDataValidationError);
});

test("a blank raw filter is refused under the name the caller gave, filters, before any request", async () => {
  const mock = govdataApi();
  await assert.rejects(findDatasets(clientOf(mock), { query: "x", filters: ["tags:radverkehr", " "] }), /^GovDataValidationError: Invalid filters: /);
  assert.equal(mock.calls.length, 0);
});

test("a dataset's id from GovData's older page link too (…/suche/-/details/NAME, still in many documents)", () => {
  assert.equal(datasetIdFrom("https://www.govdata.de/web/guest/suche/-/details/luftqualitat-und-larmbelastung"), "luftqualitat-und-larmbelastung");
  assert.equal(datasetIdFrom("https://www.govdata.de/web/guest/suche/-/details/haushalt-2020?x=1#top"), "haushalt-2020");
});
