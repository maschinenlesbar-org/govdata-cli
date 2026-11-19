// How the MCP server reaches this repository's client. The server's generic files (server.ts,
// limiter.ts, config.ts, run.ts, result.ts: the kit, the same in every repository) import the
// client only through this file, under the names below; the names on the right are this
// client's. Per repository, like tools.ts: a client whose names or functions differ adapts here.

import { DEFAULT_BASE_URL } from "@maschinenlesbar.org/govdata-client";

export {
  GovDataClient as Client,
  GovDataError as ClientError,
  GovDataNetworkError as NetworkError,
  DEFAULT_BASE_URL,
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "@maschinenlesbar.org/govdata-client";
export { baseUrlProblem } from "@maschinenlesbar.org/govdata-client/internal/validate";
export { sizeLimitMessage } from "@maschinenlesbar.org/govdata-client/internal/http";
export { cutText, toWellFormed } from "@maschinenlesbar.org/govdata-client/internal/errors";

/**
 * The API's base as a result's `source` starts with it: `--base-url` (else the default) and the
 * CKAN Action API's path, which every request of the client goes to (`…/api/3/action`).
 */
export function apiBase(baseUrl: string | undefined): string {
  return `${(baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}/api/3/action`;
}
