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
  /** Filter queries, e.g. `["organization:destatis"]`. */
  fq?: string[];
  rows?: number;
  start?: number;
  /** e.g. `"metadata_modified desc"`. */
  sort?: string;
  /** Facet fields to compute. */
  facet_field?: string[];
}

/** Parameters for the `*_list` endpoints. */
export interface ListParams {
  limit?: number;
  offset?: number;
  /** Return full objects instead of just names (organization/group lists). */
  all_fields?: boolean;
}
