// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the JSON result renderer.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import { isBidiControl, type EngineOptions } from "../client/engine.js";
import { GovDataError } from "../client/errors.js";
import { baseUrlProblem, headerValueProblem, isBlank } from "../client/validate.js";

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
 * commander value-parser: a value that is not blank (the library's isBlank). A
 * blank filter would otherwise run the command unfiltered; the library refuses it
 * too, and this reports it as a usage error before the client is built.
 */
export function parseNonEmpty(value: string): string {
  if (isBlank(value)) {
    throw new InvalidArgumentError("Expected a non-empty value.");
  }
  return value;
}

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

/** commander accumulator for a repeatable option whose values must not be blank. */
export function collectNonEmpty(value: string, previous: string[] = []): string[] {
  return previous.concat([parseNonEmpty(value)]);
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

/**
 * Escape the characters JSON.stringify leaves raw although a terminal acts on them.
 * It escapes C0 (including ESC) but not DEL, the C1 range U+0080–U+009F (U+009B is
 * the 8-bit form of CSI) or the bidi formatting characters (isBidiControl), which
 * reorder the text that follows. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if ((c >= 0x7f && c <= 0x9f) || isBidiControl(c)) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/**
 * JSON.stringify, pretty or compact. A deeply nested value (a hostile or broken
 * response) overflows the stack — the pretty form far sooner than the compact one,
 * which is why the message suggests --compact. The RangeError becomes a
 * GovDataError so the CLI prints a clear message instead of "Unexpected error:
 * Maximum call stack size exceeded".
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    return compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  } catch (err) {
    if (err instanceof RangeError) {
      throw new GovDataError(
        compact
          ? "The response is nested too deeply to print."
          : "The response is nested too deeply to pretty-print; try --compact.",
        { cause: err },
      );
    }
    throw err;
  }
}

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(stringifyJson(value, global.compact === true));
  deps.io.out(text);
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
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
    const client = deps.createClient(toEngineOptions(global));
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
