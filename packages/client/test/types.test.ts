// Compile-time checks of the exported library types: a consumer compiled with the strictest
// settings may pass `undefined` for any option, as the runtime treats it as omitted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GovDataClient } from "../src/index.js";
import { makeMockTransport, jsonResponse } from "./helpers.js";

// Runs the TypeScript compiler over a consumer file.
const STARTS_A_PROCESS = { timeout: 30_000 };
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("a consumer with the strictest compiler settings can pass undefined for any option", STARTS_A_PROCESS, async () => {
  // Under exactOptionalPropertyTypes, `{ baseUrl: process.env.X }` fails to compile against an
  // option declared `?: string`, although the runtime treats undefined as omitted.
  const dir = mkdtempSync(join(tmpdir(), "govdata-types-"));
  try {
    writeFileSync(
      join(dir, "use.ts"),
      [
        `import { GovDataClient, type EngineOptions, type ListParams, type PackageSearchParams } from ${JSON.stringify(INDEX)};`,
        "declare function allUndefined<T>(): { [K in keyof T]-?: undefined };",
        "export const options: EngineOptions = allUndefined<EngineOptions>();",
        "export const search: PackageSearchParams = allUndefined<PackageSearchParams>();",
        "export const list: ListParams = allUndefined<ListParams>();",
        "export const client = new GovDataClient({ baseUrl: process.env.GOVDATA_BASE_URL, timeoutMs: 15_000 });",
        "export const count = async (): Promise<number> => (await client.packageSearch({ q: process.env.Q, rows: 0 })).count;",
        "export const names = async (): Promise<string[]> => client.packageList({ limit: undefined, offset: undefined });",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules/@types")],
        },
        files: ["use.ts"],
      }),
    );
    const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr }),
      );
    });
    assert.equal(result.code, 0, result.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const envelope = (result: unknown) => jsonResponse({ help: "", success: true, result });

test("an option given as undefined means its default, as an omitted one does", async () => {
  const mt = makeMockTransport((req) =>
    envelope(req.url.includes("package_search") ? { count: 0, results: [] } : []),
  );
  const client = new GovDataClient({
    baseUrl: undefined,
    userAgent: undefined,
    timeoutMs: undefined,
    maxRetries: undefined,
    retryDelayMs: undefined,
    maxRedirects: undefined,
    maxResponseBytes: undefined,
    sleep: undefined,
    onRetry: undefined,
    transport: mt.transport,
  });
  await client.packageSearch({
    q: undefined,
    fq: undefined,
    rows: undefined,
    start: undefined,
    sort: undefined,
    facet_field: undefined,
  });
  assert.equal(mt.last().url, "https://ckan.govdata.de/api/3/action/package_search");
  assert.equal(mt.last().headers?.["User-Agent"], "govdata-cli");
  assert.equal(mt.last().timeoutMs, 30_000);
  await client.packageList({ limit: undefined, offset: undefined });
  assert.equal(mt.last().url, "https://ckan.govdata.de/api/3/action/package_list");
  await client.organizationList({ limit: undefined, offset: undefined, all_fields: undefined });
  assert.equal(mt.last().url, "https://ckan.govdata.de/api/3/action/organization_list");
  await client.groupList({ limit: undefined, offset: undefined, all_fields: undefined });
  assert.equal(mt.last().url, "https://ckan.govdata.de/api/3/action/group_list");
  await client.tagList(undefined);
  assert.equal(mt.last().url, "https://ckan.govdata.de/api/3/action/tag_list");
});
