// A hostile answer within the response cap ends in a clean record and exit code, never a heap
// crash (security audit 2026-10-27). The memory cases run the built bin in a child process with
// --max-old-space-size against a server on 127.0.0.1.
// - A CKAN error message of millions of characters, on HTTP 500 and in a success:false envelope
//   on HTTP 200: sanitizeServerText copied the whole text, one string node per character, before
//   it cut it to 500 characters.
// - A 2xx answer in millions of one-byte chunks (transfer-encoding: chunked): the default transport
//   kept each chunk as its own Buffer until the end, about 210 bytes of heap per byte of payload,
//   far below the byte cap.

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The built bin, relative to this compiled test file (dist/test/…). */
const BIN = fileURLToPath(new URL("../src/cli/index.js", import.meta.url));

// These tests start the built CLI as a process: 30 s instead of the suite's 5 s.
const STARTS_A_PROCESS = { timeout: 30_000 };

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Answer one run of the bin with the raw HTTP response `answer`, under a heap of `heapMb`. */
async function runWithRawAnswer(answer: Buffer, heapMb: number, argv: string[]): Promise<Run> {
  const server = net.createServer((socket) => {
    socket.once("data", () => socket.end(answer));
    socket.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    return await new Promise<Run>((resolve) => {
      const child = spawn(
        process.execPath,
        [`--max-old-space-size=${heapMb}`, BIN, "--base-url", base, "--max-retries", "0", "--compact", ...argv],
        { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** A JSON answer with `status`, sent with Content-Length. */
function jsonAnswer(status: number, body: string): Buffer {
  const bytes = Buffer.from(body, "utf8");
  const head = `HTTP/1.1 ${status} X\r\ncontent-type: application/json\r\ncontent-length: ${bytes.length}\r\nconnection: close\r\n\r\n`;
  return Buffer.concat([Buffer.from(head, "latin1"), bytes]);
}

/** No crash: no V8 out-of-memory report, no abort, no stack. */
function noCrash(run: Run, label: string): void {
  assert.notEqual(run.signal, "SIGABRT", `${label}: aborted`);
  assert.ok(run.code !== null && run.code !== 134, `${label}: exit ${run.code} ${run.signal}`);
  assert.doesNotMatch(run.stderr, /FATAL ERROR|heap out of memory|Allocation failed|\n\s+at /, `${label}: ${run.stderr.slice(0, 500)}`);
}

test("a 16 MB CKAN error message ends in one ERROR record within a small heap, on HTTP 500 and in success:false", STARTS_A_PROCESS, async () => {
  const body = JSON.stringify({ help: "h", success: false, error: { __type: "Validation Error", message: "x ".repeat(8_000_000) } });
  for (const status of [500, 200]) {
    const run = await runWithRawAnswer(jsonAnswer(status, body), 128, ["package", "a1"]);
    noCrash(run, `HTTP ${status}`);
    assert.equal(run.code, 1, run.stderr.slice(0, 500));
    assert.equal(run.stdout, "");
    const records = run.stderr.trim().split("\n");
    assert.equal(records.length, 1, run.stderr.slice(0, 500));
    assert.match(records[0] ?? "", /ERROR \[govdata\.api\] /);
    assert.ok((records[0] ?? "").length < 1500, "the record is cut");
  }
});

/** A 200 answer in chunked transfer encoding: `first`, then `count` chunks of one space, then `last`. */
function tinyChunks(first: string, count: number, last: string): Buffer {
  const chunk = (text: string): string => `${Buffer.byteLength(text).toString(16)}\r\n${text}\r\n`;
  const head = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n";
  return Buffer.from(head + chunk(first) + "1\r\n \r\n".repeat(count) + chunk(last) + "0\r\n\r\n", "latin1");
}

test("an answer in two million one-byte chunks is read within a small heap", STARTS_A_PROCESS, async () => {
  const answer = tinyChunks('{"help":"h","success":true,"result":{"id":"a1"}', 2_000_000, "}");
  const run = await runWithRawAnswer(answer, 256, ["package", "a1"]);
  noCrash(run, "tiny chunks");
  assert.equal(run.code, 0, run.stderr.slice(0, 500));
  assert.deepEqual(JSON.parse(run.stdout), { id: "a1" });
});

test("an answer of millions of lone surrogate escapes is repaired within a small heap (C)", STARTS_A_PROCESS, async () => {
  // 6 million repairs (36 MB): one `+=` each exhausted a 128 MB heap; batched, 96 MB suffice.
  const n = 6_000_000;
  const body = `{"help":"h","success":true,"result":{"id":"a1","x":"${"\\ud800".repeat(n)}"}}`;
  const run = await runWithRawAnswer(jsonAnswer(200, body), 128, ["package", "a1"]);
  noCrash(run, "lone surrogates");
  assert.equal(run.code, 0, run.stderr.slice(0, 500));
  assert.match(run.stderr, new RegExp(`WARN  \\[govdata\\.api\\] GET \\S+: ${n} characters of the answer were not valid text`));
});
