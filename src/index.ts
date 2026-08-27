#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { BrunoMcpError } from "./bruno/errors.js";
import { validateBrunoVersion } from "./bruno/version.js";
import { type Config, loadConfig } from "./config/config.js";
import { createLogger } from "./logger.js";
import { createServer } from "./server.js";

/**
 * CLI entry point. Loads configuration, gates on a supported Bruno
 * CLI, then serves MCP over stdio.
 *
 * stdout is reserved exclusively for MCP protocol traffic; every diagnostic is
 * written to stderr.
 */
async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    // The configured log level is unknown until config parses, so report the
    // (already actionable) message straight to stderr and exit non-zero.
    process.stderr.write(`${messageOf(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const logger = createLogger({ level: config.logLevel });

  try {
    const version = await validateBrunoVersion({ bru: config.bru });
    logger.info("Detected supported Bruno CLI", { version: version.raw });
  } catch (error) {
    // BRUNO_NOT_FOUND / UNSUPPORTED_BRUNO_VERSION: fail fast with an actionable
    // message on stderr and a non-zero exit status.
    if (error instanceof BrunoMcpError) {
      logger.error(error.message, { code: error.code });
    } else {
      logger.error(messageOf(error));
    }
    process.exitCode = 1;
    return;
  }

  // Out-of-band serving errors (transport failures, a throwing factory) are
  // otherwise swallowed by the SDK; route them to stderr.
  serveStdio(() => createServer(config), {
    onerror: (error) => logger.error("MCP serving error", { message: error.message }),
  });
  logger.info("Bruno MCP server ready", {
    root: config.root,
    logLevel: config.logLevel,
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void main().catch((error: unknown) => {
  process.stderr.write(`Fatal: ${messageOf(error)}\n`);
  process.exitCode = 1;
});
