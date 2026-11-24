// The use cases of the skills as library functions, built on the client: each composes its calls
// and carries the traps the skills document, so no caller (the CLI, the MCP server's tools, a
// library user) has to know them:
// - findDatasets (govdata-dataset-finder): datasets for a topic and friendly filters (organization
//   by name, the publishing body, theme, file format, only datasets with files), a page at a time,
//   each with its formats and the licences its files really carry;
// - countDatasets (govdata-catalogue-stats): how many datasets match, and how they spread over
//   organizations, formats, licences, themes and tags: sorted, the two spellings of one format and
//   the variants of one licence folded together, with complete false when CKAN's list was cut;
// - listFiles (govdata-resource-harvest): the files of the matching datasets as a flat manifest,
//   each link with its kind (a file, a file generated on request, a service, a landing page, a
//   template, a broken link), its format and its own licence; services, duplicates and links
//   without a URL counted, not listed;
// - getDataset and listOrganizations, for what those don't reach: one dataset's full record, and
//   the catalogue's organizations with their dataset counts.
//
// The rules they keep: no bare "not found" (an empty answer says what was searched and what to
// try); several organizations for one name are reported as ambiguous, never guessed; each answer is
// a named type (public API of the CLI package: a changed shape is a `feat(client)!:` commit); every
// request an answer made is kept (`requestsOf(answer)`), as the client sends it, for its source.

import { actionRequest, packageSearchQuery, type GovDataClient } from "./client.js";
import { GovDataActionError, GovDataApiError, GovDataValidationError } from "./errors.js";
import type { JsonObject, JsonValue, PackageSearchParams, PackageSearchResult } from "./types.js";

// ---- the requests an answer made -------------------------------------------------------------

const REQUESTS = new WeakMap<object, readonly string[]>();

/**
 * The requests the operation that returned `answer` made, in order, each as the client sends it
 * under the Action API's base (`package_search?q=…`): what its `source` names. Empty for an object
 * no operation returned.
 */
export function requestsOf(answer: object): readonly string[] {
  return REQUESTS.get(answer) ?? [];
}

/** The requests of one operation call. */
class Trace {
  readonly requests: string[] = [];

  async search(client: GovDataClient, params: PackageSearchParams): Promise<PackageSearchResult> {
    this.requests.push(actionRequest("package_search", packageSearchQuery(params)));
    return client.packageSearch(params);
  }

  done<T extends object>(answer: T): T {
    REQUESTS.set(answer, [...this.requests]);
    return answer;
  }
}

// ---- reading CKAN's JSON ---------------------------------------------------------------------

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const textOf = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
const objectsOf = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isObject) : []);

/** A dataset's `extras` (DCAT-AP.de metadata) as a map. */
function extrasOf(dataset: JsonObject): Map<string, string> {
  const extras = new Map<string, string>();
  for (const extra of objectsOf(dataset["extras"])) {
    const key = textOf(extra["key"]);
    const value = textOf(extra["value"]);
    if (key !== undefined && value !== undefined) extras.set(key, value);
  }
  return extras;
}

/** Whitespace collapsed, cut at `max` characters with an ellipsis. */
function excerpt(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return undefined;
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * `html` with each tag replaced by a space. A tag starts with "<" and a letter, "/", "!" or "?" (as
 * in HTML: "x < y" is text) and runs to the next ">"; a "<" with no ">" after it is text. One pass
 * with indexOf, so linear: the regular expression `/<[^>]*>/` tried a match at every "<" and, with
 * no ">" after it, rescanned the rest of the text (quadratic: a publisher's description of 200 000
 * characters of "<a" took over a minute).
 */
function withoutTags(html: string): string {
  const out: string[] = [];
  let at = 0;
  for (let open = html.indexOf("<"); open !== -1; open = html.indexOf("<", open + 1)) {
    if (!/[A-Za-z/!?]/.test(html.charAt(open + 1))) continue;
    const close = html.indexOf(">", open + 1);
    if (close === -1) break;
    out.push(html.slice(at, open), " ");
    at = close + 1;
    open = close;
  }
  out.push(html.slice(at));
  return out.join("");
}

/** The named character references publishers use, by name. */
const ENTITIES: Readonly<Record<string, string>> = {
  nbsp: " ", lt: "<", gt: ">", quot: '"', apos: "'", amp: "&",
  auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß",
  eacute: "é", egrave: "è", agrave: "à", aacute: "á", ccedil: "ç", oacute: "ó",
  sect: "§", deg: "°", middot: "·", bull: "•", shy: "", ndash: "–", mdash: "—", hellip: "…", euro: "€",
  copy: "©", reg: "®", laquo: "«", raquo: "»", bdquo: "„", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", sbquo: "‚",
  times: "×", micro: "µ", sup2: "²", sup3: "³", frac12: "½", plusmn: "±",
};

/** `text` with its character references decoded (named ones from ENTITIES, numeric ones), in one pass. */
function decodeEntities(text: string): string {
  return text.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,7});/gi, (whole, ref: string) => {
    if (ref.startsWith("#")) {
      const code = ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ref] ?? whole;
  });
}

/**
 * HTML (an attribution text or a description can arrive as `<p>…</p>`) as plain text, cut at `max`:
 * the tags stripped, the character references decoded, and then the tags stripped again, so markup
 * the publisher escaped (`&lt;img …&gt;`) never comes back as a live tag.
 */
function plainText(html: string | undefined, max = 1000): string | undefined {
  if (html === undefined) return undefined;
  return excerpt(withoutTags(decodeEntities(withoutTags(html))), max);
}

/** Folded for comparing names: lower case, no accents (ü as u, like CKAN's slugs), ß as ss. */
export function foldName(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").replace(/ß/g, "ss").toLowerCase().replace(/\s+/g, " ").trim();
}

/** A Solr phrase: the value in double quotes, its quotes and backslashes escaped. */
const phrase = (value: string): string => `"${value.replace(/[\\"]/g, "\\$&")}"`;

// ---- themes ----------------------------------------------------------------------------------

/** GovData's 13 themes (the EU data themes, CKAN's groups), by code, with their German titles. */
export const THEMES = Object.freeze({
  agri: "Landwirtschaft, Fischerei, Forstwirtschaft und Nahrungsmittel",
  econ: "Wirtschaft und Finanzen",
  educ: "Bildung, Kultur und Sport",
  ener: "Energie",
  envi: "Umwelt",
  gove: "Regierung und öffentlicher Sektor",
  heal: "Gesundheit",
  intr: "Internationale Themen",
  just: "Justiz, Rechtssystem und öffentliche Sicherheit",
  regi: "Regionen und Städte",
  soci: "Bevölkerung und Gesellschaft",
  tech: "Wissenschaft und Technologie",
  tran: "Verkehr",
});
export type ThemeCode = keyof typeof THEMES;

/** A theme's code from its code or its German title (any case), else undefined. */
export function themeCode(value: string): ThemeCode | undefined {
  const folded = foldName(value);
  for (const [code, title] of Object.entries(THEMES)) {
    if (folded === code || folded === foldName(title)) return code as ThemeCode;
  }
  return undefined;
}

// ---- formats ---------------------------------------------------------------------------------

