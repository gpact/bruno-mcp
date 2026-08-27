import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/server";

import type { Config } from "./config/config.js";
import { registerTools } from "./tools/index.js";

/** MCP server name advertised to clients. */
export const SERVER_NAME = "bruno";

/**
 * Package version advertised to MCP clients. Read once from `package.json`,
 * resolved relative to this module so it is correct both when running from
 * `src/` (tests via tsx/vitest) and from the compiled `dist/` binary.
 */
export const PACKAGE_VERSION = readPackageVersion();

function readPackageVersion(): string {
  try {
    const url = new URL("../package.json", import.meta.url);
    const parsed = JSON.parse(readFileSync(url, "utf8")) as {
      version?: unknown;
    };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // Fall through to the fallback below; a missing/unreadable package.json
    // must not prevent the server from starting.
  }

  return "0.0.0";
}

/**
 * Construct the MCP server and register every tool.
 *
 * Server construction is kept separate from process startup so MCP behavior
 * can be exercised in tests without spawning a process or touching stdio:
 * pass a {@link Config} and connect the returned server to any transport.
 */
export function createServer(config: Config): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: PACKAGE_VERSION,
  });

  registerTools(server, config);

  return server;
}
