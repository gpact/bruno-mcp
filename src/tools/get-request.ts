import { readFileSync } from "node:fs";

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { Config } from "../config/config.js";
import { resolveCollection } from "../opencollection/collection.js";
import { parseYaml } from "../opencollection/parser.js";
import {
  extractRequestMetadata,
  resolveRequest,
} from "../opencollection/request.js";
import type { RequestMetadata } from "../opencollection/types.js";
import { relativeToRoot } from "../security/paths.js";
import { jsonResult, runTool } from "./result.js";

/** MCP tool name. */
export const GET_REQUEST_TOOL_NAME = "bruno_get_request";

/** Input schema for the `bruno_get_request` tool. */
const inputSchema = z.object({
  collection: z
    .string()
    .describe(
      "Collection identifier: the collection's path relative to the workspace root (as returned by bruno_list_collections), not its display name. It may be nested, for example collections/hotel.",
    ),
  request: z
    .string()
    .describe(
      "Request path relative to the collection root (as returned by bruno_list_requests), for example Hotel/Search.yml.",
    ),
  includeSource: z
    .boolean()
    .optional()
    .describe(
      "When true, also return the raw request source text alongside the parsed document. Defaults to false.",
    ),
});

/** Validated input for {@link getRequest}. */
export type GetRequestInput = z.infer<typeof inputSchema>;

/** Output payload of the `bruno_get_request` tool. */
export interface GetRequestOutput {
  collection: string;
  path: string;
  metadata: RequestMetadata;
  document: unknown;
  /** Raw request source, present only when `includeSource` is `true`. */
  source?: string;
}

/**
 * Read a single request and return its parsed YAML plus normalized metadata.
 *
 * The request path is resolved through the path-security layer, so traversal
 * attempts raise `PATH_OUTSIDE_ROOT` and a missing file raises
 * `REQUEST_NOT_FOUND`. Scripts and variables are never transformed or
 * interpolated: the document and optional source are returned verbatim.
 */
export function getRequest(
  config: Config,
  input: GetRequestInput,
): GetRequestOutput {
  const collectionRoot = resolveCollection(config.root, input.collection);
  const target = resolveRequest(config.root, input.collection, input.request);
  const path = relativeToRoot(collectionRoot, target);

  const source = readFileSync(target, "utf8");
  const document = parseYaml(source, {
    source: `${input.collection}/${path}`,
  });
  const metadata = extractRequestMetadata(document) ?? { name: "", type: "" };

  const output: GetRequestOutput = {
    collection: input.collection,
    path,
    metadata,
    document,
  };

  if (input.includeSource === true) {
    output.source = source;
  }

  return output;
}

/** Register the `bruno_get_request` tool. */
export function registerGetRequest(server: McpServer, config: Config): void {
  server.registerTool(
    GET_REQUEST_TOOL_NAME,
    {
      title: "Get Bruno request",
      description:
        "Read a Bruno OpenCollection request and return its parsed YAML representation.",
      inputSchema,
    },
    (input) => runTool(() => jsonResult({ ...getRequest(config, input) })),
  );
}
