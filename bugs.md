# govdata-cli — Exploratory Bug Report

## Environment

- Repo: `/Users/sebastian.schuermann/private/machinenlesbar.org/api-cli/govdata-cli`
- Build: `npm run build` (clean, no errors). Ran via `node dist/src/cli/index.js ...`.
- Node: system node (darwin 25.5.0). Package declares Node >= 20.
- GovData CKAN API (`https://ckan.govdata.de`) was **reachable** during testing — live calls (search, package_show, tag_list) succeeded; error bodies fetched with `curl` for comparison.
- Local echo HTTP servers on ports 8799/8801 were used to capture the exact outgoing URL / headers for inputs that the public API would reject before we could observe them.

All bugs below are **real and reproducible**. Outputs are pasted verbatim with exit codes.

---

## High severity

### 1. CKAN error message/detail is dropped from all API errors (data loss on every failure)
- **Severity:** High
- **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js package this-dataset-does-not-exist-xyz123
  ```
- **Expected:** Surface CKAN's human-readable error. CKAN returns
  `{"error":{"__type":"Not Found Error","message":"Nicht gefunden"},"success":false}`
  (verified via curl). The README and the `action()` code both promise the
  "human-readable error.message" is surfaced.
- **Actual:**
  ```
  Error: HTTP 404 for GET https://ckan.govdata.de/api/3/action/package_show?id=this-dataset-does-not-exist-xyz123
  ```
  exit=4. The message ("Nicht gefunden"), the `__type`, and (for 409) the
  per-field validation messages (`{"name_or_id":["Fehlender Wert"]}`) are all
  thrown away.
- **Root cause:** `engine.ts:148-159` `toApiError` only reads **top-level**
  `parsed.detail` / `parsed.message`, but CKAN nests the message under
  `error.message` (and `error.__type`). It never inspects `parsed.error`, so
  `detail` is always `undefined` for CKAN responses. The nice
  `error.message` handling in `client.ts:63-69` is effectively **dead code**
  for GovData, because CKAN returns non-2xx for failures and the engine throws
  `GovDataApiError` before `action()` ever sees `success:false`.

### 2. `parseIntArg` accepts empty string and whitespace, silently coercing to 0
- **Severity:** High
- **Confidence:** High
- **Repro (captured against local echo server to show what is sent):**
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:8799 --compact search test --rows ''
  node dist/src/cli/index.js --base-url http://127.0.0.1:8799 --compact search test --rows ' '
  ```
- **Expected:** Reject empty/whitespace argument with
  `Expected a non-negative integer` (as it does for `abc`).
- **Actual:**
  ```
  {"ECHO_URL":"/api/3/action/package_search?q=test&rows=0"}
  {"ECHO_URL":"/api/3/action/package_search?q=test&rows=0"}
  ```
  Both silently become `rows=0` and the request is sent. A user who fat-fingers
  an empty value gets zero rows instead of an error.
- **Root cause:** `shared.ts:10-16` uses `Number(value)`; `Number("")` and
  `Number(" ")` are both `0`, which passes `Number.isInteger(n) && n >= 0`.
  Affects every numeric flag (`--rows --start --limit --offset --timeout --max-retries --max-response-bytes`).

### 3. `parseIntArg` accepts hex (`0x..`) and exponent (`1e3`) notation
- **Severity:** High
- **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:8799 --compact search test --rows 0x10
  node dist/src/cli/index.js --base-url http://127.0.0.1:8799 --compact packages --offset 0xff
  node dist/src/cli/index.js --base-url http://127.0.0.1:8799 --compact search x --start 1e3
  ```
- **Expected:** A flag documented as `<n>` / "non-negative integer" should
  reject `0x10`, `0xff`, `1e3` (none is a plain integer literal a user would type
  intending that magnitude).
- **Actual:**
  ```
  ...?q=test&rows=16
  ...?offset=255
  ...?q=x&start=1000
  ```
  `0x10`→16, `0xff`→255, `1e3`→1000 are accepted and sent. Surprising and
  inconsistent (`3.5` *is* rejected).
- **Root cause:** `shared.ts:10` `Number("0x10")===16`, `Number("1e3")===1000`,
  both integral so they pass the guard. The parser should validate the string
  shape (e.g. `/^\d+$/`) rather than rely on `Number()`.

---

## Medium severity

### 4. `action` allowlist is case-insensitive — uppercase names bypass it and hit the API
- **Severity:** Medium
- **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js action TAG_LIST
  ```
- **Expected:** Per the README ("validated against `^[a-z0-9_]+$`") and the
  in-code comment ("CKAN action names are **always** `[a-z0-9_]+`"), uppercase
  should be rejected locally with `Invalid CKAN action name`.
- **Actual:**
  ```
  Error: HTTP 400 for GET https://ckan.govdata.de/api/3/action/TAG_LIST
  ```
  exit=1. The name passes validation and is sent to the server (CKAN body:
  `"Action name not known: TAG_LIST"`).
- **Root cause:** `client.ts:32` `const ACTION_NAME = /^[a-z0-9_]+$/i;` — the
  `i` flag makes it case-insensitive, contradicting both the documented regex and
  the adjacent comment. Drop the `i` flag.

