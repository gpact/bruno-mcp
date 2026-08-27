import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { Config } from "../config/config.js";
import { getEnvironment } from "../opencollection/environment.js";
import { jsonResult, runTool } from "./result.js";

/** MCP tool name. */
export const GET_ENVIRONMENT_TOOL_NAME = "bruno_get_environment";

const inputSchema = z.object({
  collection: z
    .string()
    .describe("Collection identifier, relative to the configured workspace root."),
  environment: z
    .string()
    .describe(
      "Environment reference, either a bare name (Local) or a collection-relative path (environments/Local.yml).",
    ),
});

/** Parsed input for the `bruno_get_environment` tool. */
export type GetEnvironmentInput = z.infer<typeof inputSchema>;

/**
 * Inspect a single environment.
 *
 * The reference resolves by bare name or collection-relative path. Values of
 * variables marked `secret: true` are always redacted, even when the value is
 * stored as plaintext in the YAML file.
 */
export function handleGetEnvironment(
  config: Config,
  input: GetEnvironmentInput,
): CallToolResult {
  const environment = getEnvironment(
    config.root,
    input.collection,
    input.environment,
  );
  return jsonResult({ ...environment });
}

/** Register the `bruno_get_environment` tool. */
export function registerGetEnvironment(
  server: McpServer,
  config: Config,
): void {
  // No output schema is advertised: the result is returned as structured
  // content plus JSON text, which stays compatible with clients that validate
  // or project tool output differently across MCP protocol revisions.
  server.registerTool(
    GET_ENVIRONMENT_TOOL_NAME,
    {
      title: "Get Bruno environment",
      description:
        "Inspect a Bruno environment. Variables marked as secrets are always redacted.",
      inputSchema,
    },
    (input) => runTool(() => handleGetEnvironment(config, input)),
  );
}
