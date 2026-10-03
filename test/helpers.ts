// Test helpers: build canned HTTP responses and a recording mock transport based
// on Node's built-in `node:test` mock facility. No real network is ever touched
// in the unit suite.

import { mock } from "node:test";
import assert from "node:assert/strict";
import type { Transport, HttpRequest, HttpResponse } from "../src/client/http.js";
import { run } from "../src/cli/run.js";
import { defaultDeps } from "../src/cli/program.js";
import type { CliDeps } from "../src/cli/io.js";
import { GovDataValidationError } from "../src/client/errors.js";

export function jsonResponse(body: unknown, status = 200): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body)),
  };
}

export function rawResponse(
  data: string | Buffer,
  contentType: string,
  status = 200,
): HttpResponse {
  return {
    status,
    headers: { "content-type": contentType },
    body: Buffer.isBuffer(data) ? data : Buffer.from(data),
  };
}

export interface MockTransport {
  transport: Transport;
  /** All requests the transport has received, in order. */
  readonly calls: HttpRequest[];
  /** The most recent request. */
  last(): HttpRequest;
}

/**
 * Build a mock transport from a responder function. The returned object records
 * every request so tests can assert on method/url/headers.
 */
export function makeMockTransport(
  responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>,
): MockTransport {
  const calls: HttpRequest[] = [];
  const fn = mock.fn(async (req: HttpRequest): Promise<HttpResponse> => {
    calls.push(req);
    return responder(req);
  });
  return {
    transport: fn as unknown as Transport,
    calls,
    last: () => {
      const c = calls[calls.length - 1];
      if (!c) throw new Error("mock transport has not been called");
      return c;
    },
  };
}

/** A transport that always returns the same JSON body. */
export function constantJson(body: unknown, status = 200): MockTransport {
  return makeMockTransport(() => jsonResponse(body, status));
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
  return { cli: { code, out: out.join("\n"), err: err.join("\n"), requests: cliRequests }, lib };
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
