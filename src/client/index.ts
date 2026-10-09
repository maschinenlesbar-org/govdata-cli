// Public entry point for the API client library.

export { GovDataClient } from "./client.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  assertHeaderValue,
  cleartextProblem,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  validateBaseUrl,
  isTransientNetworkError,
} from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport, sizeLimitMessage } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export type { QueryParams, QueryValue } from "./query.js";
export {
  GovDataError,
  GovDataApiError,
  GovDataActionError,
  GovDataNetworkError,
  GovDataParseError,
  GovDataValidationError,
  redactUrl,
  credentialsIn,
  redactCredentials,
  cutForMessage,
  MAX_MESSAGE_VALUE_LENGTH,
} from "./errors.js";

export { assertValid } from "./validate.js";
export type { Problem } from "./validate.js";

export * from "./types.js";
