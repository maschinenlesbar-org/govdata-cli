// Input rules of the library, as pure functions. Each `…Problem` function returns
// the reason a value is invalid, or `undefined` when it is valid. Client methods
// enforce them with `assertValid` before any request; the CLI's value parsers call
// the same functions, so a rule is written once and the CLI and the library agree.

import { GovDataValidationError, cutForMessage, quoteValue } from "./errors.js";

/** A rule: the reason `value` is invalid (one sentence), or `undefined` when it is valid. */
export type Problem<T = unknown> = (value: T) => string | undefined;

/**
 * Throw `GovDataValidationError("Invalid <name>: <reason>")` when `problem` finds
 * something wrong with `value`; otherwise return `value` unchanged. A method that
 * returns a promise calls this inside its async body, so a bad input rejects
 * rather than throwing synchronously.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) throw new GovDataValidationError(`Invalid ${name}: ${reason}`);
  return value;
}

/** Characters that never make a value non-blank: whitespace, controls, format characters, combining marks. */
const INVISIBLE = /[\s\p{Cc}\p{Cf}\p{M}]/gu;

/** A lone surrogate: half of a character, which the query string would send as U+FFFD. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * True when nothing in `value` would match anything: it holds only whitespace, control and
 * format characters (a zero-width space, a soft hyphen) and combining marks. CKAN reads an
 * empty parameter as "not given", and such a value matches nothing, so it is refused as blank.
 */
export function isBlank(value: string): boolean {
  return value.replace(INVISIBLE, "") === "";
}

/** `U+200B` for the first character of `text` that `pattern` matches. */
function codePointOf(text: string, pattern: RegExp): string {
  const ch = pattern.exec(text)?.[0] ?? "";
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** A control character inside a text value: C0 and C1, but not TAB, LF or CR (whitespace in a pasted phrase). */
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/** A format character inside a text value, but not ZWNJ/ZWJ (U+200C/U+200D), which some scripts and emoji need. */
const TEXT_FORMAT = /(?![\u200c\u200d])\p{Cf}/u;

/**
 * Why `value` cannot be sent as a text value (the search text `q`, the tag query, a Solr filter,
 * an `action()` parameter value), or undefined when it can. Refused, before any request, as
 * GovData would match nothing or everything:
 * - a value that is not a string, or is blank (`isBlank`): CKAN reads an empty parameter as
 *   "no filter";
 * - a lone surrogate (half of a character, sent as U+FFFD);
 * - a control character (but TAB, LF and CR) or a format character (a zero-width space, a soft
 *   hyphen, a bidi control; ZWNJ and ZWJ are allowed): pasted along, it makes the search find
 *   nothing, or something else (Solr splits a word at a zero-width space).
 * The reason quotes the value with every invisible character escaped (`quoteValue`).
 */
export function textProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  if (LONE_SURROGATE.test(value)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TEXT_CONTROL.test(value)) return `${quoteValue(value)} contains a control character (${codePointOf(value, TEXT_CONTROL)}).`;
  if (TEXT_FORMAT.test(value)) return `${quoteValue(value)} contains an invisible character (${codePointOf(value, TEXT_FORMAT)}).`;
  return undefined;
}

/**
 * A free-text value as CKAN matches it: without surrounding whitespace (a value pasted
 * with a trailing space matched nothing) and in composed Unicode, NFC (a decomposed
 * "Gewässer", a plus U+0308 as pasted from a macOS file name, matched nothing the
 * composed form matches: `--fq "title:Gewässer"` found 112 datasets live, the decomposed
 * spelling 0). Inner whitespace is kept. Used for every text value (`q`, the tag query, Solr
 * filters, `action()` parameter values); tokens go through `normalizeToken`. NFC changes no
 * character of Solr's query syntax (all ASCII), so a query keeps its meaning; NFKC is not used,
 * because it would rewrite characters (`ﬁ` to `fi`, full-width forms) that a phrase or a
 * wildcard may mean literally.
 */
export function normalizeText(value: string): string {
  return value.trim().normalize("NFC");
}

/** A control or format character in a token (after trimming): every Cc and every Cf. */
const TOKEN_INVISIBLE = /[\p{Cc}\p{Cf}]/u;