/** The EU file-type vocabulary, the spelling of most format values on GovData. */
export const EU_FILE_TYPE = "http://publications.europa.eu/resource/authority/file-type/";

/** Free-text and MIME spellings of a format, by what they mean. */
const FORMAT_ALIASES: Readonly<Record<string, string>> = {
  SHAPE: "SHP",
  SHAPEFILE: "SHP",
  SHAPEFILES: "SHP",
  "GEZIPPTE SHAPE": "SHP",
  "ESRI SHAPEFILE": "SHP",
  GEOPACKAGE: "GPKG",
  "APPLICATION/GEOPACKAGE+SQLITE3": "GPKG",
  JPG: "JPEG",
  "JSON-LD": "JSON_LD",
  "TEXT/CSV": "CSV",
  "APPLICATION/JSON": "JSON",
  "APPLICATION/GEO+JSON": "GEOJSON",
  "APPLICATION/VND.GEO+JSON": "GEOJSON",
  "APPLICATION/ZIP": "ZIP",
  "APPLICATION/PDF": "PDF",
  "APPLICATION/XML": "XML",
  "TEXT/XML": "XML",
  "TEXT/HTML": "HTML",
  "APPLICATION/VND.MS-EXCEL": "XLS",
  "APPLICATION/VND.OPENXMLFORMATS-OFFICEDOCUMENT.SPREADSHEETML.SHEET": "XLSX",
};

/** Values in the format field that name no format. */
const NOT_FORMATS = new Set(["DOWNLOAD", "LINK", "WEBSITE", "WEBSEITE", "DATEI", "FILE", "DATA", "DATEN"]);

/** Formats that are services, not files. */
export const SERVICE_FORMATS: ReadonlySet<string> = new Set(["WMS", "WFS", "WCS", "WMTS", "OAF", "ATOM", "CSW", "SOS", "WPS", "MQTT"]);

/**
 * A format value as one short name: the EU URI's tail (`…/file-type/CSV` is CSV), upper case, the
 * EU `_SRVC` suffix dropped (WMS_SRVC is WMS), free-text and MIME spellings mapped (Shapefiles is
 * SHP, text/csv is CSV). Undefined for a value that names no clear format: another vocabulary's
 * URI (`…file_media_type#ANY_OTHER_MEDIATYPE`), an unknown MIME type, a combined value
 * ("Shape, CSV"), a word like "Download".
 */
export function formatOf(raw: unknown): string | undefined {
  const text = textOf(raw);
  if (text === undefined) return undefined;
  let upper = text.toUpperCase();
  const alias = FORMAT_ALIASES[upper];
  if (alias !== undefined) return alias;
  if (/^HTTPS?:\/\//.test(upper)) {
    const media = /\/ASSIGNMENTS\/MEDIA-TYPES\/(.+)$/.exec(upper);
    if (media !== null) return FORMAT_ALIASES[media[1] as string];
    // ArcGIS Hub's DCAT feeds name the format at the end of their own URI (…/ftype/CSV).
    const arcgis = /\/FTYPE\/([A-Z0-9_]+)$/.exec(upper);
    if (arcgis !== null) return formatOf(arcgis[1]);
    if (!upper.startsWith(EU_FILE_TYPE.toUpperCase())) return undefined;
    upper = upper.slice(EU_FILE_TYPE.length);
  }
  upper = upper.replace(/_SRVC$/, "");
  const mapped = FORMAT_ALIASES[upper] ?? upper;
  if (!/^[A-Z0-9_]{1,12}$/.test(mapped) || NOT_FORMATS.has(mapped)) return undefined;
  return mapped;
}

/** A requested format as `formatOf` names it: letters, digits, `_`, `-` or `+`, at most 40 characters. */
function wantedFormat(value: string): string {
  const text = value.trim();
  const format = /^[A-Za-z0-9_+\-/.]{1,40}$/.test(text) ? formatOf(text) : undefined;
  if (format === undefined) {
    throw new GovDataValidationError(`Invalid format: expected a format name such as CSV, GEOJSON or SHP, got ${JSON.stringify(text.slice(0, 40))}.`);
  }
  return format;
}

/** The spellings GovData stores a format under (bare, lower case, the EU URI, aliases). */
export function formatSpellings(format: string): string[] {
  const spellings = new Set([format, format.toLowerCase(), `${EU_FILE_TYPE}${format}`]);
  if (SERVICE_FORMATS.has(format)) spellings.add(`${EU_FILE_TYPE}${format}_SRVC`);
  for (const [alias, meaning] of Object.entries(FORMAT_ALIASES)) {
    if (meaning !== format) continue;
    spellings.add(alias.includes("/") ? alias.toLowerCase() : alias.charAt(0) + alias.slice(1).toLowerCase());
  }
  if (format === "GEOJSON") spellings.add("GeoJSON");
  if (format === "GPKG") spellings.add("GeoPackage");
  return [...spellings];
}

/** The Solr filter for datasets with a file in `format`, in any of its spellings. */
export function formatFilter(format: string): string {
  return `res_format:(${formatSpellings(format).map(phrase).join(" OR ")})`;
}

// ---- licences --------------------------------------------------------------------------------

export interface Licence {
  /** As delivered. */
  uri: string;
  /** A short name: "DL-DE BY 2.0", "CC BY 4.0", or the URI's tail when the licence is not known (with the name before a bare version: "gpl 3.0"). */
  label: string;
  /** Whether it is an open licence; absent when the licence is not known. */
  open?: boolean;
}

/** The DCAT-AP.de licence vocabulary (http://dcat-ap.de/def/licenses/…), by id (`2_0` read as `2.0`). */
const DCAT_DE_LICENCES: Readonly<Record<string, [string, boolean]>> = {
  "dl-by-de/2.0": ["DL-DE BY 2.0", true],
  "dl-zero-de/2.0": ["DL-DE Zero 2.0", true],
  "dl-by-de/1.0": ["DL-DE BY 1.0", true],
  "dl-by-nc-de/1.0": ["DL-DE BY-NC 1.0", false],
  "cc-by/4.0": ["CC BY 4.0", true],
  "cc-by": ["CC BY", true],
  "cc-by-de/3.0": ["CC BY 3.0 DE", true],
  "cc-by-sa/4.0": ["CC BY-SA 4.0", true],
  "cc-by-sa": ["CC BY-SA", true],
  "cc-by-sa-de/3.0": ["CC BY-SA 3.0 DE", true],
  "cc-by-nd/4.0": ["CC BY-ND 4.0", false],
  "cc-by-nc/4.0": ["CC BY-NC 4.0", false],
  "cc-by-nc": ["CC BY-NC", false],
  "cc-zero": ["CC0 1.0", true],
  odbl: ["ODbL", true],
  "geonutz/20130319": ["GeoNutzV (Geodaten des Bundes)", true],
  "geonutz/20131001": ["GeoNutzV (Geodaten des Bundes)", true],
  "official-work": ["Amtliches Werk (§ 5 UrhG)", true],
  "other-closed": ["other, closed (not an open licence)", false],
  "other-open": ["other open licence", true],
  "other-opensource": ["other open-source licence", true],
  "other-freeware": ["freeware", false],
  "other-commercial": ["commercial", false],
};

