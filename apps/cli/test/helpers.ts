// Test helpers of the CLI: the log helpers and the CLI <-> library parity harness. The
// transport helpers (canned responses, the recording mock transport) live with the client,
// in packages/client/test/helpers.ts, and are re-exported here so every CLI test imports its
// helpers from one place.

import assert from "node:assert/strict";
import type { Transport, HttpRequest, HttpResponse } from "@maschinenlesbar.org/govdata-client/internal/http";
import { run } from "../src/cli/run.js";
import { defaultDeps } from "../src/cli/program.js";
import type { CliDeps } from "../src/cli/io.js";
import { GovDataValidationError } from "@maschinenlesbar.org/govdata-client/internal/errors";
import { jsonResponse, makeMockTransport } from "@maschinenlesbar.org/govdata-client/test/helpers";

export * from "@maschinenlesbar.org/govdata-client/test/helpers";

// ---- the log on stderr -------------------------------------------------------

/**
 * stderr with each text record's timestamp taken off: `ERROR [govdata.api] HTTP 404 …`.
 * The format itself — timestamp, level, topic — is the conformance test's
 * (conformance-p23-log-format); the other tests check what was said, at which level
 * and under which topic.
 */
export function untimed(text: string): string {
  return text.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /gm, "");
}

/** What `run()` did with one argv: exit code, captured output and the requests sent. */
export interface CliOutcome {
  code: number;
  out: string;
  err: string;
  requests: HttpRequest[];
}

/** What one library call did: its value or error, and the requests sent. */
export interface LibOutcome<T> {
  ok: boolean;
  value?: T;
  error?: unknown;
  requests: HttpRequest[];
}

/**
 * CLI <-> library parity: run `argv` through `run()` (the real default deps, only
 * the transport and I/O swapped) and `call(transport)` through the library, both
 * on ONE recording mock transport. Each outcome gets the requests it sent. A
 * parity test then asserts the same outcome on both sides: both reject with no
 * request, or both send the identical request.
 */
export async function parity<T>(
  argv: string[],
  call: (transport: Transport) => Promise<T> | T,
  options: { responder?: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> } = {},
): Promise<{ cli: CliOutcome; lib: LibOutcome<T> }> {
  const mt = makeMockTransport(
    options.responder ?? (() => jsonResponse({ help: "h", success: true, result: {} })),
  );
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    ...defaultDeps,
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: (opts) => defaultDeps.createClient({ ...opts, transport: mt.transport }),
  };
  const code = await run(argv, deps);
  const cliRequests = mt.calls.splice(0);
  let lib: LibOutcome<T>;
  try {
    lib = { ok: true, value: await call(mt.transport), requests: [] };
  } catch (error) {
    lib = { ok: false, error, requests: [] };
  }
  lib.requests = mt.calls.splice(0);
  return { cli: { code, out: out.join("\n"), err: untimed(err.join("\n")), requests: cliRequests }, lib };
}

/**
 * Assert that both sides of a parity run refused the input before any request:
 * the CLI with a usage error (exit 1), the library with GovDataValidationError,
 * optionally matching `message` on both.
 */
export function assertBothReject(
  result: { cli: CliOutcome; lib: LibOutcome<unknown> },
  message?: RegExp,
): void {
  const { cli, lib } = result;
  assert.equal(cli.code, 1, `CLI exit code (stderr: ${cli.err})`);
  assert.equal(cli.requests.length, 0, "CLI sent no request");
  assert.equal(lib.ok, false, "library rejected");
  assert.ok(
    lib.error instanceof GovDataValidationError,
    `library error is GovDataValidationError: ${String(lib.error)}`,
  );
  assert.equal(lib.requests.length, 0, "library sent no request");
  if (message) {
    assert.match(cli.err, message);
    assert.match((lib.error as Error).message, message);
  }
}

/** Assert that both sides of a parity run sent the same requests (method, URL, headers). */
export function assertSameRequests(result: { cli: CliOutcome; lib: LibOutcome<unknown> }): void {
  const { cli, lib } = result;
  assert.equal(cli.code, 0, `CLI exit code (stderr: ${cli.err})`);
  assert.equal(lib.ok, true, `library resolved: ${String(lib.error)}`);
  assert.ok(cli.requests.length > 0, "CLI sent a request");
  const summary = (rs: HttpRequest[]) => rs.map((r) => ({ method: r.method, url: r.url, headers: r.headers }));
  assert.deepEqual(summary(cli.requests), summary(lib.requests));
}
