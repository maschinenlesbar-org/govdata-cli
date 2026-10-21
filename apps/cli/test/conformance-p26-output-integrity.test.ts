// Conformance test P26 (trend analysis 2026-10-21; fix plan 2026-10-21, D1, D5 and D6): `-o`
// never loses a file, and no output is cut short silently. govdata has no `-o`, so of the kit's P26
// only the stdout case is copied (D6): stdout redirected to a file and cut short (a full disk, a
// quota; here a file-size limit) says so (exit 1, an ERROR record of <bin>.output), never exit 0.
// Runs the built bin in a child process. The body below is the kit's, without the `-o` tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

// ---- adapter (per repo) -------------------------------------------------------------
/** The built bin, relative to this compiled test file (dist/test/…). */
const BIN = fileURLToPath(new URL("../src/cli/index.js", import.meta.url));
/** argv that prints the server's answer to stdout, given the mock's base URL. */
const stdoutArgv = (base: string): string[] => ["--base-url", base, "--max-retries", "0", "packages"];
/** An answer for that command of about `items` × 20 bytes, as the server sends it (any format the API speaks). */
const answerOf = (items: number): { body: string; contentType: string } => ({
  body: JSON.stringify({ help: "h", success: true, result: Array.from({ length: items }, (_, i) => `dataset-${i}`) }),
  contentType: "application/json",
});
/** An answer of about 200 kB. */
const bigAnswer = (): { body: string; contentType: string } => answerOf(10000);
/** The log program, as in `ERROR [<bin>.output]`. */
const PROGRAM = "govdata";
// --------------------------------------------------------------------------------------

// These tests start the built CLI as a process: 30 s instead of the suite's 5 s.
const STARTS_A_PROCESS = { timeout: 30_000 };

/**
 * Run the bin with files limited to a few kB; SIGXFSZ ignored, so a write fails with EFBIG.
 * Node passes NODE_V8_COVERAGE to every child; under the limit the child's coverage file would
 * be cut short and break `npm run coverage`, so the shell drops it.
 */
function runLimited(argv: string[], stdoutFile?: string): Promise<{ code: number; stderr: string }> {
  const redirect = stdoutFile === undefined ? "" : ' > "$OUT"';
  const sh = `trap '' XFSZ; ulimit -f 8; unset NODE_V8_COVERAGE; exec "$0" "$@"${redirect}`;
  return new Promise((resolve) =>
    execFile("/bin/sh", ["-c", sh, process.execPath, BIN, ...argv], { env: { PATH: process.env.PATH ?? "", OUT: stdoutFile ?? "" } }, (err, _stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stderr }),
    ),
  );
}

async function withServer(
  body: (base: string, requests: () => number) => Promise<void>,
  answer = bigAnswer(),
  delayMs = 0,
): Promise<void> {
  let count = 0;
  const server = http.createServer((_req, res) => {
    count += 1;
    res.setHeader("content-type", answer.contentType);
    if (delayMs === 0) return void res.end(answer.body);
    // A slow answer: the first bytes now, the rest later.
    res.write(answer.body.slice(0, 10));
    setTimeout(() => res.end(answer.body.slice(10)), delayMs);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await body(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, () => count);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** Run `body` in a fresh temp directory that is always removed. */
async function inTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `${PROGRAM}-p26-`));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("P26: stdout redirected to a file and cut short is an error (exit 1, ERROR of output), never exit 0", STARTS_A_PROCESS, async () => {
  await inTempDir(async (dir) => {
    await withServer(async (base) => {
      const out = join(dir, "stdout.json");
      const cut = await runLimited(stdoutArgv(base), out);
      assert.equal(cut.code, 1, cut.stderr);
      assert.match(cut.stderr, new RegExp(`ERROR \\[${PROGRAM}\\.output\\] Could not write to stdout: .*EFBIG`), cut.stderr);
    });
  });
});
