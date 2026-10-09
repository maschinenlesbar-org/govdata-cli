// Input rules of the library, as pure functions. Each `…Problem` function returns
// the reason a value is invalid, or `undefined` when it is valid. Client methods
// enforce them with `assertValid` before any request; the CLI's value parsers call
// the same functions, so a rule is written once and the CLI and the library agree.

import { GovDataValidationError, cutForMessage } from "./errors.js";

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

/** True for an empty or whitespace-only string: CKAN reads it as "not given". */
export function isBlank(value: string): boolean {
  return value.trim() === "";
}

/**
 * A string with non-whitespace content. CKAN reads an empty parameter as no
 * filter, so a blank `q`, `fq`, tag query or `action()` parameter would silently
 * widen the result, and a blank id is not an id.
 */
export function textProblem(value: unknown): string | undefined {
  if (typeof value === "string" && !isBlank(value)) return undefined;
  const shown =
    typeof value === "string"
      ? cutForMessage(JSON.stringify(value))
      : value === null || typeof value !== "object"
        ? String(value)
        : Array.isArray(value)
          ? "an array"
          : "an object";
  return `expected a non-empty string, got ${shown}.`;
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
