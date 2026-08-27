import type { CallToolResult } from "@modelcontextprotocol/server";

import { BrunoMcpError, toMcpErrorContent } from "../bruno/errors.js";
import { logger } from "../logger.js";

/**
 * Convert a thrown error into an MCP tool error result.
 *
 * A {@link BrunoMcpError} surfaces its stable `{ code, message }` contract as
 * both a human-readable text block and machine-readable `structuredContent`.
 * Any other error is reported generically so implementation details never leak
 * to the client.
 *
 * The result is flagged with `isError: true`. Note this marks a *tool* error
 * (a normal MCP tool result the client can inspect), not a protocol error, a
 * failed Bruno run, for example, is a successful tool call.
 */
export function toToolErrorResult(error: unknown): CallToolResult {
  if (error instanceof BrunoMcpError) {
    const content = toMcpErrorContent(error);
    return {
      isError: true,
      content: [{ type: "text", text: `${content.code}: ${content.message}` }],
      structuredContent: { ...content },
    };
  }

  // Unexpected errors are programming faults, not part of the stable error
  // model. Never forward their raw message to the client (it may carry
  // internal detail); return a fixed opaque message and log the real cause to
  // stderr for debugging.
  logger.error("Unhandled tool error", {
    message: error instanceof Error ? error.message : String(error),
  });
  return {
    isError: true,
    content: [{ type: "text", text: "An unexpected error occurred." }],
  };
}

/**
 * Execute a tool handler, converting any thrown error into an MCP error result
 * via {@link toToolErrorResult}. Tool handlers should run their body through
 * this helper so a thrown {@link BrunoMcpError} becomes structured MCP error
 * content instead of rejecting the underlying request.
 */
export async function runTool(
  handler: () => CallToolResult | Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await handler();
  } catch (error) {
    return toToolErrorResult(error);
  }
}

/** Placeholder result for a tool whose behavior has not landed yet. */
export function notImplementedResult(toolName: string): CallToolResult {
  return {
    isError: true,
    content: [
      { type: "text", text: `The ${toolName} tool is not implemented yet.` },
    ],
  };
}