/**
 * Why `value` cannot be sent as a token, or undefined when it can. A token is an id, a name, a
 * field name or a sort expression: a value CKAN compares exactly. The rules apply to the value
 * with surrounding whitespace trimmed, as it is sent ({@link normalizeToken}): not blank (and not
 * only invisible characters or combining marks), no lone surrogate, and no control or format
 * character at all (a zero-width space, ZWJ, a soft hyphen, a bidi control), since an invisible
 * character in an id or a field name only ever makes it match nothing. The reason quotes the
 * value visibly.
 */
export function tokenProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  const token = value.trim();
  if (LONE_SURROGATE.test(token)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TOKEN_INVISIBLE.test(token)) {
    return `${quoteValue(value)} contains an invisible or control character (${codePointOf(token, TOKEN_INVISIBLE)}).`;
  }
  return undefined;
}

/**
 * A token as it is sent: trimmed and in composed Unicode (NFC). A pasted id with a trailing
 * space or newline read as "not found" (`package " haushalt "` exited 4 live for an existing
 * dataset). Check it with {@link tokenProblem} first.
 */
export function normalizeToken(value: string): string {
  return value.trim().normalize("NFC");
}

/**
 * Why `value` cannot be sent as the id or name of a dataset, resource, organization or group
 * (`*_show`), or undefined when it can: the {@link tokenProblem} rules, and on the trimmed value
 * no `/` and not `.` or `..`. CKAN ids are UUIDs and names slugs (`[a-z0-9_-]`), so neither can
 * hold a `/`; a value with one is a pasted URL or path, not an id.
 */
export function idProblem(value: string): string | undefined {
  const problem = tokenProblem(value);
  if (problem !== undefined) return problem;
  const id = value.trim();
  if (id.includes("/")) return `${quoteValue(value)} is not an id or name: it contains "/".`;
  if (id === "." || id === "..") return '"." and ".." are not ids.';
  return undefined;
}

/**
 * Why `value` cannot be sent as a Solr field name (a facet field), or undefined when it can: the
 * {@link idProblem} rules, then ASCII letters, digits, `_`, `.` and `-` only (`res_format`,
 * `organization`). A field name with a space or another character names no field, and CKAN
 * answers with an empty facet and exit 0.
 */
export function fieldProblem(value: string): string | undefined {
  const problem = idProblem(value);
  if (problem !== undefined) return problem;
  if (!/^[\w.-]+$/.test(value.trim())) return `${quoteValue(value)} is not a Solr field name (letters, digits, _ . -), e.g. res_format.`;
  return undefined;
}

/**
 * Why `value` cannot be sent as a sort expression, or undefined when it can: the
 * {@link tokenProblem} rules, then Solr's syntax, a comma-separated list of a field (or function)
 * and a direction, `metadata_modified desc, name asc`. A criterion without `asc`/`desc` is
 * refused here rather than as CKAN's HTTP 400 (`Invalid "sort" parameter`). An unknown field is
 * not caught: CKAN sorts by its default then, as documented.
 */
export function sortProblem(value: string): string | undefined {
  const problem = tokenProblem(value);
  if (problem !== undefined) return problem;
  // Split at the commas outside parentheses: a function sort (`div(a,b) desc`) holds commas.
  const criteria: string[] = [];
  let depth = 0;
  let from = 0;
  const sort = value.trim();
  for (let i = 0; i < sort.length; i++) {
    const c = sort[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      criteria.push(sort.slice(from, i));
      from = i + 1;
    }
  }
  criteria.push(sort.slice(from));
  if (criteria.some((criterion) => !/^\s*\S.*\s(asc|desc)\s*$/i.test(criterion))) {
    return `${quoteValue(value)} is not a sort expression: expected "<field> asc|desc[, <field> asc|desc]", e.g. "metadata_modified desc".`;
  }
  return undefined;
}

/**
 * Why `items` cannot be sent as a list, or undefined when it can: not an array of strings, no
 * item at all (an empty list reads as "no filter"), or an item that `itemProblem` refuses (by
 * default {@link tokenProblem}: a blank item is refused, never dropped). The reason names the item.
 */
