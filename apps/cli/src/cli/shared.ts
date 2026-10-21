// Shared helpers used across CLI command groups: option parsers and the global
// option resolver. The JSON renderer is in output.ts.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { logOf, type CliDeps } from "./io.js";
import { DEFAULT_BASE_URL, cleartextProblem, type EngineOptions, type RetryEvent } from "@maschinenlesbar.org/govdata-client/internal/engine";
import {
  baseUrlProblem,
  headerValueProblem,
  idProblem,
  textProblem,
  type Problem,
} from "@maschinenlesbar.org/govdata-client/internal/validate";

/** commander value-parser: a non-negative integer. */
export function parseIntArg(value: string): number {
  // Validate the literal shape rather than trusting Number(): that rejects
  // empty/whitespace ("" and " " coerce to 0), hex (0x10) and exponent (1e3)
  // notation, all of which Number() would silently accept.
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  const n = Number(value);
  // Reject magnitudes that cannot be represented exactly (silent precision loss).
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return n;
}

/** Build a commander value-parser for a non-negative integer within [min, max]. */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  return (value: string) => {
    const n = parseIntArg(value);
    if (n < min) throw new InvalidArgumentError(`Must be >= ${min}.`);
    if (n > max) throw new InvalidArgumentError(`Must be <= ${max}.`);
    return n;
  };
}

/**
 * A commander value-parser for the library's `problem` rule (`textProblem`, `idProblem`,
 * `sortProblem`, …), reported as a usage error before the client is built. The value goes on
 * as typed: the library canonicalises it (`normalizeText`, `normalizeToken`). A blank filter
 * would otherwise run the command unfiltered.
 */
export function parseWith(problem: Problem<string>): (value: string) => string {
  return (value) => {
    const reason = problem(value);
    if (reason !== undefined) throw new InvalidArgumentError(reason);
    return value;
  };
}

/** commander value-parser for free text (the search text, a filter, the tag query): the library's `textProblem`. */
export const parseText = parseWith(textProblem);

/** commander value-parser for the id or name of a dataset, resource, organization or group: the library's `idProblem`. */
export const parseId = parseWith(idProblem);

/**
 * commander value-parser for a value that ends up in an HTTP header (`--user-agent`):
 * the library's headerValueProblem rule (not blank, no control characters but tab,
 * nothing above U+00FF), reported as a usage error before the client is built.
 */
export function parseHeaderValue(value: string): string {
  const reason = headerValueProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return value;
}

/**
 * Wrap a commander value-parser for a single-valued option so that a second
 * occurrence is a usage error. commander otherwise keeps only the last value, so
 * `--rows 5 --rows 50` silently dropped the first. (The option must have no
 * default: commander passes the default as `previous` on the first occurrence.)
 */
export function once<T>(parse: (value: string) => T): (value: string, previous: T | undefined) => T {
  return (value, previous) => {
    if (previous !== undefined) {
      throw new InvalidArgumentError("Given more than once; this option takes a single value.");
    }
    return parse(value);
  };
}

/** commander accumulator for a repeatable text option (`--fq`), each value checked by `parseText`. */
export function collectText(value: string, previous: string[] = []): string[] {
  return previous.concat([parseText(value)]);
}

/**
 * commander value-parser for --base-url: the library's baseUrlProblem rule (not
 * blank, no whitespace or control characters, an absolute http(s) URL, no query or
 * fragment), reported as a usage error before the client is built. The default
 * transport still re-checks the scheme on every hop.
 */
export function parseBaseUrl(value: string): string {
  const reason = baseUrlProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return value;
}

export interface GlobalOptions {
  baseUrl?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  compact?: boolean;
}

/** Translate resolved global CLI options into client EngineOptions. */
export function toEngineOptions(global: GlobalOptions): EngineOptions {
  const options: EngineOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  return options;
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/** `HTTP 503 from host: retry 1 of 3 in 2 s` (host only; whole seconds, ms under 1 s). */
export function retryMessage(event: RetryEvent): string {
  let host: string;
  try {
    host = new URL(event.url).host;
  } catch {
    host = "the server";
  }
  const why = event.status === undefined ? "connection reset" : `HTTP ${event.status}`;
  const wait = event.delayMs < 1000 ? `${event.delayMs} ms` : `${Math.round(event.delayMs / 1000)} s`;
  return `${why} from ${host}: retry ${event.retry} of ${event.maxRetries} in ${wait}`;
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    const options = toEngineOptions(global);
    options.onRetry = (event) => logOf(deps).warn("http", retryMessage(event));
    // An answer delivered changed (invalid text replaced with U+FFFD) is never silent.
    options.onWarning = (message) => logOf(deps).warn("api", message);
    const client = deps.createClient(options);
    // One warning per run, before the first request, when the base URL is plain http: to
    // a host other than loopback. Help, version and usage errors never get here.
    const cleartext = cleartextProblem(global.baseUrl ?? DEFAULT_BASE_URL);
    if (cleartext !== undefined) logOf(deps).warn("http", cleartext);
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
