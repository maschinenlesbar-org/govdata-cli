// Test helpers of this server's own tests and the adapters of the conformance tests: a mock
// upstream on the CKAN Action API of GovData (the client's govdata.ts: live answers recorded on
// 2026-11-20), a mock search over given datasets, and the client's transport helpers. The generic
// harness (a connection, a config, a log recorder, the HTTP server) is harness.ts.

import { jsonResponse, makeMockTransport, type MockTransport } from "@maschinenlesbar.org/govdata-client/test/helpers";

export * from "@maschinenlesbar.org/govdata-client/test/helpers";
export * from "@maschinenlesbar.org/govdata-client/test/govdata";

/** A mock package_search over `datasets`: every query matches them all, paged by start and rows as CKAN does. */
export function searchWith(datasets: Record<string, unknown>[]): MockTransport {
  return makeMockTransport((request) => {
    const url = new URL(request.url);
    const start = Number(url.searchParams.get("start") ?? "0");
    const rows = Number(url.searchParams.get("rows") ?? "10");
    return jsonResponse({ help: "", success: true, result: { count: datasets.length, results: datasets.slice(start, start + rows), search_facets: {} } });
  });
}
