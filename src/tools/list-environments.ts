import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { Config } from "../config/config.js";
import { listEnvironments } from "../opencollection/environment.js";
import { jsonResult, runTool } from "./result.js";

/** MCP tool name. */
export const LIST_ENVIRONMENTS_TOOL_NAME = "bruno_list_environments";

const inputSchema = z.object({
  collection: z
    .string()
    .describe(
      "Collection identifier: the collection's path relative to the workspace root (as returned by bruno_list_collections), not its display name. It may be nested, for example collections/hotel.",
    ),
});

/** Parsed input for the `bruno_list_environments` tool. */
export type ListEnvironmentsInput = z.infer<typeof inputSchema>;

/**
 * Summarize every environment defined in a collection.
 *
 * Only counts are returned, never variable values, so this path cannot leak
 * secret or non-secret data.
 */
export function handleListEnvironments(
  config: Config,
  input: ListEnvironmentsInput,
): CallToolResult {
  const environments = listEnvironments(config.root, input.collection);
  return jsonResult({ environments });
}

/** Register the `bruno_list_environments` tool. */
export function registerListEnvironments(
  server: McpServer,
  config: Config,
): void {
  // No output schema is advertised: the result is returned as structured
  // content plus JSON text, which stays compatible with clients that validate
  // or project tool output differently across MCP protocol revisions.
  server.registerTool(
    LIST_ENVIRONMENTS_TOOL_NAME,
    {
      title: "List Bruno environments",
      description:
        "List environments available to a Bruno collection without exposing variable values.",
      inputSchema,
    },
    (input) => runTool(() => handleListEnvironments(config, input)),
  );
}