### 5. `parseIntArg` accepts unsafe integers, silently losing precision
- **Severity:** Medium
- **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:8799 --compact search test --rows 99999999999999999999
  ```
- **Expected:** Reject (beyond `Number.MAX_SAFE_INTEGER`) or send the literal.
- **Actual:**
  ```
  {"ECHO_URL":"/api/3/action/package_search?q=test&rows=100000000000000000000"}
  ```
  The value sent (`1e20`) differs from the input the user typed — silent data
  corruption. (`Number("99999999999999999999")` is `1e20`, `Number.isInteger`
  returns `true`, so it passes the guard even though it is not safe.)
- **Root cause:** `shared.ts:10-15` does not check `Number.isSafeInteger`.

### 6. Bare invocation prints help to STDERR and exits 1 (vs `--help`/`help` → stdout, exit 0)
- **Severity:** Medium
- **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js            ; echo "exit=$?"
  node dist/src/cli/index.js > /dev/null ; head -1   # stdout empty
  node dist/src/cli/index.js 2>/dev/null             # stdout empty
  ```
- **Expected:** README: "Exit codes: `0` ... (and for `--help`/`--version`)".
  A user who runs `govdata` with no command reasonably expects help on stdout,
  exit 0 — same as `govdata help`.
- **Actual:** The help text is written to **stderr** and the process exits **1**.
  `govdata help` and `govdata --help` correctly write to stdout and exit 0. So
  behaviour is inconsistent across the three "show help" entry points.
- **Root cause:** commander's default "no command supplied" path
  (`run.ts` lets the `CommanderError` exit code through at line 33, and
  `program.ts` does not call `.action()`/`.helpCommand` on the root or override
  the empty-command behaviour). No explicit default action is registered.

### 7. `tags --query ''` sends an empty `query=` parameter instead of omitting it
- **Severity:** Medium (low-ish)
- **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:8799 --compact tags --query ''
  ```
- **Expected:** An empty filter should behave like no filter (omit the param),
  consistent with the "prune undefined" intent.
- **Actual:**
  ```
  {"ECHO_URL":"/api/3/action/tag_list?query="}
  ```
- **Root cause:** `client.ts:35-41` `prune()` only drops `undefined`, not empty
  strings; `tagList("")` therefore forwards `query=""`.

---

## Low severity / UX / docs

### 8. `--param` with a repeated key silently overwrites earlier values (no warning)
- **Severity:** Low
- **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:8799 --compact action package_search --param q=a --param q=b
  ```
- **Expected:** Either error on a duplicate key, or (like `--fq`) repeat it. CKAN
  itself accepts repeated keys for some actions.
- **Actual:**
  ```
  {"ECHO_URL":"/api/3/action/package_search?q=b"}
  ```
  First value silently dropped — quiet data loss.
- **Root cause:** `catalogue.ts:13-20` `collectKeyValue` accumulates into a plain
  object (`{...previous, [key]: value}`), so a repeated key overwrites.

### 9. README claims global options must go "before the command" but they work after too
- **Severity:** Low (doc/behaviour mismatch — behaviour is the friendlier one)
- **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js search test --rows 1 --compact   # compact output works
  ```
- **Expected (per README):** "Global options go **before** the command."
- **Actual:** `--compact` placed after the subcommand still produces single-line
  output (commander resolves it via `optsWithGlobals()` in `shared.ts:66`). Not a
  defect in itself, but the README is misleading / overly restrictive.

### 10. `--param` parse failure is reported as a runtime error, not a usage error
- **Severity:** Low
- **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js action package_list --param nope ; echo "exit=$?"
  ```
- **Expected:** Consistent with other parse-time validation
  (`--rows abc` prints `error: option '--rows <n>' argument 'abc' is invalid ...`
  plus usage help). A malformed `--param` is conceptually the same class of error.
- **Actual:**
  ```
  Error: Invalid --param "nope". Expected key=value.
  exit=1
  ```
  No `error:` prefix, no usage help shown (`--rows abc` does show it). Inconsistent
  presentation.
- **Root cause:** `catalogue.ts:18` throws a `GovDataError` from inside the
  commander value-parser instead of commander's `InvalidArgumentError`, so it
  escapes commander's usage-error formatting and is caught by `run.ts:42`.

---

## Notes on things that are CORRECT (tested, not bugs)

- Path-traversal / injection action names rejected locally with clear message + exit 1:
  `../../x`, `pkg?x=1`, `#`, empty, embedded newline. Good.
- Non-http(s) base URL (`file:///etc/passwd`) rejected: `Unsupported protocol "file:"`, exit 1. Good (no SSRF to file:).
- Network failures (closed port ECONNREFUSED, bad host ENOTFOUND, `--timeout 1`,
  `--max-response-bytes 1`) all produce clear messages and **exit 1** per README.
- `404 → exit 4` confirmed for `package`/`organization` (`echo $?` = 4).
- Unicode and Solr-special chars in `search` are correctly percent-encoded
  (`Müll ö ☃` → `M%C3%BCll%20%C3%B6%20%E2%98%83`; spaces as `%20` not `+`).
- IDs with `/`, spaces are sent as query params and URL-encoded (`a/b/c` → `id=a%2Fb%2Fc`), no path injection.
- `--user-agent` is applied; default is `govdata-cli`.
- `--param q=a=b` correctly yields `q=a=b` (only first `=` splits).
- Field fidelity vs `curl`: `package_show` returned the identical 29 keys — no field dropping in the data path.
- `--compact` vs pretty both work; `--all-fields` → `all_fields=true`; `--max-response-bytes 0` → unlimited (param omitted/cap disabled).
- Negative numeric args correctly rejected by `parseIntArg` (`--rows -1`).
- Unknown command / unknown flag → exit 1 with usage help.

---

## Count

**10 genuine, reproducible bugs** found (3 High, 4 Medium, 3 Low/UX/docs).
The most serious are #1 (CKAN error messages dropped from every failure),
#2 (empty/whitespace numeric flags silently coerced to 0), and #3 (hex/exponent
numeric flags silently accepted).
