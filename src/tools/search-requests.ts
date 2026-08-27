import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { Config } from "../config/config.js";
import {
  discoverCollections,
  isSkippableCollectionError,
} from "../opencollection/discovery.js";
import { discoverRequests } from "../opencollection/request.js";
import type {
  RequestSearchResult,
  RequestSummary,
} from "../opencollection/types.js";
import {
  matchesMethod,
  matchesQuery,
  matchesType,
  normalizeFilter,
} from "./request-filters.js";
import { jsonResult, runTool } from "./result.js";

/** MCP tool name. */
export const SEARCH_REQUESTS_TOOL_NAME = "bruno_search_requests";

/** Input schema for the `bruno_search_requests` tool. */
const inputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1, "Query must not be blank.")
    .describe(
      "Required case-insensitive substring matched against each request's name, path, and URL.",
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

/** Validated input for {@link searchRequests}. */
export type SearchRequestsInput = z.infer<typeof inputSchema>;

/** Output payload of the `bruno_search_requests` tool. */
export interface SearchRequestsOutput {
  results: RequestSearchResult[];
}

/** Search matching requests across every collection in the workspace. */
export function searchRequests(
  config: Config,
  input: SearchRequestsInput,
): SearchRequestsOutput {
  const query = normalizeFilter(input.query);
  const method = normalizeFilter(input.method);
  const type = normalizeFilter(input.type);
  const results: RequestSearchResult[] = [];

  for (const collection of discoverCollections(config.root)) {
    let requests: RequestSummary[];
    try {
      requests = discoverRequests(config.root, collection.id);
    } catch (error) {
      if (isSkippableCollectionError(error)) {
        continue;
      }
      throw error;
    }

    for (const request of requests) {
      if (
        matchesQuery(request, query) &&
        matchesMethod(request, method) &&
        matchesType(request, type)
      ) {
        results.push({ collection: collection.id, ...request });
      }
    }
  }

  results.sort(compareSearchResults);
  return { results };
}

/** Register the `bruno_search_requests` tool. */
export function registerSearchRequests(server: McpServer, config: Config): void {
  server.registerTool(
    SEARCH_REQUESTS_TOOL_NAME,
    {
      title: "Search Bruno requests",
      description:
        "Search requests across all Bruno OpenCollection collections in the workspace in a single call. Returns each matching request tagged with its collection id.",
      inputSchema,
    },
    (input) => runTool(() => jsonResult({ ...searchRequests(config, input) })),
  );
}

/** Order results by collection, path, then declared sequence. */
function compareSearchResults(
  left: RequestSearchResult,
  right: RequestSearchResult,
): number {
  if (left.collection !== right.collection) {
    return left.collection < right.collection ? -1 : 1;
  }
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
