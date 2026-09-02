import { readFileSync } from "node:fs";

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { BrunoMcpError } from "../bruno/errors.js";
import type { Config } from "../config/config.js";
import { resolveCollection } from "../opencollection/collection.js";
import { parseYaml } from "../opencollection/parser.js";
import { requestRevision } from "../opencollection/revision.js";
import {
  extractRequestMetadata,
  resolveRequest,
} from "../opencollection/request.js";
import type { RequestMetadata } from "../opencollection/types.js";
import { relativeToRoot } from "../security/paths.js";
import { jsonResult, runTool } from "./result.js";

/** MCP tool name. */
export const GET_REQUEST_TOOL_NAME = "bruno_get_request";

const requestInputShape = {
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
};

/** Input schema for the `bruno_get_request` tool. */
const inputSchema = z
  .object({
    ...requestInputShape,
    responseMode: z
      .enum(["full", "revision"])
      .optional()
      .describe(
        'Response detail. "full" returns the parsed request and metadata; "revision" returns only collection, path, and revision. Defaults to "full".',
      ),
    includeSource: z
      .boolean()
      .optional()
      .describe(
        'When true, include raw source in full mode. Must be false or omitted when responseMode is "revision".',
      ),
  })
  .refine(
    (input) =>
      input.responseMode !== "revision" || input.includeSource !== true,
    {
      message: 'includeSource cannot be true when responseMode is "revision".',
      path: ["includeSource"],
    },
  );

/** Validated input for {@link getRequest}. */
export type GetRequestInput = z.infer<typeof inputSchema>;

/** Minimal output used to acquire a revision for an update. */
export interface GetRequestRevisionOutput {
  collection: string;
  path: string;
  /** Compact SHA-256-derived revision of the exact request source. */
  revision: string;
}

/** Full output payload of the `bruno_get_request` tool. */
export interface GetRequestFullOutput extends GetRequestRevisionOutput {
  metadata: RequestMetadata;
  document: unknown;
  /** Raw request source, present only when `includeSource` is `true`. */
  source?: string;
}

/** Output payload of the `bruno_get_request` tool. */
export type GetRequestOutput =
  | GetRequestRevisionOutput
  | GetRequestFullOutput;

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
  input: GetRequestInput & { responseMode: "revision" },
): GetRequestRevisionOutput;
export function getRequest(
  config: Config,
  input: GetRequestInput & { responseMode?: "full" },
): GetRequestFullOutput;
export function getRequest(
  config: Config,
  input: GetRequestInput,
): GetRequestOutput;
export function getRequest(
  config: Config,
  input: GetRequestInput,
): GetRequestOutput {
  if (input.responseMode === "revision" && input.includeSource === true) {
    throw new BrunoMcpError(
      "INVALID_TARGET",
      'includeSource cannot be true when responseMode is "revision".',
    );
  }

  const collectionRoot = resolveCollection(config.root, input.collection);
  const target = resolveRequest(config.root, input.collection, input.request);
  const path = relativeToRoot(collectionRoot, target);

  const source = readFileSync(target, "utf8");
  const revisionOutput: GetRequestRevisionOutput = {
    collection: input.collection,
    path,
    revision: requestRevision(source),
  };
  if (input.responseMode === "revision") {
    return revisionOutput;
  }

  const document = parseYaml(source, {
    source: `${input.collection}/${path}`,
  });
  const metadata = extractRequestMetadata(document) ?? { name: "", type: "" };

  const output: GetRequestFullOutput = {
    ...revisionOutput,
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
        "Read a Bruno OpenCollection request. Use responseMode=revision for a compact guarded-update preflight, or full mode for its parsed YAML representation and metadata.",
      inputSchema,
    },
    (input) => runTool(() => jsonResult({ ...getRequest(config, input) })),
  );
}
