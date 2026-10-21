// GovDataClient — a typed client over the open (no-auth) read endpoints of the
// GovData CKAN Action API (https://ckan.govdata.de/api/3/action), the central
// German open-data catalogue.
//
//   client.packageSearch({ q: "Haushalt", rows: 5 })
//   client.packageShow("some-dataset-id")
//   client.action("organization_list")   // generic escape hatch

import { bigIntegerKeysOption, RequestEngine, sanitizeServerText, type EngineOptions } from "./engine.js";
import type { QueryParams, QueryValue } from "./query.js";
import { GovDataActionError, GovDataParseError, GovDataValidationError, cutForMessage, quoteValue } from "./errors.js";
import {
  assertValid,
  fieldProblem,
  idProblem,
  listProblem,
  normalizeText,
  normalizeToken,
  queryValueProblem,
  sortProblem,
  textProblem,
  tokenProblem,
  type Problem,
} from "./validate.js";
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
 * The members every GovDataClient declares as big integers (`EngineOptions.bigIntegerKeys`): Solr's
 * `_version_`, which `package_search` returns for `fl=_version_` (GovData sends it as a string; a
 * number would be past 2^53).
 */
const BIG_INTEGER_KEYS = ["_version_"] as const;

/**
 * CKAN action names are always `[a-z0-9_]+`. Restricting to that allowlist closes
 * the path-traversal hole (`../../..` escaping `/api/3/action/`) and the
 * query/fragment-injection hole (a `?`/`#` in the name corrupting the query) for
 * both the library and the CLI generic-action escape hatch.
 */
const ACTION_NAME = /^[a-z0-9_]+$/;

/**
 * The parameters as they are sent, checked first (GovDataValidationError before any request):
 * each name as a token (`normalizeToken`: trimmed, NFC; a blank or invisible name and two names
 * that are the same once trimmed, `q` and ` q`, are refused), each value by `queryValueProblem`
 * (a string, a finite number, a boolean or a Date, or a non-empty list of them; each string as
 * text, `normalizeText`). `undefined` and `null` mean "not given" and are left out. CKAN reads
 * an empty parameter as "not given", so a blank or dropped filter would silently widen the
 * result to the whole catalogue.
 */
function prune(params: unknown): QueryParams {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw wrongType("action parameters", "an object", params);
  }
  // A null-prototype object, so a `__proto__` key is kept as a parameter instead
  // of setting the prototype (and being lost).
  const out = Object.create(null) as QueryParams;
  const names = new Map<string, string>();
  for (const [k, v] of Object.entries(params)) {
    const name = normalizeToken(assertValid("parameter name", k, tokenProblem));
    const earlier = names.get(name);
    if (earlier !== undefined) {
      throw new GovDataValidationError(
        `Invalid action parameters: ${quoteValue(name)} is given twice (as ${quoteValue(earlier)} and ${quoteValue(k)}).`,
      );
    }
    names.set(name, k);
    if (v === undefined || v === null) continue;
    out[name] = textValue(assertValid(`parameter ${name}`, v as QueryValue, queryValueProblem));
  }
  return out;
}

/** A query value with each string in it sent as text (`normalizeText`); other values as they are. */
function textValue(value: QueryValue): QueryValue {
  if (typeof value === "string") return normalizeText(value);
  return Array.isArray(value) ? (value.map((v) => (typeof v === "string" ? normalizeText(v) : v)) as QueryValue) : value;
}

function invalid(name: string, expected: string, value: unknown): GovDataValidationError {
  const shown = typeof value === "string" ? quoteValue(value) : String(value);
  return new GovDataValidationError(`Invalid ${name}: expected ${expected}, got ${shown}.`);
}

/** How a value is shown in a message: strings quoted visibly, other values by type or value. */
function describe(value: unknown): string {
  if (typeof value === "string") return quoteValue(value);
  if (Array.isArray(value)) return "an array";
  if (value === null) return "null";
  return typeof value === "object" ? "an object" : String(value);
}

/** GovDataValidationError `Invalid <name>: expected <expected>, got <value described>.` */
function wrongType(name: string, expected: string, value: unknown): GovDataValidationError {
  return new GovDataValidationError(`Invalid ${name}: expected ${expected}, got ${describe(value)}.`);
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
        `Invalid ${method} parameter ${quoteValue(key)}: not a parameter of ${method}. ` +
          `Known: ${known.join(", ")}. Use action("${action}", params) to send another CKAN parameter.`,
      );
    }
  }
}

