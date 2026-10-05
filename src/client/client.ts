// GovDataClient — a typed client over the open (no-auth) read endpoints of the
// GovData CKAN Action API (https://ckan.govdata.de/api/3/action), the central
// German open-data catalogue.
//
//   client.packageSearch({ q: "Haushalt", rows: 5 })
//   client.packageShow("some-dataset-id")
//   client.action("organization_list")   // generic escape hatch

import { RequestEngine, sanitizeServerText, type EngineOptions } from "./engine.js";
import type { QueryParams } from "./query.js";
import { GovDataError, GovDataParseError, GovDataValidationError, cutForMessage } from "./errors.js";
import { assertValid, textProblem } from "./validate.js";
import type {
  CkanEnvelope,
  PackageSearchResult,
  Package,
  Organization,
  Group,
  Resource,
  PackageSearchParams,
  ListParams,
  JsonValue,
} from "./types.js";

const ACTION = "/api/3/action";

/**
 * CKAN action names are always `[a-z0-9_]+`. Restricting to that allowlist closes
 * the path-traversal hole (`../../..` escaping `/api/3/action/`) and the
 * query/fragment-injection hole (a `?`/`#` in the name corrupting the query) for
 * both the library and the CLI generic-action escape hatch.
 */
const ACTION_NAME = /^[a-z0-9_]+$/;

/**
 * Drop undefined values so only the parameters the caller actually set are sent.
 * The typed methods reject a blank filter before they get here (assertText), and
 * `action()` refuses any blank parameter, so nothing is silently dropped.
 */
function prune(params: Record<string, unknown>): QueryParams {
  // A null-prototype object, so a `__proto__` key is kept as a parameter instead
  // of setting the prototype (and being lost).
  const out = Object.create(null) as QueryParams;
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    out[k] = v as QueryParams[string];
  }
  return out;
}

function invalid(name: string, expected: string, value: unknown): GovDataValidationError {
  const shown = typeof value === "string" ? JSON.stringify(value) : String(value);
  return new GovDataValidationError(`Invalid ${name}: expected ${expected}, got ${shown}.`);
}

/**
 * Throw GovDataValidationError unless `value` is a string with non-whitespace
 * content (textProblem). CKAN reads a blank filter as no filter, so a blank `q`,
 * `fq` or tag query would silently widen the result, and a blank id is not an id.
 */
function assertText(name: string, value: unknown): void {
  assertValid(name, value, textProblem);
}

/** How a value is shown in a message: strings quoted, other values by type or value. */
function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "an array";
  if (value === null) return "null";
  return typeof value === "object" ? "an object" : String(value);
}

/** GovDataValidationError `Invalid <name>: expected <expected>, got <value described>.` */
function wrongType(name: string, expected: string, value: unknown): GovDataValidationError {
  return new GovDataValidationError(`Invalid ${name}: expected ${expected}, got ${describe(value)}.`);
}

/** One scalar `action()` parameter value the query builder sends as written. */
function isScalarParam(value: unknown): boolean {
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * Check the parameters of a generic `action()` call: a non-object, a blank parameter
 * name, a blank string value or a blank string in a list value throws
 * GovDataValidationError. CKAN reads an empty parameter as unset, so `{ q: "" }`
 * would run the action unfiltered. So does a value the query builder can't send as
 * written: an object went out as `[object Object]`, NaN and Infinity as words, a
 * nested array flattened. `undefined`/`null` still mean "not given"; strings, finite
 * numbers, booleans and valid Dates pass, alone or in a list.
 */
function assertParams(params: unknown): asserts params is QueryParams {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw wrongType("action parameters", "an object", params);
  }
  for (const [k, v] of Object.entries(params)) {
    assertText("parameter name", k);
    if (v === undefined || v === null) continue;
    const values: unknown[] = Array.isArray(v) ? v : [v];
    for (const item of values) {
      if (item === undefined || item === null) continue;
      if (!isScalarParam(item)) {
        throw wrongType(`parameter ${k}`, "a string, finite number, boolean or Date, or a list of them", item);
      }
      if (typeof item === "string") assertText(`parameter ${k}`, item);
    }
  }
}

/**
 * Throw GovDataValidationError unless `params` is an object whose own keys are all in
 * `known`. CKAN ignores a parameter it doesn't know, so a misspelled `qq` or a JSON
 * `__proto__` key would run the search unfiltered over the whole catalogue. Other CKAN
 * parameters go through `action(name, params)`, which sends any key.
 */
function assertKeys(method: string, action: string, params: unknown, known: readonly string[]): void {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw wrongType(`${method} parameters`, "an object", params);
  }
  for (const key of Object.keys(params)) {
    if (!known.includes(key)) {
      throw new GovDataValidationError(
        `Invalid ${method} parameter ${JSON.stringify(key)}: not a parameter of ${method}. ` +
          `Known: ${known.join(", ")}. Use action("${action}", params) to send another CKAN parameter.`,
      );
    }
  }
}

