import type { McpServer } from "@modelcontextprotocol/server";

import type { Config } from "../config/config.js";
import { notImplementedResult, runTool } from "./result.js";

/** MCP tool name. */
export const LIST_COLLECTIONS_TOOL_NAME = "bruno_list_collections";

/** Register the `bruno_list_collections` tool. */
export function registerListCollections(
  server: McpServer,
  _config: Config,
): void {
  server.registerTool(
    LIST_COLLECTIONS_TOOL_NAME,
    {
      title: "List Bruno collections",
      description:
        "List Bruno OpenCollection collections available in the configured workspace.",
    },
    () => runTool(() => notImplementedResult(LIST_COLLECTIONS_TOOL_NAME)),
  );
}
