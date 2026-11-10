// HTTP transport built on Node's built-in `http`/`https` modules — no axios,
// no fetch polyfill, no third-party HTTP client.
//
// The transport is a plain function so it can be trivially swapped out in tests
// (inject a `mock.fn()` returning a canned HttpResponse) without touching the
// network. The default implementation below is exercised against a real local
// `http.createServer` in the test-suite.

import http from "node:http";
import https from "node:https";
import { GovDataNetworkError, credentialsIn, cutForMessage, redactCredentials, redactUrl, typedUrlCredentials } from "./errors.js";

export interface HttpRequest {
  method: string;
  /** Fully-qualified absolute URL. */
  url: string;
  headers?: Record<string, string>;
  /** Optional request body (already serialised). */
  body?: string | Buffer;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /**
   * Aborted when the engine's overall deadline (`timeoutMs`) passes. A transport should stop
   * the request then (`fetch(url, { signal })`); the engine rejects at the deadline either way,
   * and enforces `maxResponseBytes` on the body it gets back, so neither limit depends on it.
   */
  signal?: AbortSignal;
  /** Hard cap on the response body size in bytes; the request aborts if exceeded. */
  maxResponseBytes?: number;
  /**
   * Always `"manual"` from the engine: a transport must not follow redirects. The engine
   * follows them itself and decides per hop whether the `Authorization` header goes along
   * (same origin only). A fetch-based transport passes it on: `fetch(url, { redirect })`.
   */
  redirect?: "manual";
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /**
   * The URL the response came from, if the transport knows it (fetch's `response.url`).
   * When it is on another origin than the request, the transport followed a redirect
   * itself and the engine rejects the response with a GovDataNetworkError.
   */
  url?: string;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

/** The most received chunks the default transport keeps unjoined. */
const COALESCE_CHUNKS = 1024;
/** The bytes of unjoined chunks at which the default transport joins them into one Buffer. */
const COALESCE_BYTES = 64 * 1024;

/** The message for a body over the size cap, naming the option on both sides. */
export function sizeLimitMessage(maxBytes: number): string {
  return `Response exceeded the size limit of ${maxBytes} bytes (maxResponseBytes; --max-response-bytes on the CLI)`;
}

/**
 * The longest delay Node's timers support (2^31 - 1 ms, about 24.8 days). A longer one
 * prints a TimeoutOverflowWarning and fires after 1 ms, so timeouts are capped here.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * `url` for a message, its userinfo redacted; one typed without its scheme (`user:pw@host`,
 * `TOKEN:@host`) or with a mistyped one (`http//user:pw@host`) is read as a URL all the same
 * (`typedUrlCredentials`), since `redactUrl` finds a userinfo only after a scheme.
 */
function shownUrl(url: string): string {
  return credentialsIn(url).length > 0 ? redactUrl(url) : redactCredentials(url, typedUrlCredentials(url));
}

/**
 * Default transport. Resolves with the raw response (including non-2xx) — status
 * interpretation is the client's job. Rejects only on transport-level failures
 * (connection errors, timeouts, malformed URLs).
 */
export const nodeHttpTransport: Transport = (request) =>
  new Promise<HttpResponse>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      reject(new GovDataNetworkError(`Invalid URL: ${shownUrl(request.url)}`));
      return;
    }

    // Only http/https are supported. Reject anything else up front with a clear,
    // typed error instead of letting Node throw an opaque ERR_INVALID_PROTOCOL
    // (and so this never reaches the file:/ftp:/etc. drivers).
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      // `user:password@host` without a scheme parses with the user name as the scheme: name a
      // scheme only when the value spells one (`<scheme>://`).
      const named = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(request.url) ? ` "${cutForMessage(url.protocol)}"` : "";
      reject(new GovDataNetworkError(`Unsupported protocol${named} in URL: ${shownUrl(request.url)}`));
      return;
    }

    const isHttps = url.protocol === "https:";
    const driver = isHttps ? https : http;
    const maxBytes = request.maxResponseBytes;

    // Wall-clock deadline (see below). Declared here so both the settle wrappers
    // and the request setup can reference it; cleared on the first settle.
    let deadline: NodeJS.Timeout | undefined;
    const settleResolve = (value: HttpResponse): void => {
      if (deadline) clearTimeout(deadline);
      resolve(value);
    };
    const settleReject = (err: unknown): void => {
      if (deadline) clearTimeout(deadline);
      reject(err);
    };

    // Node validates the headers synchronously and throws a bare TypeError
    // (ERR_INVALID_CHAR) for one it cannot send; report it as a typed failure.
    let req: http.ClientRequest;
    try {
      req = driver.request(
        url,
        {
          method: request.method,
          headers: request.headers,
        },
        (res) => {
          // Small chunks are joined as they arrive (`pending`, at most COALESCE_CHUNKS of them
          // or COALESCE_BYTES), so the Buffers kept follow the bytes, not the number of chunks
          // a server chooses to send: a Buffer per one-byte chunk held ~210 bytes of heap each.
          const chunks: Buffer[] = [];
          let pending: Buffer[] = [];
          let pendingBytes = 0;
          let received = 0;
          let aborted = false;

          res.on("data", (chunk: Buffer) => {
            if (aborted) return;
            received += chunk.length;
            if (maxBytes !== undefined && received > maxBytes) {
              aborted = true;
              res.destroy();
              settleReject(new GovDataNetworkError(sizeLimitMessage(maxBytes)));
              return;
            }
            pending.push(chunk);
            pendingBytes += chunk.length;
            if (pending.length >= COALESCE_CHUNKS || pendingBytes >= COALESCE_BYTES) {
              chunks.push(pending.length === 1 ? chunk : Buffer.concat(pending, pendingBytes));
              pending = [];
              pendingBytes = 0;
            }
          });
          res.on("end", () => {
            if (aborted) return;
            settleResolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat([...chunks, ...pending]),
            });
          });
          res.on("error", (err) => {
            if (aborted) return; // we already rejected with the size-cap error
            settleReject(new GovDataNetworkError(`Response stream error: ${err.message}`, { cause: err }));
          });
        },
      );
    } catch (err) {
      reject(
        new GovDataNetworkError(`Invalid request: ${err instanceof Error ? err.message : String(err)}`, {
          cause: err,
        }),
      );
      return;
    }

    if (request.timeoutMs && request.timeoutMs > 0) {
      // Two complementary guards, both using timeoutMs:
      //  - setTimeout: a socket-*inactivity* timeout (no bytes for timeoutMs).
      //  - deadline:   an overall *wall-clock* deadline, so a server that
      //    trickles one byte just under the inactivity window can't keep the
      //    request alive forever. Whichever trips first destroys the request.
      const delay = Math.min(request.timeoutMs, MAX_TIMEOUT_MS);
      req.setTimeout(delay, () => {
        req.destroy(new GovDataNetworkError(`Request timed out after ${request.timeoutMs}ms`));
      });
      deadline = setTimeout(() => {
        req.destroy(
          new GovDataNetworkError(`Request exceeded the ${request.timeoutMs}ms deadline`),
        );
      }, delay);
      // Don't let a pending deadline timer keep the event loop alive on its own.
      deadline.unref?.();
    }

    if (request.signal !== undefined) {
      // The engine's overall deadline: stop the request when it fires.
      const abort = (): void => {
        req.destroy(new GovDataNetworkError(`Request timed out after ${request.timeoutMs ?? 0}ms`));
      };
      if (request.signal.aborted) abort();
      else request.signal.addEventListener("abort", abort, { once: true });
    }

    req.on("error", (err) => {
      // A timeout destroy already passes an GovDataNetworkError; don't double-wrap.
      settleReject(err instanceof GovDataNetworkError ? err : new GovDataNetworkError(err.message, { cause: err }));
    });

    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