/**
 * Throw GovDataValidationError unless `value` is undefined, null or an array of
 * non-blank strings. A string was iterated character by character: `fq: "a OR b"`
 * failed on its space, and `facet_field: "organization"` went out as a string CKAN
 * rejects.
 */
function assertTextList(name: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) throw wrongType(name, "an array of strings", value);
  for (const item of value) assertText(`${name} entry`, item);
}

/** Throw unless `value` is undefined or a boolean. */
function assertFlag(name: string, value: unknown): void {
  if (value !== undefined && typeof value !== "boolean") throw wrongType(name, "a boolean", value);
}

const SEARCH_KEYS = ["q", "fq", "rows", "start", "sort", "facet_field"] as const;
const PACKAGE_LIST_KEYS = ["limit", "offset"] as const;
const GROUP_LIST_KEYS = ["limit", "offset", "all_fields"] as const;

/** Throw unless `value` is undefined or a non-negative safe integer (paging values). */
function assertCount(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid(name, "a non-negative integer", value);
  }
}

/**
 * Check a `*_list` limit. CKAN reads `limit=0` as "no limit" (the whole catalogue,
 * 168,956 names on GovData), so 0, like any non-positive or fractional value, is
 * refused. To get the whole list, leave the limit out.
 */
function assertLimit(limit: number | undefined): void {
  if (limit === undefined) return;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new GovDataValidationError(
      `Invalid limit: expected a positive integer, got ${String(limit)}. Leave it out for the whole list.`,
    );
  }
}

/** A JSON object (not null, not an array). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A `package_search` result: an object with a numeric count and a results array. */
function isSearchResult(value: unknown): boolean {
  if (!isObject(value)) return false;
  const count = value["count"];
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 && Array.isArray(value["results"]);
}

/** The error for an answer that does not have the shape the caller relies on. */
function shapeError(name: string, expected: string): GovDataParseError {
  return new GovDataParseError(`Unexpected response shape from ${ACTION}/${name}: expected ${expected}.`);
}

export class GovDataClient {
  private readonly engine: RequestEngine;

  constructor(options: EngineOptions = {}) {
    this.engine = new RequestEngine(options);
  }

  /**
   * Call any CKAN action by name and return its unwrapped `result`. Throws a
   * GovDataError if the envelope reports `success: false`. An invalid action name,
   * a blank parameter name or a blank parameter value (or list entry) rejects with
   * GovDataValidationError before any request.
   */
  async action<T = JsonValue>(name: string, params: QueryParams = {}): Promise<T> {
    if (typeof name !== "string") {
      // `String(name)` made `action(5)` call an action named "5" and `action(null)` one named "null".
      throw wrongType("CKAN action name", "a string", name);
    }
    const action = name.trim();
    if (!ACTION_NAME.test(action)) {
      throw new GovDataValidationError(`Invalid CKAN action name: ${cutForMessage(JSON.stringify(name))}`);
    }
    assertParams(params);
    const env = await this.engine.getJson<CkanEnvelope<T> | null>(
      `${ACTION}/${encodeURIComponent(action)}`,
      params,
    );
    // A proxy's JSON error page or another JSON API is not an envelope (`null`,
    // an array, an object without `success`); say so rather than crash on it.
    if (!isObject(env) || typeof env.success !== "boolean") {
      throw shapeError(action, "a CKAN envelope (a JSON object with a boolean success)");
    }
    if (!env.success) {
      // Surface CKAN's human-readable error.message; fall back to the raw JSON
      // only when no message is present (mirrors the HTTP-error detail path).
      const e: unknown = env.error;
      const message = (e as { message?: unknown } | undefined)?.message;
      const detail =
        typeof e === "string"
          ? e
          : typeof message === "string"
            ? message
            : e !== undefined
              ? JSON.stringify(e)
              : "unknown error";
      // A success:false envelope can come with HTTP 200, so it never passes the
      // engine's error-detail sanitising: strip terminal controls here too.
      throw new GovDataError(`CKAN action ${cutForMessage(JSON.stringify(action))} failed: ${sanitizeServerText(detail)}`);
    }
    // `{"success": true}` without a result would print nothing useful (and the CLI
    // would crash rendering `undefined`); CKAN always sends one, `null` included.
    if (env.result === undefined) throw shapeError(action, "a result in the envelope");
    return env.result as T;
  }

  /**
   * An action whose `result` must have a known top-level shape (never a deep
   * schema): a broken or foreign answer becomes a GovDataParseError naming the
   * action, not a TypeError further down.
   */
  private async typed<T>(
    name: string,
    params: QueryParams,
    ok: (value: unknown) => boolean,
    expected: string,
  ): Promise<T> {
    const result = await this.action<unknown>(name, params);
    if (!ok(result)) throw shapeError(name, expected);
    return result as T;
  }

