import type { McpServer } from "@modelcontextprotocol/server";

import type { Config } from "../config/config.js";
import { notImplementedResult, runTool } from "./result.js";

/** MCP tool name. */
export const LIST_REQUESTS_TOOL_NAME = "bruno_list_requests";

/** Register the `bruno_list_requests` tool. */
export function registerListRequests(
  server: McpServer,
  _config: Config,
): void {
  server.registerTool(
    LIST_REQUESTS_TOOL_NAME,
    {
      title: "List Bruno requests",
      description:
        "List and search requests in a Bruno OpenCollection collection. Returns request paths, names, types, and HTTP metadata when available.",
    },
    () => runTool(() => notImplementedResult(LIST_REQUESTS_TOOL_NAME)),
  );
}
