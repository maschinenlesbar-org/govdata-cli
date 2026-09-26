// GovDataClient — a typed client over the open (no-auth) read endpoints of the
// GovData CKAN Action API (https://ckan.govdata.de/api/3/action), the central
// German open-data catalogue.
//
//   client.packageSearch({ q: "Haushalt", rows: 5 })
//   client.packageShow("some-dataset-id")
//   client.action("organization_list")   // generic escape hatch

import { RequestEngine, sanitizeServerText, type EngineOptions } from "./engine.js";
import type { QueryParams } from "./query.js";
import { GovDataError } from "./errors.js";
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
  const out: QueryParams = {};
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
    const env = await this.engine.getJson<CkanEnvelope<T>>(
      `${ACTION}/${encodeURIComponent(action)}`,
      params,
    );
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
    return env.result as T;
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
    return this.action<PackageSearchResult>(
      "package_search",
      prune({
        q: params.q,
        fq_list: fq.length === 1 ? [fq[0], fq[0]] : fq.length > 1 ? fq : undefined,
        rows: params.rows,
        start: params.start,
        sort: params.sort,
        "facet.field": facetFields.length > 0 ? JSON.stringify(facetFields) : undefined,
      }),
    );
  }

  /** A single dataset by id or name. */
  packageShow(id: string): Promise<Package> {
    return this.action<Package>("package_show", { id });
  }

  /** Dataset names, paged with limit/offset (a positive limit; omit it for all). */
  async packageList(params: ListParams = {}): Promise<string[]> {
    assertLimit(params.limit);
    return this.action<string[]>(
      "package_list",
      prune({ limit: params.limit, offset: params.offset }),
    );
  }

  /** Organizations (names, or full objects with `all_fields`). */
  organizationList(params: ListParams = {}): Promise<JsonValue[]> {
    return this.action<JsonValue[]>("organization_list", prune({ all_fields: params.all_fields }));
  }

  organizationShow(id: string): Promise<Organization> {
    return this.action<Organization>("organization_show", { id });
  }

  /** Groups (themes/categories). */
  groupList(params: ListParams = {}): Promise<JsonValue[]> {
    return this.action<JsonValue[]>("group_list", prune({ all_fields: params.all_fields }));
  }

  groupShow(id: string): Promise<Group> {
    return this.action<Group>("group_show", { id });
  }

  /** Tags, optionally filtered by a query substring. */
  tagList(query?: string): Promise<string[]> {
    return this.action<string[]>("tag_list", prune({ query }));
  }

  /** A single resource (distribution) by id. */
  resourceShow(id: string): Promise<Resource> {
    return this.action<Resource>("resource_show", { id });
  }
}
