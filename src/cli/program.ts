// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { GovDataClient } from "../client/client.js";
import { MAX_TIMEOUT_MS } from "../client/http.js";
import { DEFAULT_BASE_URL, MAX_RETRIES } from "../client/engine.js";
import { cutForMessage, redactUrl } from "../client/errors.js";
import { once, parseBaseUrl, parseBoundedInt, parseHeaderValue, parseIntArg } from "./shared.js";
import { registerCatalogueCommands } from "./commands/catalogue.js";
import { DEFAULT_LOG_FORMAT, logFormatProblem } from "./log.js";

/**
 * Single source of truth for the version: read from package.json at runtime
 * rather than duplicating a literal that can silently drift after a release bump.
 * From the compiled location (dist/src/cli/program.js) package.json is three
 * directories up; the same offset holds for the source under src/cli.
 */
function readVersion(): string {
  try {
    const pkgUrl = new URL("../../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();

/** Default dependencies: real client + real stdout/stderr/filesystem. */
export const defaultDeps: CliDeps = {
  io: defaultIO,
  createClient: (options) => new GovDataClient(options),
};

/** commander value-parser for `--log-format`. */
function parseLogFormat(value: string): string {
  const problem = logFormatProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();

  program
    .name("govdata")
    .description(
      "CLI for the open GovData CKAN catalogue API (https://ckan.govdata.de/api/3/action)",
    )
    .version(VERSION)
    // No commander default: `once` would read it as a first occurrence. The library
    // falls back to the same URL when the option is absent.
    .option("--base-url <url>", `API base URL (default: "${DEFAULT_BASE_URL}")`, once(parseBaseUrl))
    .option(
      "--timeout <ms>",
      "per-request timeout in milliseconds (default 30000; 0 = no timeout)",
      once(parseBoundedInt(0, MAX_TIMEOUT_MS)),
    )
    .option("--user-agent <ua>", "User-Agent header value", once(parseHeaderValue))
    .option(
      "--max-retries <n>",
      "retries for transient 429/503 responses and reset connections (0..10; linear backoff, longer if the server's Retry-After asks, up to 30 s)",
      once(parseBoundedInt(0, MAX_RETRIES)),
    )
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      once(parseIntArg),
    )
    .option(
      "--log-format <format>",
      `how errors, warnings and notes are written to stderr: text (log4j style: time, level, [topic], message) or jsonl (one JSON object per line: ts, level, topic, msg); default ${DEFAULT_LOG_FORMAT}`,
      once(parseLogFormat),
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .showHelpAfterError();

  // A bare invocation (no subcommand) should print help to stdout and exit 0,
  // matching `govdata help` / `govdata --help`. Without an explicit root action,
  // commander writes help to stderr and exits 1 for the empty-command case.
  // A root action turns off two things commander otherwise does for a program
  // with subcommands, so both are restored: the implicit `help [command]`
  // subcommand (helpCommand(true)), and the "unknown command" error — the
  // action receives the stray operand (allowExcessArguments below) and reports
  // it, instead of commander's "too many arguments".
  program.helpCommand(true);
  program.action(() => {
    const [unknown] = program.args;
    if (unknown !== undefined) {
      // The name is the user's: cut, after its credentials are redacted (a cut could
      // otherwise leave part of a password without the "@" the redaction keys on).
      program.error(`error: unknown command '${cutForMessage(redactUrl(unknown))}'`, { code: "commander.unknownCommand" });
    }
    program.help();
  });

  registerCatalogueCommands(program, deps);
  // Set after the subcommands exist (they copy this setting when created), so it
  // applies to the root only: a stray operand reaches the root action above.
  program.allowExcessArguments(true);

  return program;
}
