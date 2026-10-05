// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import { MAX_TIMEOUT_MS, nodeHttpTransport, type HttpResponse, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  GovDataApiError,
  GovDataError,
  GovDataNetworkError,
  GovDataParseError,
  credentialsIn,
  redactCredentials,
  redactUrl,
} from "./errors.js";
import { assertValid, baseUrlProblem, headerValueProblem } from "./validate.js";

export const DEFAULT_BASE_URL = "https://ckan.govdata.de";
const DEFAULT_USER_AGENT = "govdata-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

/**
 * Options for {@link RequestEngine} and the client. The numeric options must be
 * integers within their documented range; anything else (negative, fractional,
 * NaN, Infinity, too large) makes the constructor throw a GovDataError.
 */
export interface EngineOptions {
  /**
   * Base URL of the API. Defaults to https://ckan.govdata.de (only `undefined`
   * selects it). An http(s) URL without a query, fragment, whitespace or control
   * characters; otherwise the constructor throws.
   */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /**
   * Value of the User-Agent header (default `govdata-cli`). Must be sendable (see
   * `assertHeaderValue`): not blank, no control characters but tab, nothing above
   * U+00FF; otherwise the constructor throws GovDataValidationError.
   */
  userAgent?: string;
  /** Per-request timeout in milliseconds (default 30000; 0 disables; at most `MAX_TIMEOUT_MS`, 2^31 - 1 ms). */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses, 0..`MAX_RETRIES`
   * (10; default 2). Each waits the
   * response's `Retry-After` (up to `MAX_RETRY_AFTER_MS`; a longer one is not
   * retried), or else `retryDelayMs * attempt`.
   */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds (grows linearly); used without a
   * Retry-After. Default 200, at most `MAX_RETRY_AFTER_MS`.
   */
  retryDelayMs?: number;
  /**
   * Number of HTTP redirects (301/302/303/307/308) to follow, 0..20. Defaults to 5. Any
   * other 3xx, one with a missing or malformed Location, and one past this limit
   * surface as a GovDataApiError naming the target.
   */
  maxRedirects?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/**
 * Check a value for an HTTP header (headerValueProblem: not blank, no control
 * characters but tab, nothing above U+00FF) and return it, or throw
 * GovDataValidationError `Invalid <name>: …`.
 */
export function assertHeaderValue(name: string, value: string): string {
  return assertValid(name, value, headerValueProblem);
}

/** Most automatic retries a caller may ask for (the CLI's --max-retries shares it). */
export const MAX_RETRIES = 10;

/** Most redirects a caller may let the engine follow (the Fetch standard's limit). */
const MAX_REDIRECTS = 20;

/**
 * Read a numeric engine option: `undefined` gives the default; anything but an
 * integer in [0, max] throws. Without this a negative or NaN `timeoutMs` silently
 * disabled the timeout, and `maxResponseBytes: -1` the size cap.
 */
function intOption(name: string, value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new GovDataError(
      `Invalid option ${name}: expected an integer from 0 to ${max}, got ${String(value)}.`,
    );
  }
  return value;
}

/**
 * Longest `Retry-After` the engine waits out before retrying a 429/503. When the
 * server asks for longer, the engine does not retry at all and surfaces the error at
 * once: retrying early would only land inside the window the server asked us to wait
 * out, and a hostile value must not stall the CLI.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** An IMF-fixdate (RFC 9110 §5.6.7), the one HTTP-date form senders must generate. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a `Retry-After` header into a delay in milliseconds (RFC 9110 §10.2.3):
 * either delay-seconds (`"120"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`,
 * turned into the time left from `now`; a date in the past gives 0).
 *
 * Returns `undefined` when the header is absent or malformed — negative (`"-1"`),
 * fractional (`"1.5"`), padded inside, any other date format — so the caller falls
 * back to its own backoff. The strict patterns matter: `Date.parse` alone would
 * read `"1.5"` as a date in 2001 and retry at once.
 */
export function parseRetryAfter(
  header: string | string[] | undefined,
  now: number = Date.now(),
): number | undefined {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!IMF_FIXDATE.test(value)) return undefined;
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