  /**
   * Full-text / faceted dataset search.
   *
   * Filters always go out as CKAN's `fq_list`, each applied as its own Solr
   * filter query (all must match). Not as `fq`: CKAN reads a repeated `fq=` key as
   * a Python list and fails with HTTP 409, and it puts `+capacity:public` in front
   * of a single `fq`, so a top-level `OR` in it (`organization:a OR groups:b`)
   * stopped filtering at all and the whole catalogue came back. CKAN splits a lone
   * `fq_list` value into characters, so a single filter is sent twice (the same
   * filter applied twice selects the same datasets). Wrapping it in parentheses
   * instead would break a negated filter: Solr matches nothing for a nested
   * `(-organization:x)`. Facet fields go out as the JSON list CKAN expects in
   * `facet.field`; it rejects `facet_field` with HTTP 400.
   */
  async packageSearch(params: PackageSearchParams = {}): Promise<PackageSearchResult> {
    // Checked before any request: an unknown key, a blank text value, a string where
    // a list belongs or a NaN/negative number would otherwise go out (or be dropped).
    assertKeys("packageSearch", "package_search", params, SEARCH_KEYS);
    if (params.q !== undefined) assertText("q", params.q);
    if (params.sort !== undefined) assertText("sort", params.sort);
    assertTextList("fq", params.fq);
    assertTextList("facet_field", params.facet_field);
    const fq = params.fq ?? [];
    const facetFields = params.facet_field ?? [];
    assertCount("rows", params.rows);
    assertCount("start", params.start);
    return this.typed<PackageSearchResult>(
      "package_search",
      prune({
        q: params.q,
        fq_list: fq.length === 1 ? [fq[0], fq[0]] : fq.length > 1 ? fq : undefined,
        rows: params.rows,
        start: params.start,
        sort: params.sort,
        "facet.field": facetFields.length > 0 ? JSON.stringify(facetFields) : undefined,
      }),
      isSearchResult,
      "an object with a numeric count and a results array",
    );
  }

  /** A single dataset by id or name. */
  async packageShow(id: string): Promise<Package> {
    assertText("id", id);
    return this.typed<Package>("package_show", { id }, isObject, "a JSON object");
  }

  /** Dataset names, paged with limit/offset (a positive limit; omit it for all). */
  async packageList(params: Pick<ListParams, "limit" | "offset"> = {}): Promise<string[]> {
    assertKeys("packageList", "package_list", params, PACKAGE_LIST_KEYS);
    assertLimit(params.limit);
    assertCount("offset", params.offset);
    return this.typed<string[]>(
      "package_list",
      prune({ limit: params.limit, offset: params.offset }),
      Array.isArray,
      "an array",
    );
  }

  /** Organizations (names, or full objects with `all_fields`), paged with limit/offset. */
  async organizationList(params: ListParams = {}): Promise<JsonValue[]> {
    assertKeys("organizationList", "organization_list", params, GROUP_LIST_KEYS);
    assertFlag("all_fields", params.all_fields);
    assertLimit(params.limit);
    assertCount("offset", params.offset);
    return this.typed<JsonValue[]>(
      "organization_list",
      prune({ all_fields: params.all_fields, limit: params.limit, offset: params.offset }),
      Array.isArray,
      "an array",
    );
  }

  async organizationShow(id: string): Promise<Organization> {
    assertText("id", id);
    return this.typed<Organization>("organization_show", { id }, isObject, "a JSON object");
  }

  /** Groups (themes/categories), paged with limit/offset like organizationList. */
  async groupList(params: ListParams = {}): Promise<JsonValue[]> {
    assertKeys("groupList", "group_list", params, GROUP_LIST_KEYS);
    assertFlag("all_fields", params.all_fields);
    assertLimit(params.limit);
    assertCount("offset", params.offset);
    return this.typed<JsonValue[]>(
      "group_list",
      prune({ all_fields: params.all_fields, limit: params.limit, offset: params.offset }),
      Array.isArray,
      "an array",
    );
  }

  async groupShow(id: string): Promise<Group> {
    assertText("id", id);
    return this.typed<Group>("group_show", { id }, isObject, "a JSON object");
  }

  /** Tags, optionally filtered by a query substring. */
  async tagList(query?: string): Promise<string[]> {
    if (query !== undefined) assertText("query", query);
    return this.typed<string[]>("tag_list", prune({ query }), Array.isArray, "an array");
  }

  /** A single resource (distribution) by id. */
  async resourceShow(id: string): Promise<Resource> {
    assertText("id", id);
    return this.typed<Resource>("resource_show", { id }, isObject, "a JSON object");
  }
}
