import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { GovDataClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";

const ACTION = "/api/3/action";

function ckan(result: unknown) {
  return { help: "h", success: true, result };
}

function makeCli(responder: (req: HttpRequest) => HttpResponse) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);

  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    },
    createClient: (opts) => new GovDataClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt };
}

test("search passes the query and rows; result is unwrapped", async () => {
  const cli = makeCli(() => jsonResponse(ckan({ count: 1, results: [{ id: "d1" }] })));
  const code = await run(["search", "Haushalt", "--rows", "5"], cli.deps);
  assert.equal(code, 0);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.pathname, `${ACTION}/package_search`);
  assert.equal(url.searchParams.get("q"), "Haushalt");
  assert.deepEqual(JSON.parse(cli.out.join("\n")), { count: 1, results: [{ id: "d1" }] });
});

test("--compact prints JSON on a single line", async () => {
  const cli = makeCli(() => jsonResponse(ckan({ count: 1, results: [{ id: "d1" }] })));
  await run(["--compact", "search", "Haushalt"], cli.deps);
  const printed = cli.out.join("\n");
  assert.equal(printed.includes("\n"), false);
  assert.deepEqual(JSON.parse(printed), { count: 1, results: [{ id: "d1" }] });
});

test("DEL and C1 control characters in server data are escaped in the JSON output", async () => {
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const result = { count: 1, results: [{ id: "d1", title: `Haushalt${controls}`, notes: String.fromCharCode(0x1b) + "[31m" }] };
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(ckan(result)));
    assert.equal(await run([...format, "search", "Haushalt"], cli.deps), 0);
    const text = cli.out.join("\n");
    const raw = [...text].filter((c) => c.charCodeAt(0) < 0x20 ? c !== "\n" : c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f);
    assert.deepEqual(raw, [], format.join(" "));
    assert.match(text, /Haushalt\\u007f\\u0085\\u009b2J/);
    assert.deepEqual(JSON.parse(text), result);
  }
});

test("repeated --fq accumulates into fq_list, never a repeated fq key", async () => {
  // CKAN answers a repeated `fq=` with HTTP 409 (it pastes the list into Solr).
  const cli = makeCli(() => jsonResponse(ckan({ count: 0, results: [] })));
  const code = await run(["search", "--fq", "organization:a", "--fq", "res_format:CSV"], cli.deps);
  assert.equal(code, 0);
  const params = new URL(cli.mt.last().url).searchParams;
  assert.deepEqual(params.getAll("fq"), []);
  assert.deepEqual(params.getAll("fq_list"), ["organization:a", "res_format:CSV"]);
});

test("a single --fq goes out as fq_list too, so a top-level OR in it is applied", async () => {
  // As a lone `fq`, CKAN prefixed it with `+capacity:public` and the OR made the
  // filter optional: the whole catalogue came back. A lone fq_list value is split
  // into characters by CKAN, so the filter is sent twice.
  const cli = makeCli(() => jsonResponse(ckan({ count: 0, results: [] })));
  const filter = "organization:open-nrw OR groups:tran";
  assert.equal(await run(["search", "--fq", filter], cli.deps), 0);
  const params = new URL(cli.mt.last().url).searchParams;
  assert.deepEqual(params.getAll("fq"), []);
  assert.deepEqual(params.getAll("fq_list"), [filter, filter]);
});

test("packages --limit 0 is refused (CKAN reads it as no limit)", async () => {
  const cli = makeCli(() => jsonResponse(ckan(["a"])));
  assert.equal(await run(["packages", "--limit", "0"], cli.deps), 1);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Must be >= 1\./);

  const ok = makeCli(() => jsonResponse(ckan(["a"])));
  assert.equal(await run(["packages", "--limit", "1", "--offset", "0"], ok.deps), 0);
  assert.equal(new URL(ok.mt.last().url).search, "?limit=1&offset=0");
});

test("action --param builds query parameters", async () => {
  const cli = makeCli(() => jsonResponse(ckan({ ok: true })));
  await run(["action", "package_show", "--param", "id=abc"], cli.deps);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.pathname, `${ACTION}/package_show`);
  assert.equal(url.searchParams.get("id"), "abc");
});

