import type { McpServer } from "@modelcontextprotocol/server";

import type { Config } from "../config/config.js";
import {
  GET_ENVIRONMENT_TOOL_NAME,
  registerGetEnvironment,
} from "./get-environment.js";
import { GET_REQUEST_TOOL_NAME, registerGetRequest } from "./get-request.js";
import {
  LIST_COLLECTIONS_TOOL_NAME,
  registerListCollections,
} from "./list-collections.js";
import {
  LIST_ENVIRONMENTS_TOOL_NAME,
  registerListEnvironments,
} from "./list-environments.js";
import {
  LIST_REQUESTS_TOOL_NAME,
  registerListRequests,
} from "./list-requests.js";
import { RUN_TOOL_NAME, registerRun } from "./run.js";

export {
  toToolErrorResult,
  runTool,
  notImplementedResult,
} from "./result.js";

/** Registers one tool onto a server, given the runtime configuration. */
export type ToolRegistrar = (server: McpServer, config: Config) => void;

/**
 * Append-only list of tool registrars: one entry per tool module. Each tool
 * issue plugs in by adding its registrar here. Keeping this
 * flat and append-only lets parallel tool branches extend the surface without
 * colliding on shared registry logic.
 */
const TOOL_REGISTRARS: readonly ToolRegistrar[] = [
  registerListCollections,
  registerListRequests,
  registerGetRequest,
  registerListEnvironments,
  registerGetEnvironment,
  registerRun,
];

/**
 * The names of every tool this server registers, in registration order.
 * Exposed so registration can be asserted at runtime rather than only through
 * the type system.
 */
export const TOOL_NAMES: readonly string[] = [
  LIST_COLLECTIONS_TOOL_NAME,
  LIST_REQUESTS_TOOL_NAME,
  GET_REQUEST_TOOL_NAME,
  LIST_ENVIRONMENTS_TOOL_NAME,
  GET_ENVIRONMENT_TOOL_NAME,
  RUN_TOOL_NAME,
];

/**
 * Register every MCP tool onto the given server.
 *
 * Decoupled from {@link createServer} and the entry point so tool registration
 * is independently testable.
 */
export function registerTools(server: McpServer, config: Config): void {
  for (const register of TOOL_REGISTRARS) {
    register(server, config);
  }
}
