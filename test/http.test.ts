import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { nodeHttpTransport } from "../src/client/http.js";
import { GovDataNetworkError } from "../src/client/errors.js";

/** Start a throwaway loopback server for one test and return its base URL. */
async function withServer(
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("performs a real GET and returns status, headers and body", async () => {
  await withServer(
    (req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ path: req.url }));
    },
    async (baseUrl) => {
      const resp = await nodeHttpTransport({ method: "GET", url: `${baseUrl}/api/3/action/` });
      assert.equal(resp.status, 200);
      assert.equal(resp.headers["content-type"], "application/json");
      assert.deepEqual(JSON.parse(resp.body.toString("utf8")), { path: "/api/3/action/" });
    },
  );
});

test("rejects an unsupported protocol with GovDataNetworkError", async () => {
  await assert.rejects(
    () => nodeHttpTransport({ method: "GET", url: "ftp://example.test/x" }),
    GovDataNetworkError,
  );
});

test("enforces a wall-clock deadline against a slow-drip response (GOV-04)", async () => {
  // The server flushes headers immediately, then trickles one byte every 15ms
  // and never ends. Each byte resets the socket-inactivity timer, so only the
  // overall wall-clock deadline can stop this. With timeoutMs=50 the deadline
  // must fire and the transport must reject.
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const timer = setInterval(() => res.write("x"), 15);
      res.on("close", () => clearInterval(timer));
    },
    async (baseUrl) => {
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl, timeoutMs: 50 }),
        (err: unknown) => {
          assert.ok(err instanceof GovDataNetworkError);
          assert.match(err.message, /deadline|timed out/);
          return true;
        },
      );
    },
  );
});

test("enforces maxResponseBytes", async () => {
  await withServer(
    (_req, res) => res.end("x".repeat(1000)),
    async (baseUrl) => {
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl, maxResponseBytes: 10 }),
        GovDataNetworkError,
      );
    },
  );
});
