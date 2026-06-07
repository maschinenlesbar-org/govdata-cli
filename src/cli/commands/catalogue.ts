import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "../io.js";
import { action, parseIntArg, renderJson } from "../shared.js";
import type { QueryParams } from "../../client/query.js";

/** commander accumulator for a repeatable string option. */
function collect(value: string, previous: string[] = []): string[] {
  return previous.concat([value]);
}

/** commander accumulator for repeatable `key=value` pairs into a record. */
function collectKeyValue(
  value: string,
  previous: Record<string, string> = {},
): Record<string, string> {
  const eq = value.indexOf("=");
  // Throw commander's InvalidArgumentError (not a GovDataError) so the failure
  // is formatted as a usage error with `error:` prefix and help, consistent
  // with other parse-time flag validation (e.g. `--rows abc`).
  if (eq <= 0) {
    throw new InvalidArgumentError(`Invalid --param "${value}". Expected key=value.`);
  }
  const key = value.slice(0, eq);
  // Reject a duplicated key rather than silently overwriting the earlier value.
  if (Object.prototype.hasOwnProperty.call(previous, key)) {
    throw new InvalidArgumentError(`Duplicate --param key "${key}".`);
  }
  return { ...previous, [key]: value.slice(eq + 1) };
}

export function registerCatalogueCommands(program: Command, deps: CliDeps): void {
  program
    .command("search [query]")
    .description("Search datasets (Solr query syntax)")
    .option("--rows <n>", "max results", parseIntArg)
    .option("--start <n>", "offset for paging", parseIntArg)
    .option("--sort <expr>", 'e.g. "metadata_modified desc"')
    .option("--fq <filter>", "filter query, e.g. organization:destatis (repeatable)", collect)
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
    .command("package <id>")
    .description("Show one dataset by id or name")
    .action(
      action(deps, async ({ client, global }, [id]) => {
        renderJson(deps, global, await client.packageShow(id!));
      }),
    );

  program
    .command("packages")
    .description("List dataset names")
    .option("--limit <n>", "max names", parseIntArg)
    .option("--offset <n>", "offset for paging", parseIntArg)
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
    .command("organization <id>")
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
    .command("group <id>")
    .description("Show one group")
    .action(
      action(deps, async ({ client, global }, [id]) => {
        renderJson(deps, global, await client.groupShow(id!));
      }),
    );

  program
    .command("tags")
    .description("List tags")
    .option("--query <substring>", "filter tags by substring")
    .action(
      action(deps, async ({ client, global, opts }) => {
        renderJson(deps, global, await client.tagList(opts["query"] as string | undefined));
      }),
    );

  program
    .command("resource <id>")
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
