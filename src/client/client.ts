// GovDataClient — a typed client over the open (no-auth) read endpoints of the
// GovData CKAN Action API (https://ckan.govdata.de/api/3/action), the central
// German open-data catalogue.
//
//   client.packageSearch({ q: "Haushalt", rows: 5 })
//   client.packageShow("some-dataset-id")
//   client.action("organization_list")   // generic escape hatch

import { RequestEngine, sanitizeServerText, type EngineOptions } from "./engine.js";
import type { QueryParams } from "./query.js";
import { GovDataError, GovDataParseError } from "./errors.js";
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
 * Drop undefined (and empty-string) values so only the parameters the caller
 * actually set are sent. An empty string filter (e.g. `tags --query ""`) is
 * treated as "no filter" rather than forwarded as `query=`.
 */
function prune(params: Record<string, unknown>): QueryParams {
  // A null-prototype object, so a `__proto__` key is kept as a parameter instead
  // of setting the prototype (and being lost).
  const out = Object.create(null) as QueryParams;
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    out[k] = v as QueryParams[string];
  }
  return out;
}

/**
 * Check a `*_list` limit. CKAN reads `limit=0` as "no limit" (the whole catalogue,
 * 168,956 names on GovData), so 0, like any non-positive or fractional value, is
 * refused. To get the whole list, leave the limit out.
 */
function assertLimit(limit: number | undefined): void {
  if (limit === undefined) return;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new GovDataError(
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
   * GovDataError if the envelope reports `success: false`.
   */
  async action<T = JsonValue>(name: string, params: QueryParams = {}): Promise<T> {
    const action = String(name).trim();
    if (!ACTION_NAME.test(action)) {
      throw new GovDataError(`Invalid CKAN action name: "${name}"`);
    }
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
      throw new GovDataError(`CKAN action "${name}" failed: ${sanitizeServerText(detail)}`);
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
  packageSearch(params: PackageSearchParams = {}): Promise<PackageSearchResult> {
    const fq = (params.fq ?? []).filter((f) => f !== "");
    const facetFields = params.facet_field ?? [];
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
  packageShow(id: string): Promise<Package> {
    return this.typed<Package>("package_show", { id }, isObject, "a JSON object");
  }

  /** Dataset names, paged with limit/offset (a positive limit; omit it for all). */
  async packageList(params: ListParams = {}): Promise<string[]> {
    assertLimit(params.limit);
    return this.typed<string[]>(
      "package_list",
      prune({ limit: params.limit, offset: params.offset }),
      Array.isArray,
      "an array",
    );
  }

  /** Organizations (names, or full objects with `all_fields`), paged with limit/offset. */
  async organizationList(params: ListParams = {}): Promise<JsonValue[]> {
    assertLimit(params.limit);
    return this.typed<JsonValue[]>(
      "organization_list",
      prune({ all_fields: params.all_fields, limit: params.limit, offset: params.offset }),
      Array.isArray,
      "an array",
    );
  }

  organizationShow(id: string): Promise<Organization> {
    return this.typed<Organization>("organization_show", { id }, isObject, "a JSON object");
  }

  /** Groups (themes/categories), paged with limit/offset like organizationList. */
  async groupList(params: ListParams = {}): Promise<JsonValue[]> {
    assertLimit(params.limit);
    return this.typed<JsonValue[]>(
      "group_list",
      prune({ all_fields: params.all_fields, limit: params.limit, offset: params.offset }),
      Array.isArray,
      "an array",
    );
  }

  groupShow(id: string): Promise<Group> {
    return this.typed<Group>("group_show", { id }, isObject, "a JSON object");
  }

  /** Tags, optionally filtered by a query substring. */
  tagList(query?: string): Promise<string[]> {
    return this.typed<string[]>("tag_list", prune({ query }), Array.isArray, "an array");
  }

  /** A single resource (distribution) by id. */
  resourceShow(id: string): Promise<Resource> {
    return this.typed<Resource>("resource_show", { id }, isObject, "a JSON object");
  }
}
