import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "../io.js";
import {
  action,
  collectText,
  once,
  parseBoundedInt,
  parseId,
  parseIntArg,
  parseText,
  parseWith,
} from "../shared.js";
import { renderJson } from "../output.js";
import type { QueryParams } from "@maschinenlesbar.org/govdata-client/internal/query";
import { normalizeToken, sortProblem, textProblem, tokenProblem } from "@maschinenlesbar.org/govdata-client/internal/validate";
import { quoteValue, redactUrl } from "@maschinenlesbar.org/govdata-client/internal/errors";

/**
 * A typed value as a message quotes it: visibly (`quoteValue`: invisible and control characters
 * escaped, cut at MAX_MESSAGE_VALUE_LENGTH), after its credentials are redacted (a cut could
 * otherwise leave part of a password without the "@" the argv redaction keys on).
 */
function shown(value: string): string {
  return quoteValue(redactUrl(value));
}

/**
 * commander value-parser for a list --limit: 1 or more. CKAN reads `limit=0` as
 * "no limit" and would send the whole list; leave --limit out for that.
 */
const parseLimit = once(parseBoundedInt(1, Number.MAX_SAFE_INTEGER));

/**
 * commander accumulator for repeatable `key=value` pairs into a record. The library's rules,
 * as a usage error: the name is a token (`tokenProblem`; sent trimmed, so ` q` and `q` are the
 * same name, and giving it twice is refused), the value is text (`textProblem`: not blank, no
 * control or invisible character; sent trimmed and in NFC).
 */
function collectKeyValue(
  value: string,
  previous: Record<string, string> = {},
): Record<string, string> {
  const eq = value.indexOf("=");
  // Throw commander's InvalidArgumentError (not a GovDataError) so the failure
  // is formatted as a usage error with `error:` prefix and help, consistent
  // with other parse-time flag validation (e.g. `--rows abc`).
  if (eq < 0) throw new InvalidArgumentError(`Invalid --param ${shown(value)}. Expected key=value.`);
  const key = value.slice(0, eq);
  // A blank key (`=x`, ` =x`) names no parameter: the library refuses it too.
  const keyProblem = tokenProblem(key);
  if (keyProblem !== undefined) throw new InvalidArgumentError(`Invalid --param ${shown(value)}: the name: ${keyProblem}`);
  // Reject a duplicated key (as it is sent, trimmed) rather than silently overwriting the earlier value.
  const name = normalizeToken(key);
  if (Object.keys(previous).some((k) => normalizeToken(k) === name)) {
    throw new InvalidArgumentError(`Duplicate --param key ${shown(name)}.`);
  }
  // A blank value is refused by the library as well (CKAN reads an empty
  // parameter as unset, so `--param q=` would run the action unfiltered).
  const paramValue = value.slice(eq + 1);
  const valueProblem = textProblem(paramValue);
  if (valueProblem !== undefined) throw new InvalidArgumentError(`Invalid --param ${shown(value)}: the value: ${valueProblem}`);
  // A computed key in a literal is an own data property, even for `__proto__`.
  return { ...previous, [key]: paramValue };
}

export function registerCatalogueCommands(program: Command, deps: CliDeps): void {
  program
    .command("search")
    .argument("[query]", "Solr query", parseText)
    .description("Search datasets (Solr query syntax)")
    .option("--rows <n>", "max results", once(parseIntArg))
    .option("--start <n>", "offset for paging", once(parseIntArg))
    .option("--sort <expr>", 'e.g. "metadata_modified desc"', once(parseWith(sortProblem)))
    .option(
      "--fq <filter>",
      "filter query, e.g. groups:tran (repeatable; all must match)",
      collectText,
    )
    .action(
      action(deps, async ({ client, global, opts }, [query]) => {
        renderJson(
          deps,
          global,
          await client.packageSearch({
            q: query,
            rows: opts["rows"] as number | undefined,
            start: opts["start"] as number | undefined,
            sort: opts["sort"] as string | undefined,
            fq: opts["fq"] as string[] | undefined,
          }),
        );
      }),
    );

  program
    .command("package")
    .argument("<id>", "dataset id or name", parseId)
    .description("Show one dataset by id or name")
    .action(
      action(deps, async ({ client, global }, [id]) => {
        renderJson(deps, global, await client.packageShow(id!));
      }),
    );

  program
    .command("packages")
    .description("List dataset names")
    .option("--limit <n>", "max names (1 or more; omit for all)", parseLimit)
    .option("--offset <n>", "offset for paging", once(parseIntArg))
    .action(
      action(deps, async ({ client, global, opts }) => {
        renderJson(
          deps,
          global,
          await client.packageList({
            limit: opts["limit"] as number | undefined,
            offset: opts["offset"] as number | undefined,
          }),
        );
      }),
    );

  program
    .command("organizations")
    .description("List organizations (data publishers)")
    .option("--all-fields", "return full objects instead of names")
    .action(
      action(deps, async ({ client, global, opts }) => {
        renderJson(
          deps,
          global,
          await client.organizationList({ all_fields: opts["allFields"] as boolean | undefined }),
        );
      }),
    );

  program
    .command("organization")
    .argument("<id>", "organization id or name", parseId)
    .description("Show one organization")
    .action(
      action(deps, async ({ client, global }, [id]) => {
        renderJson(deps, global, await client.organizationShow(id!));
      }),
    );

  program
    .command("groups")
    .description("List groups (themes/categories)")
    .option("--all-fields", "return full objects instead of names")
    .action(
      action(deps, async ({ client, global, opts }) => {
        renderJson(
          deps,
          global,
          await client.groupList({ all_fields: opts["allFields"] as boolean | undefined }),
        );
      }),
    );

  program
    .command("group")
    .argument("<id>", "group id or name", parseId)
    .description("Show one group")
    .action(
      action(deps, async ({ client, global }, [id]) => {
        renderJson(deps, global, await client.groupShow(id!));
      }),
    );

  program
    .command("tags")
    .description("List tags")
    .option("--query <substring>", "filter tags by substring", once(parseText))
    .action(
      action(deps, async ({ client, global, opts }) => {
        renderJson(deps, global, await client.tagList(opts["query"] as string | undefined));
      }),
    );

  program
    .command("resource")
    .argument("<id>", "resource id", parseId)
    .description("Show one resource (distribution) by id")
    .action(
      action(deps, async ({ client, global }, [id]) => {
        renderJson(deps, global, await client.resourceShow(id!));
      }),
    );

  program
    .command("action <name>")
    .description("Call any CKAN action by name (generic escape hatch)")
    .option("--param <key=value>", "query parameter (repeatable)", collectKeyValue)
    .action(
      action(deps, async ({ client, global, opts }, [name]) => {
        const params = (opts["param"] as Record<string, string> | undefined) ?? {};
        renderJson(deps, global, await client.action(name!, params as QueryParams));
      }),
    );
}