export function listProblem(items: readonly string[], itemProblem: Problem<string> = tokenProblem): string | undefined {
  if (!Array.isArray(items)) return "Expected a list of strings.";
  if (items.length === 0) return "Expected at least one value.";
  for (let i = 0; i < items.length; i++) {
    const problem = itemProblem(items[i] as string);
    if (problem !== undefined) return items.length === 1 ? problem : `item ${i + 1} of ${items.length}: ${problem}`;
  }
  return undefined;
}

/** One value the query-string builder sends as written: a string, a finite number, a boolean or a valid Date. */
function isScalarParam(value: unknown): boolean {
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * A value of an `action()` parameter: a string, a finite number, a boolean or a valid Date, or a
 * non-empty list of them. `null`/`undefined` alone mean "not given". An object would go out as
 * `[object Object]`, NaN and Infinity as words, a nested list flattened. A list must hold at least
 * one value and no `null`/`undefined` entry: the query builder drops those, so `{ q: [null] }` ran
 * the action with no `q` at all, over the whole catalogue. A string (or a list entry) must pass
 * {@link textProblem}: it is sent as text (`normalizeText`).
 */
export function queryValueProblem(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const values: unknown[] = Array.isArray(value) ? value : [value];
  if (Array.isArray(value)) {
    if (value.length === 0) return "Expected at least one value; leave the parameter out instead.";
    const missing = value.findIndex((v) => v === null || v === undefined);
    if (missing >= 0) {
      return `item ${missing + 1} of ${value.length} is ${String(value[missing])}; a list holds values only (leave the parameter out instead).`;
    }
  }
  if (!values.every(isScalarParam)) {
    return "Expected a string, a finite number, a boolean or a Date (or a list of them).";
  }
  // A string goes out as text (normalizeText): the text rules apply to it and to each list entry.
  const strings = values.filter((v): v is string => typeof v === "string");
  return strings.length === 0 ? undefined : listProblem(strings, textProblem);
}

/**
 * A value for an HTTP header (the User-Agent): not blank, no C0 control other
 * than tab, no DEL, nothing above U+00FF. Node's HTTP layer refuses those at
 * request time with an untyped "Invalid character in header content", and a
 * custom transport might send a CR/LF on as a forged header. Checked by char code
 * so the source stays free of control bytes.
 */
export function headerValueProblem(value: unknown): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return "Value contains control characters.";
    if (c > 0xff) return "Value contains characters outside Latin-1 (above U+00FF).";
  }
  return undefined;
}

/**
 * A base URL, checked in this order:
 *
 * - not blank;
 * - no surrounding or embedded whitespace and no control characters: `new URL()`
 *   trims and drops tab/newline silently, but the engine glues the raw value into
 *   every request URL, so `https://ckan.govdata.de/ ` would request `/%20/api/3/...`
 *   and a leading space would reach a custom transport as is;
 * - an absolute URL with an http(s) scheme (`file:`, `ftp:` … never reach a
 *   transport);
 * - no query or fragment: request paths are appended as a string, so a `?` or `#`
 *   would swallow every path (`http://h/#f` requests `/` for every command).
 *
 * Userinfo (`https://user:pw@host`) is allowed: the engine sends it as Basic auth,
 * e.g. for a mirror; a `%` in it must start a valid escape (`%25` for a literal one). The reasons never quote the value, so a credential in it cannot
 * leak through them.
 */
export function baseUrlProblem(value: unknown): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected an absolute http(s) URL.";
  if (value !== value.trim()) return "A base URL cannot have surrounding whitespace.";
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f || /\s/u.test(ch)) {
      return "A base URL cannot contain whitespace or control characters.";
    }
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Expected an absolute http(s) URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Unsupported scheme "${cutForMessage(url.protocol)}". Expected an http(s) URL.`;
  }
  if (/[?#]/.test(value)) return "A base URL cannot have a query (?) or fragment (#).";
  // The userinfo is percent-decoded for the Authorization header; a "%" that isn't an
  // escape fails there ("URI malformed") at request time. Reject it here.
  for (const part of [url.username, url.password]) {
    try {
      decodeURIComponent(part);
    } catch {
      return 'The user name or password has a "%" that is not followed by two hex digits; write a literal "%" as %25.';
    }
  }
  return undefined;
}