/**
 * The redirect statuses the engine follows. 300 (a choice for the user), 304 (a
 * cache answer to a conditional request this client never sends) and 305/306
 * (deprecated) are not redirects to follow; they surface as a GovDataApiError.
 */
const FOLLOWED_REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * True for the Unicode bidirectional formatting characters: ALM (U+061C), LRM/RLM
 * (U+200E/U+200F), the embeddings and overrides U+202A–U+202E and the isolates
 * U+2066–U+2069. A terminal applies them to the text that follows, so an override
 * in server text can reorder what the user sees ("Trojan Source" spoofing).
 */
export function isBidiControl(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Make a string that originates in an attacker-controlled response — the error
 * `detail`, a CKAN `success:false` error — safe to print into an error message on
 * stderr:
 *
 * - C0 and C1 controls and DEL are dropped. A JSON error body can encode an escape
 *   (U+001B) that JSON.parse turns into a real control byte; printed raw, a hostile
 *   or MITM'd endpoint could drive ANSI/OSC sequences into the terminal (display
 *   spoofing, title changes, OSC 52 clipboard writes).
 * - Bidi formatting characters (isBidiControl) are dropped, so server text cannot
 *   reorder the visible message.
 * - Every run of whitespace — newlines, tabs, U+2028/U+2029 included — becomes one
 *   space and the ends are trimmed, so the text stays on one line and a server
 *   cannot forge an `Error:` line of its own.
 *
 * The CLI's JSON output is escaped separately (`escapeControlChars` in
 * cli/shared.ts): `JSON.stringify` alone leaves DEL, C1 and bidi characters raw.
 * Written as a char-code filter so no raw control byte appears in this source.
 */
export function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    const whitespaceControl = n >= 0x09 && n <= 0x0d;
    if (!whitespaceControl && (n <= 0x1f || (n >= 0x7f && n <= 0x9f) || isBidiControl(n))) continue;
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Check a base URL (baseUrlProblem: not blank, no whitespace or control
 * characters, an absolute http(s) URL, no query or fragment) and return it without
 * trailing slashes. Throws GovDataValidationError `Invalid base URL: …` — a
 * configuration mistake, not a GovDataNetworkError. The RequestEngine constructor
 * calls it on the raw value, so a custom transport never sees a bad base URL; the
 * default transport still re-checks the scheme on every hop. Userinfo is allowed
 * (Node sends it as Basic auth, e.g. for a mirror) and never quoted in the message.
 */
export function validateBaseUrl(raw: string): string {
  return assertValid("base URL", raw, baseUrlProblem).replace(/\/+$/, "");
}

// The headers the engine sets itself, under the exact keys it uses. They are the
// only ones that follow a cross-origin redirect.
const ENGINE_HEADERS = new Set(["Accept", "User-Agent"]);

/**
 * A copy of `headers` with only the engine's own non-credential headers (used on
 * cross-origin redirects). A list of known credential headers is never complete
 * (Proxy-Authorization, X-Auth-Token, ...), so an allowlist is kept instead. A new
 * object, so the one already handed to the transport is not changed.
 */
