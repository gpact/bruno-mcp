import type { McpServer } from "@modelcontextprotocol/server";

import type { Config } from "../config/config.js";
import { notImplementedResult, runTool } from "./result.js";

/** MCP tool name. */
export const GET_REQUEST_TOOL_NAME = "bruno_get_request";

/** Register the `bruno_get_request` tool. */
export function registerGetRequest(server: McpServer, _config: Config): void {
  server.registerTool(
    GET_REQUEST_TOOL_NAME,
    {
      title: "Get Bruno request",
      description:
        "Read a Bruno OpenCollection request and return its parsed YAML representation.",
    },
    () => runTool(() => notImplementedResult(GET_REQUEST_TOOL_NAME)),
  );
}
