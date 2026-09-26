// Domain types for the GovData CKAN Action API (ckan.govdata.de).
//
// CKAN wraps every response in `{ help, success, result }` (or an `error` object
// when `success` is false). The client unwraps `result`; datasets are deeply
// nested and CKAN-version-specific, so they are exposed as raw `JsonObject`s.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** The envelope CKAN wraps every Action API response in. */
export interface CkanEnvelope<T> {
  help: string;
  success: boolean;
  result?: T;
  error?: JsonObject;
}

/** Result of `package_search`. */
export interface PackageSearchResult {
  count: number;
  results: JsonObject[];
  facets?: JsonObject;
  search_facets?: JsonObject;
  sort?: string;
}

/** A dataset ("package"). */
export type Package = JsonObject;
/** An organization or group. */
export type Organization = JsonObject;
export type Group = JsonObject;
/** A resource (a single distributable file within a dataset). */
export type Resource = JsonObject;

/** Parameters for `package_search`. */
export interface PackageSearchParams {
  /** Solr query string, e.g. `title:Haushalt`. */
  q?: string;
  /**
   * Filter queries, e.g. `["organization:statistisches-bundesamt"]`. All must
   * match. Sent as CKAN's `fq_list` (a single filter twice), each its own Solr
   * filter, so a top-level `OR` inside one filter works as written.
   */
  fq?: string[];
  rows?: number;
  start?: number;
  /** e.g. `"metadata_modified desc"`. */
  sort?: string;
  /**
   * Facet fields to compute, e.g. `["organization", "res_format"]`. Sent as
   * CKAN's `facet.field` JSON list; counts come back in `search_facets`.
   */
  facet_field?: string[];
}

/** Parameters for the `*_list` endpoints. */
export interface ListParams {
  /**
   * Most entries to return: a positive integer (CKAN reads 0 as "no limit", so 0
   * is refused). Leave it out for the whole list.
   */
  limit?: number;
  offset?: number;
  /** Return full objects instead of just names (organization/group lists). */
  all_fields?: boolean;
}
