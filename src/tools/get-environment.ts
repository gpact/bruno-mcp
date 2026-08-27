import type { McpServer } from "@modelcontextprotocol/server";

import type { Config } from "../config/config.js";
import { notImplementedResult, runTool } from "./result.js";

/** MCP tool name. */
export const GET_ENVIRONMENT_TOOL_NAME = "bruno_get_environment";

/** Register the `bruno_get_environment` tool. */
export function registerGetEnvironment(
  server: McpServer,
  _config: Config,
): void {
  server.registerTool(
    GET_ENVIRONMENT_TOOL_NAME,
    {
      title: "Get Bruno environment",
      description:
        "Inspect a Bruno environment. Variables marked as secrets are always redacted.",
    },
    () => runTool(() => notImplementedResult(GET_ENVIRONMENT_TOOL_NAME)),
  );
}
