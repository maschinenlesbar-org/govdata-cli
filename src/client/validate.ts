// Input rules of the library, as pure functions. Each `…Problem` function returns
// the reason a value is invalid, or `undefined` when it is valid. Client methods
// enforce them with `assertValid` before any request; the CLI's value parsers call
// the same functions, so a rule is written once and the CLI and the library agree.

import { GovDataValidationError } from "./errors.js";

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
  const shown = typeof value === "string" ? JSON.stringify(value) : String(value);
  return `expected a non-empty string, got ${shown}.`;
}
