// HTTP transport built on Node's built-in `http`/`https` modules — no axios,
// no fetch polyfill, no third-party HTTP client.
//
// The transport is a plain function so it can be trivially swapped out in tests
// (inject a `mock.fn()` returning a canned HttpResponse) without touching the
// network. The default implementation below is exercised against a real local
// `http.createServer` in the test-suite.

import http from "node:http";
import https from "node:https";
import { GovDataNetworkError } from "./errors.js";

export interface HttpRequest {
  method: string;
  /** Fully-qualified absolute URL. */
  url: string;
  headers?: Record<string, string>;
  /** Optional request body (already serialised). */
  body?: string | Buffer;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Hard cap on the response body size in bytes; the request aborts if exceeded. */
  maxResponseBytes?: number;
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

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
      reject(new GovDataNetworkError(`Invalid URL: ${request.url}`));
      return;
    }

    // Only http/https are supported. Reject anything else up front with a clear,
    // typed error instead of letting Node throw an opaque ERR_INVALID_PROTOCOL
    // (and so this never reaches the file:/ftp:/etc. drivers).
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      reject(new GovDataNetworkError(`Unsupported protocol "${url.protocol}" in URL: ${request.url}`));
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

    const req = driver.request(
      url,
      {
        method: request.method,
        headers: request.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        let aborted = false;

        res.on("data", (chunk: Buffer) => {
          if (aborted) return;
          received += chunk.length;
          if (maxBytes !== undefined && received > maxBytes) {
            aborted = true;
            res.destroy();
            settleReject(new GovDataNetworkError(`Response exceeded maxResponseBytes (${maxBytes})`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (aborted) return;
          settleResolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on("error", (err) => {
          if (aborted) return; // we already rejected with the size-cap error
          settleReject(new GovDataNetworkError(`Response stream error: ${err.message}`, { cause: err }));
        });
      },
    );

    if (request.timeoutMs && request.timeoutMs > 0) {
      // Two complementary guards, both using timeoutMs:
      //  - setTimeout: a socket-*inactivity* timeout (no bytes for timeoutMs).
      //  - deadline:   an overall *wall-clock* deadline, so a server that
      //    trickles one byte just under the inactivity window can't keep the
      //    request alive forever. Whichever trips first destroys the request.
      req.setTimeout(request.timeoutMs, () => {
        req.destroy(new GovDataNetworkError(`Request timed out after ${request.timeoutMs}ms`));
      });
      deadline = setTimeout(() => {
        req.destroy(
          new GovDataNetworkError(`Request exceeded the ${request.timeoutMs}ms deadline`),
        );
      }, request.timeoutMs);
      // Don't let a pending deadline timer keep the event loop alive on its own.
      deadline.unref?.();
    }

    req.on("error", (err) => {
      // A timeout destroy already passes an GovDataNetworkError; don't double-wrap.
      settleReject(err instanceof GovDataNetworkError ? err : new GovDataNetworkError(err.message, { cause: err }));
    });

    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
