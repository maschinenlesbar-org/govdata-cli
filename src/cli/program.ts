// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { GovDataClient } from "../client/client.js";
import { MAX_TIMEOUT_MS } from "../client/http.js";
import { MAX_RETRIES } from "../client/engine.js";
import { parseBaseUrl, parseBoundedInt, parseHeaderValue, parseIntArg } from "./shared.js";
import { registerCatalogueCommands } from "./commands/catalogue.js";

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

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();

  program
    .name("govdata")
    .description(
      "CLI for the open GovData CKAN catalogue API (https://ckan.govdata.de/api/3/action)",
    )
    .version(VERSION)
    .option("--base-url <url>", "API base URL", parseBaseUrl, "https://ckan.govdata.de")
    .option("--timeout <ms>", "per-request timeout in milliseconds", parseBoundedInt(0, MAX_TIMEOUT_MS))
    .option("--user-agent <ua>", "User-Agent header value", parseHeaderValue)
    .option(
      "--max-retries <n>",
      "retries for transient 429/503 responses (0..10; each waits the server's Retry-After, up to 30 s)",
      parseBoundedInt(0, MAX_RETRIES),
    )
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      parseIntArg,
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
      program.error(`error: unknown command '${unknown}'`, { code: "commander.unknownCommand" });
    }
    program.help();
  });

  registerCatalogueCommands(program, deps);
  // Set after the subcommands exist (they copy this setting when created), so it
  // applies to the root only: a stray operand reaches the root action above.
  program.allowExcessArguments(true);

  return program;
}
