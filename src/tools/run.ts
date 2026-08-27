import type { McpServer } from "@modelcontextprotocol/server";

import type { Config } from "../config/config.js";
import { notImplementedResult, runTool } from "./result.js";

/** MCP tool name. */
export const RUN_TOOL_NAME = "bruno_run";

/** Register the `bruno_run` tool. */
export function registerRun(server: McpServer, _config: Config): void {
  server.registerTool(
    RUN_TOOL_NAME,
    {
      title: "Run Bruno requests",
      description:
        "Execute requests, folders, or an entire Bruno collection using Bruno CLI v4. Returns structured request, response, test, and assertion results. Variable overrides must not contain secrets.",
    },
    () => runTool(() => notImplementedResult(RUN_TOOL_NAME)),
  );
}
