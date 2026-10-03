// Public entry point for the API client library.

export { GovDataClient } from "./client.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  assertHeaderValue,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  validateBaseUrl,
} from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export type { QueryParams, QueryValue } from "./query.js";
export {
  GovDataError,
  GovDataApiError,
  GovDataNetworkError,
  GovDataParseError,
  GovDataValidationError,
  redactUrl,
} from "./errors.js";

export { assertValid } from "./validate.js";
export type { Problem } from "./validate.js";

export * from "./types.js";
