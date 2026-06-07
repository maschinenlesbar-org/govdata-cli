// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { Command } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { GovDataClient } from "../client/client.js";
import { parseIntArg } from "./shared.js";
import { registerCatalogueCommands } from "./commands/catalogue.js";

export const VERSION = "1.0.0";

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
    .option("--base-url <url>", "API base URL", "https://ckan.govdata.de")
    .option("--timeout <ms>", "per-request timeout in milliseconds", parseIntArg)
    .option("--user-agent <ua>", "User-Agent header value")
    .option("--max-retries <n>", "retries for transient 429/503 responses", parseIntArg)
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
  program.action(() => {
    program.help();
  });

  registerCatalogueCommands(program, deps);

  return program;
}