test("action --param value may contain '='", async () => {
  const cli = makeCli(() => jsonResponse(ckan({ ok: true })));
  await run(["action", "package_search", "--param", "filter=a=b"], cli.deps);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.searchParams.get("filter"), "a=b");
});

test("action rejects an injecting name before any request", async () => {
  const cli = makeCli(() => jsonResponse(ckan({})));
  const code = await run(["action", "../../../etc/passwd"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("action rejects a malformed --param before any request", async () => {
  const cli = makeCli(() => jsonResponse(ckan({})));
  const code = await run(["action", "tag_list", "--param", "nope"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("a blank filter, query or id is a usage error before any request", async () => {
  // A blank value (often an unset shell variable) would otherwise be dropped or
  // sent as `key=`, so the command would silently run unfiltered and exit 0.
  const cases: string[][] = [
    ["search", ""],
    ["search", "   "],
    ["search", "--sort", ""],
    ["search", "--fq", ""],
    ["search", "--fq", "organization:a", "--fq", " "],
    ["package", ""],
    ["package", " \t "],
    ["organization", ""],
    ["group", ""],
    ["resource", ""],
    ["tags", "--query", ""],
    ["tags", "--query", "  "],
  ];
  for (const argv of cases) {
    const cli = makeCli(() => jsonResponse(ckan({})));
    const code = await run(argv, cli.deps);
    assert.notEqual(code, 0, JSON.stringify(argv));
    assert.equal(cli.mt.calls.length, 0, JSON.stringify(argv));
  }
});

test("--base-url with a non-http(s) scheme is rejected before any request", async () => {
  const cli = makeCli(() => jsonResponse(ckan({})));
  const code = await run(["--base-url", "file:///etc/passwd", "search", "x"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("--base-url with a query, fragment or surrounding whitespace is a usage error", async () => {
  const cases: Array<[string, RegExp]> = [
    ["http://127.0.0.1:1/echo?token=1", /query \(\?\) or fragment \(#\)/],
    ["http://127.0.0.1:1/echo#frag", /query \(\?\) or fragment \(#\)/],
    [" https://ckan.govdata.de", /surrounding whitespace/],
    ["https://ckan.govdata.de/ ", /surrounding whitespace/],
  ];
  for (const [value, message] of cases) {
    const cli = makeCli(() => jsonResponse(ckan({})));
    assert.equal(await run(["--base-url", value, "action", "status_show"], cli.deps), 1, value);
    assert.equal(cli.mt.calls.length, 0, value);
    assert.match(cli.err.join("\n"), message, value);
  }
});

test("userinfo in --base-url is sent but redacted in error messages", async () => {
  const cli = makeCli(() => jsonResponse({}, 500));
  assert.equal(await run(["--base-url", "http://user:secret@mirror.test/s500", "action", "x"], cli.deps), 1);
  assert.equal(new URL(cli.mt.last().url).password, "secret");
  const stderr = cli.err.join("\n");
  assert.ok(!stderr.includes("secret"), stderr);
  assert.match(stderr, /HTTP 500 for GET http:\/\/\*\*\*@mirror\.test\/s500\/api\/3\/action\/x/);
});

test("--max-retries is bounded to 0..10", async () => {
  for (const [value, ok] of [["0", true], ["10", true], ["11", false], ["9007199254740991", false]] as const) {
    const cli = makeCli(() => jsonResponse(ckan({})));
    const code = await run(["--max-retries", value, "action", "status_show"], cli.deps);
    assert.equal(code, ok ? 0 : 1, value);
    if (!ok) {
      assert.match(cli.err.join("\n"), /Must be <= 10\./);
      assert.equal(cli.mt.calls.length, 0);
    }
  }
});

test("help, help <command>, --help and --version exit 0; an unknown command is named", async () => {
  for (const argv of [["help"], ["help", "search"], ["search", "--help"], ["--version"], [], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(ckan({})));
    assert.equal(await run(argv, cli.deps), 0, argv.join(" "));
    assert.equal(cli.mt.calls.length, 0);
    assert.doesNotMatch(cli.err.join("\n"), /too many arguments/, argv.join(" "));
  }
  const helpSearch = makeCli(() => jsonResponse(ckan({})));
  await run(["help", "search"], helpSearch.deps);
  assert.match(helpSearch.out.join("\n"), /Usage: govdata search/);

  for (const argv of [["pakages"], ["help", "nope"]]) {
    const cli = makeCli(() => jsonResponse(ckan({})));
    assert.equal(await run(argv, cli.deps), 1, argv.join(" "));
    assert.equal(cli.mt.calls.length, 0);
    assert.doesNotMatch(cli.err.join("\n"), /too many arguments/, argv.join(" "));
  }
  const typo = makeCli(() => jsonResponse(ckan({})));
  await run(["pakages"], typo.deps);
  assert.match(typo.err.join("\n"), /error: unknown command 'pakages'/);
});

test("a leaf command still rejects an extra positional", async () => {
  const cli = makeCli(() => jsonResponse(ckan([])));
  assert.equal(await run(["packages", "extra"], cli.deps), 1);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /too many arguments for 'packages'/);
});

test("--timeout accepts up to the largest timer Node supports", async () => {
  const cli = makeCli(() => jsonResponse(ckan({ count: 0, results: [] })));
  assert.equal(await run(["--timeout", "2147483647", "search", "x"], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 2_147_483_647);

  const over = makeCli(() => jsonResponse(ckan({ count: 0, results: [] })));
  assert.equal(await run(["--timeout", "2147483648", "search", "x"], over.deps), 1);
  assert.equal(over.mt.calls.length, 0);
  assert.match(over.err.join("\n"), /Must be <= 2147483647/);
});

test("bidi formatting characters in server data are escaped in the JSON output", async () => {
  const bidi = String.fromCharCode(0x202e, 0x2066, 0x200f, 0x061c);
  const result = { title: `a${bidi}b` };
  const cli = makeCli(() => jsonResponse(ckan(result)));
  assert.equal(await run(["--compact", "package", "x"], cli.deps), 0);
  const text = cli.out.join("\n");
  assert.equal(text, '{"title":"a\\u202e\\u2066\\u200f\\u061cb"}');
  assert.deepEqual(JSON.parse(text), result);
});

test("a success:false error on HTTP 200 reaches stderr without escape sequences", async () => {
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const cli = makeCli(() =>
    jsonResponse({ success: false, error: { message: `evil${ESC}[31mRED${ESC}]0;TITLE${BEL}` } }),
  );
  assert.equal(await run(["package", "x"], cli.deps), 1);
  assert.deepEqual(cli.err, ['Error: CKAN action "package_show" failed: evil[31mRED]0;TITLE']);
});

test("malformed envelopes exit 1 with a clear error instead of an Unexpected error", async () => {
  for (const body of [null, { success: true }, [1, 2]]) {
    const cli = makeCli(() => jsonResponse(body));
    assert.equal(await run(["--compact", "search", "x"], cli.deps), 1, JSON.stringify(body));
    assert.match(cli.err.join("\n"), /^Error: Unexpected response shape from \/api\/3\/action\/package_search: /);
  }
});

test("a deeply nested response is a clear error when pretty-printing", async () => {
  const depth = 200_000;
  const body = `{"success":true,"result":${"[".repeat(depth)}${"]".repeat(depth)}}`;
  const pretty = makeCli(() => rawResponse(body, "application/json"));
  assert.equal(await run(["action", "x"], pretty.deps), 1);
  assert.deepEqual(pretty.err, ["Error: The response is nested too deeply to pretty-print; try --compact."]);

  const compact = makeCli(() => rawResponse(body, "application/json"));
  const code = await run(["--compact", "action", "x"], compact.deps);
  // V8 may manage the compact form; if not, the error is the compact one.
  if (code !== 0) assert.deepEqual(compact.err, ["Error: The response is nested too deeply to print."]);
});

test("a success:false envelope exits non-zero", async () => {
  const cli = makeCli(() => jsonResponse({ help: "h", success: false, error: { message: "x" } }));
  const code = await run(["package", "nope"], cli.deps);
  assert.notEqual(code, 0);
});

test("a 404 from the API maps to exit code 4", async () => {
  const cli = makeCli(() => jsonResponse({}, 404));
  const code = await run(["package", "nope"], cli.deps);
  assert.equal(code, 4);
});
