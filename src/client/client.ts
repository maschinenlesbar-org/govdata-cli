// GovDataClient — a typed client over the open (no-auth) read endpoints of the
// GovData CKAN Action API (https://ckan.govdata.de/api/3/action), the central
// German open-data catalogue.
//
//   client.packageSearch({ q: "Haushalt", rows: 5 })
//   client.packageShow("some-dataset-id")
//   client.action("organization_list")   // generic escape hatch

import { RequestEngine, type EngineOptions } from "./engine.js";
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
const ACTION_NAME = /^[a-z0-9_]+$/i;

/** Drop undefined values so only the parameters the caller set are sent. */
function prune(params: Record<string, unknown>): QueryParams {
  const out: QueryParams = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) out[k] = v as QueryParams[string];
  }
  return out;
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
      const e = env.error as { message?: unknown } | undefined;
      const detail =
        typeof e?.message === "string" ? e.message : e ? JSON.stringify(e) : "unknown error";
      throw new GovDataError(`CKAN action "${name}" failed: ${detail}`);
    }
    return env.result as T;
  }

  /** Full-text / faceted dataset search. */
  packageSearch(params: PackageSearchParams = {}): Promise<PackageSearchResult> {
    return this.action<PackageSearchResult>(
      "package_search",
      prune({
        q: params.q,
        fq: params.fq,
        rows: params.rows,
        start: params.start,
        sort: params.sort,
        facet_field: params.facet_field,
      }),
    );
  }

  /** A single dataset by id or name. */
  packageShow(id: string): Promise<Package> {
    return this.action<Package>("package_show", { id });
  }

  /** Dataset names (paginated). */
  packageList(params: ListParams = {}): Promise<string[]> {
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
