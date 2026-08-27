import type { McpServer } from "@modelcontextprotocol/server";

import type { Config } from "../config/config.js";
import { notImplementedResult, runTool } from "./result.js";

/** MCP tool name. */
export const LIST_ENVIRONMENTS_TOOL_NAME = "bruno_list_environments";

/** Register the `bruno_list_environments` tool. */
export function registerListEnvironments(
  server: McpServer,
  _config: Config,
): void {
  server.registerTool(
    LIST_ENVIRONMENTS_TOOL_NAME,
    {
      title: "List Bruno environments",
      description:
        "List environments available to a Bruno collection without exposing variable values.",
    },
    () => runTool(() => notImplementedResult(LIST_ENVIRONMENTS_TOOL_NAME)),
  );
}
