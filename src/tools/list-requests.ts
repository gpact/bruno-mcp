import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { Config } from "../config/config.js";
import { discoverRequests } from "../opencollection/request.js";
import type { RequestSummary } from "../opencollection/types.js";
import {
  matchesMethod,
  matchesQuery,
  matchesType,
  normalizeFilter,
} from "./request-filters.js";
import { jsonResult, runTool } from "./result.js";

/** MCP tool name. */
export const LIST_REQUESTS_TOOL_NAME = "bruno_list_requests";

/** Input schema for the `bruno_list_requests` tool. */
const inputSchema = z.object({
  collection: z
    .string()
    .describe(
      "Collection identifier: the collection's path relative to the workspace root (as returned by bruno_list_collections), not its display name. It may be nested, for example collections/hotel.",
    ),
  query: z
    .string()
    .optional()
    .describe(
      "Case-insensitive substring filter matched against each request's name, path, and URL.",
    ),
  method: z
    .string()
    .optional()
    .describe(
      "Filter to requests with this HTTP method (case-insensitive), for example GET or POST.",
    ),
  type: z
    .string()
    .optional()
    .describe(
      "Filter to requests of this type (case-insensitive), for example http or graphql.",
    ),
});

/** Validated input for {@link listRequests}. */
export type ListRequestsInput = z.infer<typeof inputSchema>;

/** Output payload of the `bruno_list_requests` tool. */
export interface ListRequestsOutput {
  collection: string;
  requests: RequestSummary[];
}

/**
 * List and search requests in a collection.
 *
 * Optional filters narrow the result before sorting:
 * - `query`: case-insensitive substring match against name, path, and URL.
 * - `method`: case-insensitive match against the HTTP method.
 * - `type`: case-insensitive match against the request type.
 *
 * Results are sorted by path (then sequence) rather than run order, matching
 * the tool contract. URLs are returned exactly as stored, without interpolating
 * Bruno variables.
 */
export function listRequests(
  config: Config,
  input: ListRequestsInput,
): ListRequestsOutput {
  const query = normalizeFilter(input.query);
  const method = normalizeFilter(input.method);
  const type = normalizeFilter(input.type);

  const requests = discoverRequests(config.root, input.collection)
    .filter((request) => matchesQuery(request, query))
    .filter((request) => matchesMethod(request, method))
    .filter((request) => matchesType(request, type))
    .sort(compareByPathThenSequence);

  return { collection: input.collection, requests };
}

/** Register the `bruno_list_requests` tool. */
export function registerListRequests(server: McpServer, config: Config): void {
  server.registerTool(
    LIST_REQUESTS_TOOL_NAME,
    {
      title: "List Bruno requests",
      description:
        "List and search requests in a Bruno OpenCollection collection. Returns request paths, names, types, and HTTP metadata when available.",
      inputSchema,
    },
    (input) => runTool(() => jsonResult({ ...listRequests(config, input) })),
  );
}

/**
 * Order requests by path, then by sequence. Paths are unique within a
 * collection, so the sequence tiebreak is effectively a formality that keeps the
 * ordering aligned with the tool contract.
 */
function compareByPathThenSequence(
  left: RequestSummary,
  right: RequestSummary,
): number {
  if (left.path !== right.path) {
    return left.path < right.path ? -1 : 1;
  }
  return compareSequence(left.sequence, right.sequence);
}

/** Declared sequences order ascending; entries without one sort last. */
function compareSequence(left: number | undefined, right: number | undefined): number {
  if (left === right) {
    return 0;
  }
  if (left === undefined) {
    return 1;
  }
  if (right === undefined) {
    return -1;
  }
  return left - right;
}