function engineHeadersOnly(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => ENGINE_HEADERS.has(key)));
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RequestEngine {
  // A real private field (not TypeScript's `private`): util.inspect, console.log and
  // JSON.stringify of a client never show it, so a password in the base URL can't be
  // logged by accident. Messages show request URLs through redactUrl.
  readonly #baseUrl: string;
  /** The base URL's userinfo, raw and percent-decoded, for scrubbing server and transport text. */
  readonly #credentials: string[];
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    // The raw value, checked before the slash strip (the engine glues it into
    // every request URL, and `.../ ` would otherwise keep its slash and space), and
    // here rather than only in the default transport: a library consumer that
    // injects a custom transport would otherwise get no gating at all, and could
    // be steered to a non-http(s) scheme. Only undefined selects the default.
    this.#baseUrl = validateBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.#credentials = credentialsIn(this.#baseUrl).flatMap((raw) => {
      try {
        return [raw, decodeURIComponent(raw)];
      } catch {
        return [raw];
      }
    });
    this.transport = options.transport ?? nodeHttpTransport;
    // Only undefined selects the default; a blank or unsendable value is refused.
    this.userAgent =
      options.userAgent === undefined ? DEFAULT_USER_AGENT : assertHeaderValue("userAgent", options.userAgent);
    this.timeoutMs = intOption("timeoutMs", options.timeoutMs, 30_000, MAX_TIMEOUT_MS);
    this.maxRetries = intOption("maxRetries", options.maxRetries, 2, MAX_RETRIES);
    this.retryDelayMs = intOption("retryDelayMs", options.retryDelayMs, 200, MAX_RETRY_AFTER_MS);
    this.maxRedirects = intOption("maxRedirects", options.maxRedirects, 5, MAX_REDIRECTS);
    this.maxResponseBytes = intOption(
      "maxResponseBytes",
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      Number.MAX_SAFE_INTEGER,
    );
    this.sleep = options.sleep ?? realSleep;
  }

  /**
   * `text` without the base URL's credentials: server text (an error body that echoes the
   * request URL) and transport text (fetch's "Request cannot be constructed from a URL that
   * includes credentials: <url>") can carry them.
   */
  private scrub(text: string): string {
    return this.#credentials.length === 0 ? text : redactCredentials(text, this.#credentials);
  }

  /**
   * A transport failure as the `cause` of the error the engine raises: the original when its
   * text carries no credentials, otherwise a copy with them scrubbed (message, `code` and the
   * cause chain kept), so logging the error with its causes can't reveal the base URL's
   * password.
   */
  private scrubCause(cause: unknown, depth = 0): unknown {
    if (this.#credentials.length === 0 || depth > 5) return cause;
    if (typeof cause === "string") return this.scrub(cause);
    if (!(cause instanceof Error)) return cause;
    const inner = this.scrubCause(cause.cause, depth + 1);
    const message = this.scrub(cause.message);
    if (message === cause.message && inner === cause.cause && !this.scrub(cause.stack ?? "").includes("***@")) return cause;
    const copy = new Error(message, inner === undefined ? undefined : { cause: inner });
    copy.name = cause.name;
    const code = (cause as { code?: unknown }).code;
    if (code !== undefined) Object.assign(copy, { code });
    return copy;
  }

  /** Build a fully-qualified URL from a path and optional query parameters. */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.#baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /** Perform a request with Accept negotiation and transient-error retries. */
  async request(
    method: string,
    path: string,
    options: { query?: QueryParams; accept: string } = { accept: "application/json" },
  ): Promise<RawResponse> {
    let url = this.buildUrl(path, options.query);
    let headers: Record<string, string> = {
      Accept: options.accept,
      "User-Agent": this.userAgent,
    };

    let attempt = 0;
    let redirects = 0;
    // attempts = initial try + maxRetries (redirects are counted separately)
    for (;;) {
      let response: HttpResponse;
      try {
        response = await this.transport({
          method,
          url,
          headers,
          timeoutMs: this.timeoutMs,
          ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
        });
      } catch (cause) {
        // The default transport rejects with GovDataNetworkError only; an injected one
        // may throw anything, and its text may carry the request URL with the base URL's
        // password (fetch refuses a URL with credentials and quotes it). Keep the
        // library's error contract — every failure is a GovDataError — and scrub that text.
        if (cause instanceof GovDataError && !(cause instanceof GovDataNetworkError)) throw cause;
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new GovDataNetworkError(
          `${method} ${redactUrl(url)} failed: ${sanitizeServerText(this.scrub(reason))}`,
          { cause: this.scrubCause(cause) },
        );
      }

      const status = response.status;
      const retryable = status === 429 || status === 503;
      if (retryable && attempt < this.maxRetries) {
        // Honour Retry-After; without a usable one, back off linearly. A Retry-After
        // beyond MAX_RETRY_AFTER_MS is not retried: the error below surfaces at once.
        const retryAfter = parseRetryAfter(response.headers["retry-after"]);
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          attempt += 1;
          await this.sleep(retryAfter ?? this.retryDelayMs * attempt);
          continue;
        }
      }

      // Follow redirects, resolving the Location relative to the current URL.
      const location = response.headers["location"];
      const next = FOLLOWED_REDIRECTS.has(status) ? resolveLocation(location, url) : undefined;
      if (next !== undefined && redirects >= this.maxRedirects) {
        // A loop (or a long chain): say how far it got rather than a bare 3xx.
        // (With maxRedirects 0 nothing was followed; the plain text says enough.)
        throw this.toApiError(method, url, status, response.body, location, redirects || undefined);
      }
      if (next !== undefined) {
        // Credential-strip guard: if the redirect crosses origin (scheme + host +
        // port, so an https->http downgrade counts), keep only the engine's own
        // non-credential headers, so any future auth/cookie header is never
        // re-sent to a different host. The User-Agent stays: dropping it sent the
        // redirected request without one and ignored --user-agent.
        if (next.origin !== new URL(url).origin) {
          headers = engineHeadersOnly(headers);
        }
        url = next.toString();
        redirects += 1;
        continue;
      }
      // Any other 3xx — not a followed status, or no usable Location — falls
      // through and surfaces as a GovDataApiError naming the target.

      const contentType = String(response.headers["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, response.body, location);
      }

      return { data: response.body, contentType, status };
    }
  }

  /** Perform a GET expecting JSON and parse it into `T`. */
  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    const res = await this.request("GET", path, { query, accept: "application/json" });
    const text = res.data.toString("utf8");
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new GovDataParseError(`Failed to parse JSON response from ${path}`, { cause });
    }
  }

  private toApiError(
    method: string,
    url: string,
    status: number,
    body: Buffer,
    locationHeader?: string,
    redirectsFollowed?: number,
  ): GovDataApiError {
    const text = this.scrub(body.toString("utf8"));
    let detail: string | undefined;
    try {
      const json: unknown = JSON.parse(text);
      // CKAN's own routing errors (an unknown action name: HTTP 400 "Fehlerhafte
      // Anfrage - Action name not known: …") are a bare JSON string.
      if (typeof json === "string") detail = json;
      const parsed = (typeof json === "object" ? json : null) as {
        detail?: unknown;
        message?: unknown;
        error?: { message?: unknown; __type?: unknown } | unknown;
      } | null;
      // CKAN nests its human-readable error under `error.message` (with an
      // `error.__type` classifier); plainer APIs use a top-level
      // `detail`/`message`. Prefer the nested CKAN shape, then fall back.
      const ckanError =
        parsed && typeof parsed.error === "object" && parsed.error !== null
          ? (parsed.error as { message?: unknown; __type?: unknown })
          : undefined;
      if (ckanError && typeof ckanError.message === "string") {
        detail =
          typeof ckanError.__type === "string"
            ? `${ckanError.__type}: ${ckanError.message}`
            : ckanError.message;
      } else if (ckanError) {
        detail = JSON.stringify(ckanError);
      } else if (parsed && typeof parsed.detail === "string") {
        detail = parsed.detail;
      } else if (parsed && typeof parsed.message === "string") {
        detail = parsed.message;
      }
    } catch {
      // Non-JSON error body; leave detail undefined.
    }
    // `detail` came from the response body; strip control characters so a hostile
    // endpoint cannot inject terminal escape sequences via the stderr error message.
    if (detail !== undefined) detail = sanitizeServerText(detail);
    // Name the target of a redirect that was not followed.
    const location =
      status >= 300 && status < 400 && locationHeader ? redirectTarget(url, this.scrub(locationHeader)) : undefined;
    return new GovDataApiError({
      status,
      url,
      method,
      body: text,
      detail,
      ...(location !== undefined ? { location } : {}),
      ...(redirectsFollowed !== undefined ? { redirectsFollowed } : {}),
    });
  }
}

/** Resolve a Location header against the current URL; undefined if missing or malformed. */
function resolveLocation(location: string | undefined, base: string): URL | undefined {
  if (location === undefined || location === "") return undefined;
  try {
    return new URL(location, base);
  } catch {
    return undefined;
  }
}

/**
 * The absolute, printable form of a `Location` header: resolved against the request
 * URL, userinfo redacted, control characters stripped (it is server text bound for
 * stderr). An unparseable value is shown sanitised as it came.
 */
function redirectTarget(requestUrl: string, location: string): string | undefined {
  const resolved = resolveLocation(location, requestUrl);
  const clean = sanitizeServerText(resolved ? redactUrl(resolved.href) : location);
  return clean === "" ? undefined : clean;
}