/** A licence URI with a short name; undefined for an empty value. */
export function licenceOf(raw: unknown): Licence | undefined {
  const uri = textOf(raw);
  if (uri === undefined) return undefined;
  const lower = uri.toLowerCase().replace(/\/+$/, "");
  const dcat = /dcat-ap\.de\/def\/licenses\/(.+)$/.exec(lower);
  if (dcat !== null) {
    const id = (dcat[1] as string).replace(/_/g, ".");
    const known = DCAT_DE_LICENCES[id];
    if (known !== undefined) return { uri, label: known[0], open: known[1] };
    // The vocabulary's other Creative Commons ids: cc-by-nc-de/3.0, cc-by-nc-nd/4.0, cc-by-nd, …
    const cc = /^cc-(by(?:-(?:nc|nd|sa))*)(-de)?(?:\/(\d\.\d))?$/.exec(id);
    if (cc !== null) {
      const kind = cc[1] as string;
      return { uri, label: `CC ${kind.toUpperCase()}${cc[3] === undefined ? "" : ` ${cc[3]}`}${cc[2] === undefined ? "" : " DE"}`, open: !/nc|nd/.test(kind) };
    }
  }
  const govdata = /govdata\.de\/dl-de\/(by|zero|by-nc)-(\d)-(\d)$/.exec(lower);
  if (govdata !== null) {
    const label = `DL-DE ${govdata[1] === "zero" ? "Zero" : (govdata[1] as string).toUpperCase()} ${govdata[2]}.${govdata[3]}`;
    return { uri, label, open: govdata[1] !== "by-nc" };
  }
  const cc = /creativecommons\.org\/licenses\/([a-z-]+)\/(\d\.\d)/.exec(lower);
  if (cc !== null) {
    const kind = cc[1] as string;
    return { uri, label: `CC ${kind.toUpperCase()} ${cc[2]}`, open: !/nc|nd/.test(kind) };
  }
  if (/creativecommons\.org\/publicdomain\/zero\//.test(lower)) return { uri, label: "CC0 1.0", open: true };
  if (/creativecommons\.org\/publicdomain\/mark\//.test(lower)) return { uri, label: "Public Domain Mark", open: true };
  // The URI's tail; a bare version number (…/foo/1.0) with the name before it.
  const parts = uri.replace(/\/+$/, "").split(/[/#]/);
  const tail = parts.pop() ?? uri;
  const before = parts.pop();
  if (/^\d+(?:[._]\d+)*$/.test(tail) && before !== undefined && before !== "") return { uri, label: `${before} ${tail}` };
  return { uri, label: tail === "" ? uri : tail };
}

/** The distinct licences of `values`, in the order first seen. */
function distinctLicences(values: unknown[]): Licence[] {
  const seen = new Map<string, Licence>();
  for (const value of values) {
    const licence = licenceOf(value);
    if (licence !== undefined && !seen.has(licence.uri)) seen.set(licence.uri, licence);
  }
  return [...seen.values()];
}

// ---- links -----------------------------------------------------------------------------------

/**
 * What a resource's link is: `file` (a file name at the end), `generated` (a file built on request:
 * an export or download endpoint, a WFS GetFeature), `service` (a map or feature service, an OGC
 * API, a feed: not a file), `page` (a landing page), `api` (another API call), `template` (a
 * placeholder such as {yyyymm} or _yyyy. to fill in), `broken` (cut off by the harvester).
 */
export type LinkKind = "file" | "generated" | "service" | "page" | "api" | "template" | "broken";

/** The link with a percent-encoded query (`%3f`, as harvested) read as a query. */
function decodedLink(url: string): string {
  try {
    return decodeURI(url.replace(/%3f/gi, "?").replace(/%3d/gi, "=").replace(/%26/gi, "&"));
  } catch {
    return url;
  }
}

/** The extension at the end of a link's path (`.csv.gz` is CSV), upper case, or undefined. */
export function extensionOf(url: string): string | undefined {
  const path = decodedLink(url).split(/[?#]/)[0] ?? "";
  const match = /\.([a-z0-9]{2,8})(?:\.(?:gz|zip|bz2))?$/i.exec(path.split("/").pop() ?? "");
  if (match === null) return undefined;
  const ext = (match[1] as string).toUpperCase();
  return FORMAT_ALIASES[ext] ?? ext;
}

/** Whether the link carries a key or token in its query (as published). */
export function hasKeyInLink(url: string): boolean {
  return /[?&](api[-_]?key|apikey|token|access_token|key)=/i.test(decodedLink(url));
}

/** The kind of a resource's link (see LinkKind), from the link and its format. */
export function linkKind(url: string, format: string | undefined): LinkKind {
  const link = decodedLink(url);
  const [path = "", query = ""] = link.split(/\?/, 2);
  // A "{" with a "}" after it, found with indexOf: the regular expression `/\{[^}]*\}/` rescanned
  // the rest of a link full of "{" without "}" at every one (quadratic).
  const brace = url.indexOf("{");
  if ((brace !== -1 && url.indexOf("}", brace + 1) !== -1) || /%7b/i.test(url) || /(^|[_\-/.])(yyyy|yyyymm|yyyymmdd|jjjj|jjjjmm)([_\-/.]|$)/i.test(path)) return "template";
  // Cut off by the harvester: a resource link without its id, or with part of it.
  if (/\/resource\/[0-9a-f-]{1,35}$/i.test(path) || /\/dataset\/[^/]+\/(?:res|reso|resou|resour|resourc|resource)(?:-\d+)?$/i.test(path)) return "broken";
  if (/[?&]request=getfeature/i.test(`?${query}`)) return "generated";
  if (/(^|&)service=(wms|wfs|wcs|wmts|csw|sos|wps)(&|$)/i.test(query) || /(^|&)request=/i.test(query)) return "service";
  if (format !== undefined && SERVICE_FORMATS.has(format)) return "service";
  if (/\/dataset\/[^/]+\/resource\/[0-9a-f-]{36}$/i.test(path)) return "page";
  const ext = extensionOf(path);
  if (ext !== undefined) return /^(HTML?|PHP|ASPX?|JSP)$/.test(ext) ? "page" : "file";
  if (hasKeyInLink(url)) return "api";
  if (/\/(download|export|exports|dump)(\/|$)/i.test(path)) return "generated";
  if (path.endsWith("/") || format === "HTML") return "page";
  return query === "" ? "page" : "api";
}

/** The kinds of link a download can fetch. */
const FETCHABLE: ReadonlySet<LinkKind> = new Set(["file", "generated"]);

// ---- the shared filters ----------------------------------------------------------------------

export type DatasetSort = "relevance" | "modified" | "created" | "title";

const SORTS: Readonly<Record<DatasetSort, string | undefined>> = {
  relevance: undefined,
  modified: "metadata_modified desc",
  created: "metadata_created desc",
  title: "title_string asc",
};

/** What the dataset tools filter by. */
export interface DatasetFilters {
  /** Solr query: words, "phrases", AND/OR/NOT, field:value (title:Radverkehr). */
  query?: string | undefined;
  /** A catalogue organization (a Land's portal or a federal body), by slug or name. */
  organization?: string | undefined;
  /** The publishing body as the metadata name it ("Stadt Dortmund"): a phrase in publisher_name. */
  publisherName?: string | undefined;
  /** A theme, by code (tran) or German title (Verkehr). */
  theme?: string | undefined;
  /** Datasets with a file in this format, in any of its spellings (CSV, GEOJSON, SHP, …). */
  format?: string | undefined;
  /** Only datasets with at least one file (num_resources ≥ 1): metadata-only records left out. */
  withFiles?: boolean | undefined;
  /** Raw Solr filter queries, ANDed (each its own filter). */
  filters?: readonly string[] | undefined;
}

/** What a filtered search was given, as the answer repeats it. */
export type Searched = Record<string, JsonValue>;

/** An organization of the catalogue: its slug, its title, how many datasets it has. */
export interface OrganizationEntry {
  name: string;
  title: string;
  datasets: number;
}

/** Several organizations fit a name: the candidates, never a guess. */
export interface Ambiguity {
  field: string;
  value: string;
  candidates: OrganizationEntry[];
  total: number;
}

/** What every answer has. */
interface AnswerBase {
  status: "ok" | "empty" | "ambiguous";
  /** Why the answer is empty or ambiguous, and what to try. */
  reason?: string;
  searched: Searched;
  notes: string[];
  ambiguous?: Ambiguity;
}

/** The catalogue's organizations with their dataset counts (one facet request). */
async function organizationsOf(client: GovDataClient, trace: Trace): Promise<OrganizationEntry[]> {
  const result = await trace.search(client, { rows: 0, facet_field: ["organization"], facet_limit: -1 });
  return facetItems(result, "organization")
    .map((item) => ({ name: item.name, title: item.label ?? item.name, datasets: item.count }))
    .sort((a, b) => b.datasets - a.datasets || a.name.localeCompare(b.name));
}

/** The organizations that fit `value`: its slug or title exactly, else those containing it. */
function matchOrganizations(organizations: OrganizationEntry[], value: string): { exact: boolean; matches: OrganizationEntry[] } {
  const folded = foldName(value);
  const exact = organizations.filter((o) => o.name === folded || foldName(o.title) === folded);
  if (exact.length > 0) return { exact: true, matches: exact };
  return { exact: false, matches: organizations.filter((o) => o.name.includes(folded.replace(/ /g, "-")) || foldName(o.title).includes(folded)) };
}

/** The checks of the shared filters (before any request). */
function checkFilters(filters: DatasetFilters): { format?: string; theme?: ThemeCode } {
  const checked: { format?: string; theme?: ThemeCode } = {};
  if (filters.format !== undefined) checked.format = wantedFormat(filters.format);
  if (filters.theme !== undefined) {
    const code = themeCode(filters.theme);
    if (code === undefined) {
      throw new GovDataValidationError(`Invalid theme: ${JSON.stringify(filters.theme.slice(0, 80))} is none of the 13 themes (${Object.keys(THEMES).join(", ")}; or their German titles).`);
    }
    checked.theme = code;
  }
  for (const [name, value] of [["query", filters.query], ["organization", filters.organization], ["publisherName", filters.publisherName]] as const) {
    if (value !== undefined && value.trim() === "") throw new GovDataValidationError(`Invalid ${name}: expected a non-empty value.`);
  }
  return checked;
}

/**
 * The Solr filters for `filters`, the organization resolved by name (one request when one is
 * given); or the answer to give instead: empty (no such organization) or ambiguous (several).
 */
async function filterQueriesOf(
  client: GovDataClient,
  filters: DatasetFilters,
  trace: Trace,
): Promise<{ fq: string[]; searched: Searched; format?: string } | { answer: Pick<AnswerBase, "status" | "reason" | "ambiguous" | "searched"> }> {
  const checked = checkFilters(filters);
  const searched: Searched = {};
  const fq: string[] = [];
  if (filters.query !== undefined) searched["query"] = filters.query.trim();
  if (filters.organization !== undefined) {
    const value = filters.organization.trim();
    searched["organization"] = value;
    const { exact, matches } = matchOrganizations(await organizationsOf(client, trace), value);
    if (matches.length === 0) {
      return { answer: { status: "empty", searched, reason: `No organization of the catalogue is named ${JSON.stringify(value)}. listOrganizations lists them (Länder portals and federal bodies); a city or an office is usually not one: try publisherName.` } };
    }
    if (matches.length > 1) {
      return {
        answer: {
          status: "ambiguous",
          searched,
          reason: `${matches.length} organizations ${exact ? "are named" : "contain"} ${JSON.stringify(value)}: give one of the candidates' names.`,
          ambiguous: { field: "organization", value, candidates: matches.slice(0, 10), total: matches.length },
        },
      };
    }
    const match = matches[0] as OrganizationEntry;
    searched["organization"] = match.name;
    fq.push(`organization:${phrase(match.name)}`);
  }
  if (filters.publisherName !== undefined) {
    searched["publisherName"] = filters.publisherName.trim();
    fq.push(`extras_publisher_name:${phrase(filters.publisherName.trim())}`);
  }
  if (checked.theme !== undefined) {
    searched["theme"] = checked.theme;
    fq.push(`groups:${checked.theme}`);
  }
  if (checked.format !== undefined) {
    searched["format"] = checked.format;
    fq.push(formatFilter(checked.format));
  }
  if (filters.withFiles === true) {
    searched["withFiles"] = true;
    fq.push("num_resources:[1 TO *]");
  }
  if (filters.filters !== undefined && filters.filters.length > 0) {
    searched["filters"] = [...filters.filters];
    fq.push(...filters.filters);
  }
  return { fq, searched, ...(checked.format === undefined ? {} : { format: checked.format }) };
}

/** Throw unless `value` is undefined or an integer in [min, max]. */
function checkInteger(name: string, value: number | undefined, min: number, max: number): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new GovDataValidationError(`Invalid ${name}: expected an integer from ${min} to ${max}, got ${String(value)}.`);
  }
}

/** The most results a page may start after: CKAN reads further, but nobody pages that far. */
export const MAX_OFFSET = 100_000;

// ---- findDatasets ----------------------------------------------------------------------------

export const DEFAULT_DATASETS = 10;
export const MAX_DATASETS = 50;

export interface FindDatasetsParams extends DatasetFilters {
  sort?: DatasetSort | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
}

/** One dataset of a search, with what decides its reuse. */
export interface DatasetHit {
  /** The slug, for getDataset and listFiles. */
  name: string;
  title?: string;
  /** The catalogue organization (often the Land's portal that harvested it). */
  organization?: { name: string; title?: string };
  /** The publishing body, as the metadata name it. */
  publisher?: string;
  description?: string;
  /** When the catalogue record last changed (metadata_modified). */
  modified?: string;
  /** When the catalogue record was created (metadata_created). */
  created?: string;
  /** How many files (resources) it has; 0 is a metadata-only record. */
  files: number;
  /** The formats of its files, folded (CSV, not the EU URI). */
  formats: string[];
  /** The licences its files carry (and the dataset's own when no file names one). */
  licences: Licence[];
  /** Theme codes. */
  themes: string[];
  /** With a format filter: whether a file of it is there (the filter matches the dataset). */
  hasFormat?: boolean;
}

export interface FindDatasetsAnswer extends AnswerBase {
  total: number;
  offset: number;
  datasets: DatasetHit[];
  nextOffset?: number;
}

/** A search result as a hit: formats folded, licences from the files. */
function hitOf(dataset: JsonObject, format: string | undefined): DatasetHit {
  const resources = objectsOf(dataset["resources"]);
  const extras = extrasOf(dataset);
  const organization = isObject(dataset["organization"]) ? dataset["organization"] : undefined;
  const formats = [...new Set(resources.map((r) => formatOf(r["format"])).filter((f): f is string => f !== undefined))];
  let licences = distinctLicences(resources.map((r) => r["license"]));
  if (licences.length === 0) licences = distinctLicences([dataset["license_id"]]);
  const count = typeof dataset["num_resources"] === "number" ? dataset["num_resources"] : resources.length;
  const hit: DatasetHit = {
    name: textOf(dataset["name"]) ?? textOf(dataset["id"]) ?? "",
    files: count,
    formats,
    licences,
    themes: objectsOf(dataset["groups"]).map((g) => textOf(g["name"])).filter((g): g is string => g !== undefined),
  };
  const title = textOf(dataset["title"]);
  if (title !== undefined) hit.title = title;
  const orgName = organization === undefined ? undefined : textOf(organization["name"]);
  if (orgName !== undefined) {
    const orgTitle = textOf(organization?.["title"]);
    hit.organization = orgTitle === undefined ? { name: orgName } : { name: orgName, title: orgTitle };
  }
  const publisher = extras.get("publisher_name");
  if (publisher !== undefined) hit.publisher = publisher;
  const description = plainText(textOf(dataset["notes"]), 300);
  if (description !== undefined) hit.description = description;
  const modified = textOf(dataset["metadata_modified"]);
  if (modified !== undefined) hit.modified = modified;
  const created = textOf(dataset["metadata_created"]);
  if (created !== undefined) hit.created = created;
  if (format !== undefined) hit.hasFormat = formats.includes(format) || resources.some((r) => typeof r["url"] === "string" && extensionOf(r["url"]) === format);
  return hit;
}

/**
 * Datasets for a topic and filters, a page at a time (`total` counts all matches: read it, never
 * page to count). Each hit names its formats folded and the licences its files carry: the
 * dataset-level licence field is empty for most of GovData. The notes say which hits are
 * metadata-only and which titles repeat (yearly editions, a dataset harvested twice).
 */
export async function findDatasets(client: GovDataClient, params: FindDatasetsParams = {}): Promise<FindDatasetsAnswer> {
  checkInteger("offset", params.offset, 0, MAX_OFFSET);
  checkInteger("limit", params.limit, 1, MAX_DATASETS);
  const sort = params.sort ?? "relevance";
  if (!(sort in SORTS)) throw new GovDataValidationError(`Invalid sort: expected one of ${Object.keys(SORTS).join(", ")}, got ${JSON.stringify(String(sort))}.`);
  const offset = params.offset ?? 0;
  const limit = params.limit ?? DEFAULT_DATASETS;
  const trace = new Trace();
  const filters = await filterQueriesOf(client, params, trace);
  if ("answer" in filters) return trace.done({ ...filters.answer, notes: [], total: 0, offset, datasets: [] });
  const searched = { ...filters.searched, ...(sort === "relevance" ? {} : { sort }) };
  const result = await trace.search(client, { q: params.query?.trim(), fq: filters.fq, rows: limit, start: offset, sort: SORTS[sort] });
  const datasets = result.results.filter(isObject).map((d) => hitOf(d, filters.format));
  const answer: FindDatasetsAnswer = { status: "ok", total: result.count, offset, datasets, searched, notes: [] };
  if (result.count === 0) {
    answer.status = "empty";
    answer.reason = "No dataset matches. Try fewer or broader words (Solr matches whole words: Radverkehr, not Rad), fewer filters, or a theme instead of words.";
  } else if (datasets.length === 0) {
    answer.status = "empty";
    answer.reason = `The page at offset ${offset} is past the end: ${result.count} datasets match.`;
  }
  if (offset + datasets.length < result.count && datasets.length > 0) answer.nextOffset = offset + datasets.length;
  const stubs = datasets.filter((d) => d.files === 0).length;
  if (stubs > 0) answer.notes.push(`${stubs} of these datasets have no files (metadata only); withFiles leaves such datasets out.`);
  const titles = new Map<string, number>();
  for (const d of datasets) if (d.title !== undefined) titles.set(foldName(d.title), (titles.get(foldName(d.title)) ?? 0) + 1);
  const repeated = datasets.filter((d, i) => d.title !== undefined && (titles.get(foldName(d.title)) ?? 0) > 1 && datasets.findIndex((e) => e.title !== undefined && foldName(e.title) === foldName(d.title as string)) === i);
  if (repeated.length > 0) {
    answer.notes.push(`Titles on this page more than once (editions, or one dataset harvested by two portals): ${repeated.map((d) => JSON.stringify(d.title)).join(", ")}. Group them when presenting.`);
  }
  if (datasets.some((d) => d.licences.length === 0)) answer.notes.push("A dataset with licences [] states no licence on its files or itself: say so, never assume one.");
  return trace.done(answer);
}

// ---- countDatasets ---------------------------------------------------------------------------

/** The distributions countDatasets counts, by name, with CKAN's facet field. */
export const FACETS = Object.freeze({
  organization: "organization",
  format: "res_format",
  licence: "license_id",
  theme: "groups",
  tag: "tags",
});
export type FacetName = keyof typeof FACETS;

/** Facets whose values are folded (several spellings of one value): all values are read. */
const FOLDED: ReadonlySet<FacetName> = new Set(["format", "licence"]);

export const DEFAULT_FACET_VALUES = 10;
/** The most raw spellings a folded value lists (one ArcGIS hub URI per portal adds up). */
export const MAX_VARIANTS = 10;
export const MAX_FACET_VALUES = 100;

export interface CountDatasetsParams extends DatasetFilters {
  facets?: readonly FacetName[] | undefined;
  /** Values per facet. */
  limit?: number | undefined;
}

export interface FacetValue {
  /** The value to filter by (a slug, a theme code, a format, a licence's short name, a tag). */
  value: string;
  /** The readable name, where it differs (an organization's or a theme's title). */
  label?: string;
  /** Datasets, not files: a dataset with ten CSV files counts once for CSV. */
  count: number;
  /** The raw values folded into this one (the MAX_VARIANTS largest). */
  variants?: string[];
  /** How many more raw values were folded into this one than `variants` lists. */
  moreVariants?: number;
  /** The count is a sum over several spellings: a dataset with two of them counts twice. */
  upperBound?: boolean;
}

export interface FacetCounts {
  facet: FacetName;
  values: FacetValue[];
  /** False when there are more values than listed. */
  complete: boolean;
  /** Format values that name no clear format (MIME types, other vocabularies, combined values). */
  other?: { count: number; variants: string[] };
}

export interface CountDatasetsAnswer extends AnswerBase {
  total: number;
  facets: FacetCounts[];
}

interface FacetItem {
  name: string;
  label?: string;
  count: number;
}

/** A facet's items from a search result (`search_facets.<field>.items`), zero counts dropped. */
function facetItems(result: PackageSearchResult, field: string): FacetItem[] {
  const facets = isObject(result.search_facets) ? result.search_facets : {};
  const facet = facets[field];
  const items = isObject(facet) ? objectsOf(facet["items"]) : [];
  const out: FacetItem[] = [];
  for (const item of items) {
    const name = typeof item["name"] === "string" ? item["name"] : undefined;
    const count = item["count"];
    if (name === undefined || typeof count !== "number" || count <= 0) continue;
    const label = textOf(item["display_name"]);
    out.push(label === undefined || label === name ? { name, count } : { name, label, count });
  }
  return out;
}

const byCount = (a: FacetValue, b: FacetValue): number => b.count - a.count || a.value.localeCompare(b.value);

/** The values of one facet: sorted by count (CKAN doesn't), folded where spellings differ, cut at `limit`. */
function countsOf(facet: FacetName, items: FacetItem[], limit: number): FacetCounts {
  if (!FOLDED.has(facet)) {
    const values = items
      .map((item) => {
        const value: FacetValue = { value: item.name, count: item.count };
        const label = facet === "theme" ? (item.label ?? THEMES[item.name as ThemeCode]) : item.label;
        if (label !== undefined && label !== item.name) value.label = label;
        return value;
      })
      .sort(byCount);
    return { facet, values: values.slice(0, limit), complete: values.length <= limit };
  }
  const groups = new Map<string, FacetValue>();
  const other: { count: number; variants: string[] } = { count: 0, variants: [] };
  for (const item of [...items].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))) {
    const key =
      facet === "format"
        ? formatOf(item.name)
        : (licenceOf(item.name)?.label ?? (item.label ?? item.name).replace(/\s*\(ältere DCAT-AP\.de Version\)\s*$/, ""));
    if (key === undefined) {
      other.count += item.count;
      if (other.variants.length < MAX_VARIANTS) other.variants.push(item.name);
      continue;
    }
    const group = groups.get(key) ?? { value: key, count: 0, variants: [] };
    group.count += item.count;
    group.variants?.push(item.name);
    groups.set(key, group);
  }
  const values = [...groups.values()]
    .map((group) => {
      const variants = group.variants ?? [];
      const value: FacetValue = { value: group.value, count: group.count };
      if (variants.length > 1) {
        value.variants = variants.slice(0, MAX_VARIANTS);
        if (variants.length > MAX_VARIANTS) value.moreVariants = variants.length - MAX_VARIANTS;
        value.upperBound = true;
      } else if (variants[0] !== group.value) {
        value.variants = variants;
      }
      return value;
    })
    .sort(byCount);
  const counts: FacetCounts = { facet, values: values.slice(0, limit), complete: values.length <= limit };
  if (facet === "format" && other.count > 0) counts.other = other;
  return counts;
}

/**
 * How many datasets match, and how they spread over the facets asked for (no datasets fetched).
 * The values are sorted by count (CKAN sends them unsorted); a format's two spellings (CSV and the
 * EU URI) and a licence's variants (2.0 and 2_0, the older DCAT-AP.de version) are folded into one
 * value, their sum an upper bound; every value of those two is read, so nothing is cut before
 * folding. For the others, complete false says there are more values than listed.
 */
export async function countDatasets(client: GovDataClient, params: CountDatasetsParams = {}): Promise<CountDatasetsAnswer> {
  checkInteger("limit", params.limit, 1, MAX_FACET_VALUES);
  const limit = params.limit ?? DEFAULT_FACET_VALUES;
  const facets = [...new Set(params.facets ?? [])];
  for (const facet of facets) {
    if (!(facet in FACETS)) throw new GovDataValidationError(`Invalid facet: expected one of ${Object.keys(FACETS).join(", ")}, got ${JSON.stringify(String(facet))}.`);
  }
  const trace = new Trace();
  const filters = await filterQueriesOf(client, params, trace);
  if ("answer" in filters) return trace.done({ ...filters.answer, notes: [], total: 0, facets: [] });
  const searched: Searched = { ...filters.searched, ...(facets.length > 0 ? { facets } : {}) };
  const base = { q: params.query?.trim(), fq: filters.fq, rows: 0 };
  const folded = facets.filter((f) => FOLDED.has(f));
  const plain = facets.filter((f) => !FOLDED.has(f));
  const results = new Map<FacetName, PackageSearchResult>();
  let total: number | undefined;
  // Folded facets need every value (a cut list can lose one spelling); the others limit + 1, to
  // tell a complete list from a cut one. CKAN takes one facet.limit per request.
  for (const group of [folded, plain]) {
    if (group.length === 0) continue;
    const result = await trace.search(client, { ...base, facet_field: group.map((f) => FACETS[f]), facet_limit: group === folded ? -1 : limit + 1 });
    total ??= result.count;
    for (const facet of group) results.set(facet, result);
  }
  if (total === undefined) total = (await trace.search(client, base)).count;
  const answer: CountDatasetsAnswer = {
    status: total === 0 ? "empty" : "ok",
    total,
    facets: facets.map((facet) => countsOf(facet, facetItems(results.get(facet) as PackageSearchResult, FACETS[facet]), limit)),
    searched,
    notes: [],
  };
  if (total === 0) answer.reason = "No dataset matches. Try fewer or broader words, or fewer filters.";
  if (facets.length > 0 && total > 0) answer.notes.push("Counts are datasets, not files. One dataset can carry several values, so the counts don't add up to total.");
  if (facets.includes("format") && answer.facets.some((f) => f.values.some((v) => v.upperBound === true))) {
    answer.notes.push("A format with upperBound sums its spellings (CSV and the EU URI); a dataset with both counts twice. For an exact count, count again with format set: total is exact.");
  }
  if (facets.includes("licence") && total > 0) {
    // A dataset has one dataset-level licence (license_id), so the sum over every value read
    // (all of them: the facet is read whole) counts each dataset with one exactly once.
    const withLicence = facetItems(results.get("licence") as PackageSearchResult, FACETS.licence).reduce((sum, item) => sum + item.count, 0);
    answer.notes.push(`The licence facet counts the dataset-level licence, which only ${Math.min(withLicence, total)} of ${total} datasets carry; most state theirs on each file (findDatasets and listFiles read those).`);
  }
  return trace.done(answer);
}

// ---- listFiles -------------------------------------------------------------------------------

export const DEFAULT_FILE_DATASETS = 20;
export const MAX_FILE_DATASETS = 50;

export interface ListFilesParams extends DatasetFilters {
  /** Keep map and feature services (WMS, WFS, OGC API, feeds) in the list. */
  includeServices?: boolean | undefined;
  sort?: DatasetSort | undefined;
  /** Datasets to skip. */
  offset?: number | undefined;
  /** Datasets to scan. */
  limit?: number | undefined;
}

/** One file (distribution) of a dataset. */
export interface FileEntry {
  name?: string;
  /** Folded (CSV), or as delivered when it names no clear format. */
  format?: string;
  url: string;
  kind: LinkKind;
  /** The file name's extension, when it differs from the format (an .xlsx labelled XLS). */
  extension?: string;
  /** Bytes, when the metadata say. */
  size?: number;
  licence?: Licence;
  /** The attribution text the publisher asks for (licenseAttributionByText). */
  attribution?: string;
  modified?: string;
  /** The link carries someone's key or token in its query, as published. */
  keyInLink?: true;
}

export interface DatasetFiles {
  name: string;
  title?: string;
  organization?: string;
  publisher?: string;
  files: FileEntry[];
}

export interface ListFilesAnswer extends AnswerBase {
  /** Datasets matching (all pages). */
  total: number;
  offset: number;
  /** Datasets read for this page. */
  datasetsScanned: number;
  datasets: DatasetFiles[];
  counts: { files: number; fetchable: number; knownBytes: number; sizeUnknown: number };
  skipped: { noUrl: number; services: number; otherFormat: number; duplicates: number; datasetsWithoutFiles: number };
  nextOffset?: number;
}

/** A resource as a file entry, or why it is skipped. */
function fileOf(resource: JsonObject): FileEntry | "noUrl" {
  const url = textOf(resource["url"]) ?? textOf(resource["download_url"]) ?? textOf(resource["access_url"]);
  if (url === undefined) return "noUrl";
  const rawFormat = textOf(resource["format"]);
  const format = formatOf(rawFormat);
  const entry: FileEntry = { url, kind: linkKind(url, format) };
  const name = textOf(resource["name"]) ?? textOf(resource["description"]);
  if (name !== undefined) entry.name = excerpt(name, 200) as string;
  const shown = format ?? rawFormat;
  if (shown !== undefined) entry.format = excerpt(shown, 100) as string;
  const extension = entry.kind === "file" ? extensionOf(url) : undefined;
  if (extension !== undefined && format !== undefined && extension !== format) entry.extension = extension;
  const size = resource["size"];
  if (typeof size === "number" && Number.isSafeInteger(size) && size > 0) entry.size = size;
  const licence = licenceOf(resource["license"]);
  if (licence !== undefined) entry.licence = licence;
  const attribution = plainText(textOf(resource["licenseAttributionByText"]));
  if (attribution !== undefined) entry.attribution = attribution;
  const modified = textOf(resource["modified"]) ?? textOf(resource["last_modified"]);
  if (modified !== undefined) entry.modified = modified;
  if (hasKeyInLink(url)) entry.keyInLink = true;
  return entry;
}

/**
 * The files of the matching datasets as a manifest, grouped by dataset, a page of datasets at a
 * time: each link with its kind (only `file` and `generated` are fetchable), its format folded, its
 * own licence and attribution (one dataset can mix open and closed files). With a format, only
 * files of it (by format or by file extension; the dataset search matches both spellings). Map and
 * feature services are left out unless asked for; links without a URL and repeated links are
 * counted, not listed. Nothing is downloaded.
 */
export async function listFiles(client: GovDataClient, params: ListFilesParams = {}): Promise<ListFilesAnswer> {
  checkInteger("offset", params.offset, 0, MAX_OFFSET);
  checkInteger("limit", params.limit, 1, MAX_FILE_DATASETS);
  const sort = params.sort ?? "relevance";
  if (!(sort in SORTS)) throw new GovDataValidationError(`Invalid sort: expected one of ${Object.keys(SORTS).join(", ")}, got ${JSON.stringify(String(sort))}.`);
  const offset = params.offset ?? 0;
  const limit = params.limit ?? DEFAULT_FILE_DATASETS;
  const trace = new Trace();
  const counts = { files: 0, fetchable: 0, knownBytes: 0, sizeUnknown: 0 };
  const skipped = { noUrl: 0, services: 0, otherFormat: 0, duplicates: 0, datasetsWithoutFiles: 0 };
  const filters = await filterQueriesOf(client, params, trace);
  if ("answer" in filters) return trace.done({ ...filters.answer, notes: [], total: 0, offset, datasetsScanned: 0, datasets: [], counts, skipped });
  const searched: Searched = { ...filters.searched, ...(params.includeServices === true ? { includeServices: true } : {}), ...(sort === "relevance" ? {} : { sort }) };
  const result = await trace.search(client, { q: params.query?.trim(), fq: filters.fq, rows: limit, start: offset, sort: SORTS[sort] });
  const seen = new Set<string>();
  const datasets: DatasetFiles[] = [];
  const kinds = new Map<LinkKind, number>();
  let keys = 0;
  const scanned = result.results.filter(isObject);
  for (const dataset of scanned) {
    const files: FileEntry[] = [];
    for (const resource of objectsOf(dataset["resources"])) {
      const file = fileOf(resource);
      if (file === "noUrl") {
        skipped.noUrl++;
        continue;
      }
      if (filters.format !== undefined && file.format !== filters.format && extensionOf(file.url) !== filters.format) {
        skipped.otherFormat++;
        continue;
      }
      if (file.kind === "service" && params.includeServices !== true) {
        skipped.services++;
        continue;
      }
      if (seen.has(file.url)) {
        skipped.duplicates++;
        continue;
      }
      seen.add(file.url);
      files.push(file);
      counts.files++;
      if (FETCHABLE.has(file.kind)) counts.fetchable++;
      if (file.size === undefined) counts.sizeUnknown++;
      else counts.knownBytes += file.size;
      kinds.set(file.kind, (kinds.get(file.kind) ?? 0) + 1);
      if (file.keyInLink === true) keys++;
    }
    if (files.length === 0) {
      skipped.datasetsWithoutFiles++;
      continue;
    }
    const entry: DatasetFiles = { name: textOf(dataset["name"]) ?? textOf(dataset["id"]) ?? "", files };
    const title = textOf(dataset["title"]);
    if (title !== undefined) entry.title = title;
    const organization = isObject(dataset["organization"]) ? textOf(dataset["organization"]["title"]) : undefined;
    if (organization !== undefined) entry.organization = organization;
    const publisher = extrasOf(dataset).get("publisher_name");
    if (publisher !== undefined) entry.publisher = publisher;
    datasets.push(entry);
  }
  const answer: ListFilesAnswer = { status: "ok", total: result.count, offset, datasetsScanned: scanned.length, datasets, counts, skipped, searched, notes: [] };
  if (offset + scanned.length < result.count && scanned.length > 0) answer.nextOffset = offset + scanned.length;
  if (result.count === 0) {
    answer.status = "empty";
    answer.reason = "No dataset matches. Try fewer or broader words, or fewer filters.";
  } else if (scanned.length === 0) {
    answer.status = "empty";
    answer.reason = `The page at offset ${offset} is past the end: ${result.count} datasets match.`;
  } else if (datasets.length === 0) {
    answer.status = "empty";
    answer.reason = `None of the ${scanned.length} datasets scanned has a file${filters.format === undefined ? "" : ` in ${filters.format}`}${params.includeServices === true ? "" : " (services left out)"}${answer.nextOffset === undefined ? "" : "; the next page may"}.`;
  }
  const odd = (["template", "broken", "page", "api"] as const).filter((kind) => (kinds.get(kind) ?? 0) > 0);
  if (odd.length > 0) {
    answer.notes.push(`Not every link is a file: ${odd.map((kind) => `${kinds.get(kind)} ${kind}`).join(", ")}. Only kind file and generated can be fetched; name the others as what they are.`);
  }
  if (keys > 0) answer.notes.push(`${keys} link(s) carry someone's key or token in the query, as the publisher published them (keyInLink).`);
  if (datasets.length > 0) answer.notes.push("Full-text search matches loosely: check each dataset's title before harvesting it, and drop the off-topic ones, saying which.");
  return trace.done(answer);
}

// ---- getDataset ------------------------------------------------------------------------------

/** A dataset's slug or id from itself or a link to its page (…/dataset/NAME, …/suche/daten/NAME). */
export function datasetIdFrom(value: string): string {
  const text = value.trim();
  const link = /^https?:\/\/[^/]+\/(?:[^?#]*\/)?(?:dataset|daten)\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(text);
  if (link === null) return text;
  try {
    return decodeURIComponent(link[1] as string);
  } catch {
    return link[1] as string;
  }
}

export interface DatasetRecord {
  name: string;
  id?: string;
  title?: string;
  description?: string;
  organization?: { name: string; title?: string };
  publisher?: { name?: string; email?: string; url?: string };
  contact?: { name?: string; email?: string };
  themes: { code: string; title?: string }[];
  tags: string[];
  /** When the catalogue record changed (metadata_modified), and when the publisher says the data did. */
  modified?: string;
  sourceModified?: string;
  issued?: string;
  /** The publisher's page for it. */
  landingPage?: string;
  /** The portal GovData harvested it from. */
  harvestedFrom?: string;
  accessRights?: string;
  /** The dataset-level licence (empty for most datasets). */
  licence?: Licence;
  /** The distinct licences of its files. */
  licences: Licence[];
  files: (FileEntry & { id?: string })[];
}

export interface GetDatasetAnswer extends Omit<AnswerBase, "ambiguous"> {
  dataset?: DatasetRecord;
}

/**
 * Whether CKAN answered "no such dataset": its `Not Found Error` envelope, with HTTP 404 or 200.
 * Another 404 (a proxy's or outage page, a base URL with the API path twice) is not an answer about
 * the dataset, and stays an error.
 */
function isNotFound(err: unknown): boolean {
  return (err instanceof GovDataApiError && err.status === 404 && err.detail?.startsWith("Not Found Error:") === true) || (err instanceof GovDataActionError && err.errorType === "Not Found Error");
}

/**
 * One dataset's record by its slug, id or the link to its page: the publisher and contact, themes
 * and tags, dates, where it was harvested from, and every file with its kind, format, licence and
 * attribution. An unknown id is an empty answer that says where to take one from.
 */
export async function getDataset(client: GovDataClient, params: { id: string }): Promise<GetDatasetAnswer> {
  if (typeof params.id !== "string" || params.id.trim() === "") throw new GovDataValidationError("Invalid id: expected a dataset's name, id or the link to its page.");
  const id = datasetIdFrom(params.id);
  const trace = new Trace();
  const searched: Searched = { id };
  trace.requests.push(actionRequest("package_show", { id }));
  let dataset: JsonObject;
  try {
    dataset = await client.packageShow(id);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    return trace.done({ status: "empty", searched, notes: [], reason: `No dataset is named ${JSON.stringify(id)}. Take the name (the slug) from a fresh findDatasets answer; titles are not names.` });
  }
  const extras = extrasOf(dataset);
  const organization = isObject(dataset["organization"]) ? dataset["organization"] : undefined;
  const files = objectsOf(dataset["resources"]).flatMap((resource) => {
    const file = fileOf(resource);
    if (file === "noUrl") return [];
    const rid = textOf(resource["id"]);
    return [rid === undefined ? file : { id: rid, ...file }];
  });
  const record: DatasetRecord = {
    name: textOf(dataset["name"]) ?? id,
    themes: objectsOf(dataset["groups"]).flatMap((g) => {
      const code = textOf(g["name"]);
      if (code === undefined) return [];
      const title = textOf(g["title"]) ?? THEMES[code as ThemeCode];
      return [title === undefined ? { code } : { code, title }];
    }),
    tags: objectsOf(dataset["tags"]).map((t) => textOf(t["name"])).filter((t): t is string => t !== undefined),
    licences: distinctLicences(files.map((f) => f.licence?.uri)),
    files,
  };
  const set = <K extends keyof DatasetRecord>(key: K, value: DatasetRecord[K] | undefined): void => {
    if (value !== undefined) record[key] = value;
  };
  set("id", textOf(dataset["id"]));
  set("title", textOf(dataset["title"]));
  set("description", plainText(textOf(dataset["notes"]), 5000));
  const orgName = organization === undefined ? undefined : textOf(organization["name"]);
  if (orgName !== undefined) {
    const orgTitle = textOf(organization?.["title"]);
    record.organization = orgTitle === undefined ? { name: orgName } : { name: orgName, title: orgTitle };
  }
  const publisher = Object.fromEntries(
    [["name", extras.get("publisher_name")], ["email", extras.get("publisher_email")], ["url", extras.get("publisher_url")]].filter((e) => e[1] !== undefined),
  );
  if (Object.keys(publisher).length > 0) record.publisher = publisher;
  const contact = Object.fromEntries(
    [["name", extras.get("contact_name") ?? textOf(dataset["maintainer"])], ["email", extras.get("contact_email") ?? textOf(dataset["maintainer_email"])]].filter((e) => e[1] !== undefined),
  );
  if (Object.keys(contact).length > 0) record.contact = contact;
  set("modified", textOf(dataset["metadata_modified"]));
  set("sourceModified", extras.get("modified"));
  set("issued", extras.get("issued"));
  set("landingPage", textOf(dataset["url"]) ?? extras.get("metadata_original_html"));
  set("harvestedFrom", extras.get("metadata_harvested_portal"));
  set("accessRights", extras.get("access_rights"));
  set("licence", licenceOf(dataset["license_id"]));
  const answer: GetDatasetAnswer = { status: "ok", dataset: record, searched, notes: [] };
  if (files.length === 0) answer.notes.push("This dataset has no files with a link (metadata only): see landingPage.");
  else if (record.licences.length === 0) answer.notes.push("No file states a licence: say so, never assume one; the publisher's page may.");
  else if (record.licences.length > 1) answer.notes.push("The files carry different licences: give each file's own.");
  return trace.done(answer);
}

// ---- listOrganizations -----------------------------------------------------------------------

export interface ListOrganizationsAnswer extends Omit<AnswerBase, "ambiguous"> {
  /** Organizations in the catalogue (all, not only those listed). */
  total: number;
  organizations: OrganizationEntry[];
}

/**
 * The catalogue's organizations (the Länder portals that harvest their cities' data, and federal
 * bodies), most datasets first, with their slugs for the organization filter; with a name, those
 * whose slug or title contains it.
 */
export async function listOrganizations(client: GovDataClient, params: { name?: string | undefined } = {}): Promise<ListOrganizationsAnswer> {
  if (params.name !== undefined && params.name.trim() === "") throw new GovDataValidationError("Invalid name: expected a non-empty value.");
  const trace = new Trace();
  const all = await organizationsOf(client, trace);
  const searched: Searched = params.name === undefined ? {} : { name: params.name.trim() };
  const organizations = params.name === undefined ? all : matchOrganizations(all, params.name).matches;
  const answer: ListOrganizationsAnswer = { status: "ok", total: all.length, organizations, searched, notes: [] };
  if (organizations.length === 0) {
    answer.status = "empty";
    answer.reason = `No organization is named or contains ${JSON.stringify(params.name?.trim())}. Cities and offices usually publish through their Land's portal: search with publisherName instead.`;
  }
  return trace.done(answer);
}