/** Check an optional parameter with `problem`; `undefined` means "not given". */
function assertOptional(name: string, value: string | undefined, problem: Problem<string>): void {
  if (value !== undefined) assertValid(name, value, problem);
}

/**
 * Check an optional list parameter (`fq`, `facet_field`): an array, each entry checked with
 * `itemProblem`, a blank entry refused, never dropped. A string was iterated character by
 * character: `fq: "a OR b"` failed on its space, and `facet_field: "organization"` went out as
 * a string CKAN rejects. `undefined`, `null` and an empty list mean "not given".
 */
function assertList(name: string, value: readonly string[] | undefined, itemProblem: Problem<string>): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) throw wrongType(name, "an array of strings", value);
  if (value.length === 0) return;
  assertValid(name, value, (v) => listProblem(v, itemProblem));
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
      `Invalid limit: expected a positive integer, got ${cutForMessage(String(limit))}. Leave it out for the whole list.`,
    );
  }
}

/** Check an id with `idProblem` and return it as it is sent (`normalizeToken`). */
function idOf(id: string): string {
  return normalizeToken(assertValid("id", id, idProblem));
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

/** The error for an answer that does not have the shape the caller relies on, naming the request (`GET <url>`). */
function shapeError(request: string, expected: string): GovDataParseError {
  return new GovDataParseError(`${request}: unexpected response shape: expected ${expected}.`);
}

export class GovDataClient {
  private readonly engine: RequestEngine;

  constructor(options: EngineOptions = {}) {
    // Solr's `_version_` (≈1.88e18, past 2^53) is always declared a big integer: a mirror that
    // sends it as a number gets the string GovData sends, never a refused answer.
    const given = options ?? {};
    this.engine = new RequestEngine({
      ...given,
      bigIntegerKeys: new Set([...bigIntegerKeysOption(given.bigIntegerKeys), ...BIG_INTEGER_KEYS]),
    });
  }

  /**
   * Call any CKAN action by name and return its unwrapped `result`. Throws a
   * GovDataActionError if the envelope reports `success: false`. An invalid action name,
   * a parameter name or value the rules refuse (`prune`: a blank or invisible name, a name
   * given twice once trimmed, a blank value, a control or format character, an empty list or
   * one with a `null` entry) rejects with GovDataValidationError before any request. Names go
   * out trimmed, string values trimmed and in NFC.
   */
  async action<T = JsonValue>(name: string, params: QueryParams = {}): Promise<T> {
    return (await this.call<T>(name, params)).result;
  }

  /**
   * Call an action: its unwrapped `result` and the request as error messages name it
   * (`GET <url>`, the URL that answered, userinfo redacted). Every error about the answer starts
   * with that request.
   */
  private async call<T>(name: string, params: QueryParams): Promise<{ result: T; request: string }> {
    if (typeof name !== "string") {
      // `String(name)` made `action(5)` call an action named "5" and `action(null)` one named "null".
      throw wrongType("CKAN action name", "a string", name);
    }
    const action = name.trim();
    if (!ACTION_NAME.test(action)) {
      throw new GovDataValidationError(`Invalid CKAN action name: ${quoteValue(name)}`);
    }
    const { value: env, url, request } = await this.engine.getAnswer<CkanEnvelope<T> | null>(
      `${ACTION}/${encodeURIComponent(action)}`,
      prune(params),
    );
    // A proxy's JSON error page or another JSON API is not an envelope (`null`,
    // an array, an object without `success`); say so rather than crash on it.
    if (!isObject(env) || typeof env.success !== "boolean") {
      throw shapeError(request, "a CKAN envelope (a JSON object with a boolean success)");
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
      const type = (e as { __type?: unknown } | null | undefined)?.__type;
      throw new GovDataActionError(
        `${request}: CKAN action ${cutForMessage(JSON.stringify(action))} failed: ${sanitizeServerText(this.engine.scrub(detail))}`,
        { action, errorType: typeof type === "string" ? sanitizeServerText(type) : undefined, url },
      );
    }
    // `{"success": true}` without a result would print nothing useful (and the CLI
    // would crash rendering `undefined`); CKAN always sends one, `null` included.
    if (env.result === undefined) throw shapeError(request, "a result in the envelope");
    return { result: env.result as T, request };
  }

  /**
   * An action whose `result` must have a known top-level shape (never a deep
   * schema): a broken or foreign answer becomes a GovDataParseError naming the
   * request, not a TypeError further down.
   */
  private async typed<T>(
    name: string,
    params: QueryParams,
    ok: (value: unknown) => boolean,
    expected: string,
  ): Promise<T> {
    const { result, request } = await this.call<unknown>(name, params);
    if (!ok(result)) throw shapeError(request, expected);
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
   * `facet.field`; it rejects `facet_field` with HTTP 400. The search text `q` and each
   * filter go out as text, trimmed and in NFC (`textProblem`, `normalizeText`); the sort
   * expression (`sortProblem`: `<field> asc|desc`, …) and each facet field (`fieldProblem`: a
   * Solr field name) as tokens (`normalizeToken`).
   */
  async packageSearch(params: PackageSearchParams = {}): Promise<PackageSearchResult> {
    // Checked before any request: an unknown key, a refused text value, a string where
    // a list belongs or a NaN/negative number would otherwise go out (or be dropped).
    assertKeys("packageSearch", "package_search", params, SEARCH_KEYS);
    const q = params.q;
    const sort = params.sort;
    const fqGiven = params.fq;
    const facetGiven = params.facet_field;
    const rows = params.rows;
    const start = params.start;
    assertOptional("q", q, textProblem);
    assertList("fq", fqGiven, textProblem);
    assertOptional("sort", sort, sortProblem);
    assertList("facet_field", facetGiven, fieldProblem);
    assertCount("rows", rows);
    assertCount("start", start);
    const fq = fqGiven ?? [];
    const facetFields = (facetGiven ?? []).map(normalizeToken);
    return this.typed<PackageSearchResult>(
      "package_search",
      {
        q,
        fq_list: fq.length === 1 ? [fq[0]!, fq[0]!] : fq.length > 1 ? fq : undefined,
        rows,
        start,
        sort,
        "facet.field": facetFields.length > 0 ? JSON.stringify(facetFields) : undefined,
      },
      isSearchResult,
      "an object with a numeric count and a results array",
    );
  }

  /** A single dataset by id or name (sent trimmed, in NFC; `idProblem`). */
  async packageShow(id: string): Promise<Package> {
    return this.typed<Package>("package_show", { id: idOf(id) }, isObject, "a JSON object");
  }

  /** Dataset names, paged with limit/offset (a positive limit; omit it for all). */
  async packageList(params: Pick<ListParams, "limit" | "offset"> = {}): Promise<string[]> {
    assertKeys("packageList", "package_list", params, PACKAGE_LIST_KEYS);
    const limit = params.limit;
    const offset = params.offset;
    assertLimit(limit);
    assertCount("offset", offset);
    return this.typed<string[]>("package_list", { limit, offset }, Array.isArray, "an array");
  }

  /** Organizations (names, or full objects with `all_fields`), paged with limit/offset. */
  async organizationList(params: ListParams = {}): Promise<JsonValue[]> {
    return this.groupLike("organizationList", "organization_list", params);
  }

  async organizationShow(id: string): Promise<Organization> {
    return this.typed<Organization>("organization_show", { id: idOf(id) }, isObject, "a JSON object");
  }

  /** Groups (themes/categories), paged with limit/offset like organizationList. */
  async groupList(params: ListParams = {}): Promise<JsonValue[]> {
    return this.groupLike("groupList", "group_list", params);
  }

  /** `organization_list` / `group_list`: the same parameters, the same checks. */
  private async groupLike(method: string, action: string, params: ListParams): Promise<JsonValue[]> {
    assertKeys(method, action, params, GROUP_LIST_KEYS);
    const allFields = params.all_fields;
    const limit = params.limit;
    const offset = params.offset;
    assertFlag("all_fields", allFields);
    assertLimit(limit);
    assertCount("offset", offset);
    return this.typed<JsonValue[]>(action, { all_fields: allFields, limit, offset }, Array.isArray, "an array");
  }

  async groupShow(id: string): Promise<Group> {
    return this.typed<Group>("group_show", { id: idOf(id) }, isObject, "a JSON object");
  }

  /** Tags, optionally filtered by a query substring (refused like `q`; sent trimmed, in NFC). */
  async tagList(query?: string): Promise<string[]> {
    const text = query;
    assertOptional("query", text, textProblem);
    return this.typed<string[]>("tag_list", { query: text }, Array.isArray, "an array");
  }

  /** A single resource (distribution) by id (sent trimmed, in NFC; `idProblem`). */
  async resourceShow(id: string): Promise<Resource> {
    return this.typed<Resource>("resource_show", { id: idOf(id) }, isObject, "a JSON object");
  }
}
