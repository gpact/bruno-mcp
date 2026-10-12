import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { buildRunArgs, type RunArgsParams } from "../bruno/arguments.js";
import { type BruProcessResult, runBruProcess } from "../bruno/cli.js";
import { BrunoMcpError } from "../bruno/errors.js";
import {
  assertReportSize,
  filterResponseBodies,
  normalizeBruReport,
} from "../bruno/report.js";
import type { Config } from "../config/config.js";
import { resolveCollection } from "../opencollection/collection.js";
import { redactReport } from "../security/redact.js";
import { jsonResult, runTool } from "./result.js";

/** MCP tool name. */
export const RUN_TOOL_NAME = "bruno_run";

/** Input schema for the `bruno_run` tool. */
export const runInputSchema = z.object({
  collection: z
    .string()
    .describe(
      "Collection path relative to workspace root (as returned by bruno_list_collections).",
    ),
  targets: z
    .array(z.string())
    .default([])
    .describe(
      "Request files or folders relative to collection root, or empty array for entire collection.",
    ),
  environment: z
    .string()
    .optional()
    .describe("Bruno environment name to use for this run."),
  variables: z
    .record(z.string(), z.string())
    .optional()
    .describe("Non-secret environment variable overrides."),
  bail: z
    .boolean()
    .default(false)
    .describe("Stop after the first failing request, test, or assertion."),
  testsOnly: z
    .boolean()
    .default(false)
    .describe("Only run requests containing tests or active assertions."),
  delayMs: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Delay between requests in milliseconds."),
  tags: z
    .array(z.string())
    .optional()
    .describe("Tags to include."),
  excludeTags: z
    .array(z.string())
    .optional()
    .describe("Tags to exclude."),
  sandbox: z
    .enum(["safe", "developer"])
    .default("safe")
    .describe(
      "JavaScript sandbox mode (safe or developer).",
    ),
  insecure: z
    .boolean()
    .default(false)
    .describe(
      "Disable normal TLS certificate verification.",
    ),
  responseBodyMode: z
    .enum(["none", "onFailure", "full"])
    .default("onFailure")
    .describe(
      "When to return response bodies: none, onFailure, or full.",
    ),
  maxResponseBodyBytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Maximum bytes for each returned response body.",
    ),
});

/** Validated input for {@link handleRun}. */
export type RunInput = z.infer<typeof runInputSchema>;

/** Injectable process seam used by focused tool-handler tests. */
export interface RunDependencies {
  readonly runProcess?: (options: {
    readonly binary: string;
    readonly collectionRoot: string;
    readonly timeoutMs: number;
    readonly buildArgs: (reportPath: string) => readonly string[];
  }) => Promise<BruProcessResult>;
}

function enforcePolicies(config: Config, input: RunInput): void {
  if (input.sandbox === "developer" && !config.allowDeveloperSandbox) {
    throw new BrunoMcpError(
      "DEVELOPER_SANDBOX_DISABLED",
      "Developer sandbox execution is disabled by server policy.",
    );
  }

  if (input.insecure && !config.allowInsecure) {
    throw new BrunoMcpError(
      "INSECURE_DISABLED",
      "Insecure TLS execution is disabled by server policy.",
    );
  }
}

/** Execute a validated `bruno_run` request and return its sanitized report. */
export async function handleRun(
  config: Config,
  input: RunInput,
  dependencies: RunDependencies = {},
): Promise<CallToolResult> {
  enforcePolicies(config, input);

  const collectionRoot = resolveCollection(config.root, input.collection);
  const runArgs: RunArgsParams = {
    collection: input.collection,
    targets: input.targets,
    bail: input.bail,
    testsOnly: input.testsOnly,
    sandbox: input.sandbox,
    insecure: input.insecure,
    ...(input.environment === undefined
      ? {}
      : { environment: input.environment }),
    ...(input.variables === undefined ? {} : { variables: input.variables }),
    ...(input.delayMs === undefined ? {} : { delayMs: input.delayMs }),
    ...(input.tags === undefined ? {} : { tags: input.tags }),
    ...(input.excludeTags === undefined ? {} : { excludeTags: input.excludeTags }),
  };
  const runProcess = dependencies.runProcess ?? runBruProcess;
  const processResult = await runProcess({
    binary: config.bru,
    collectionRoot,
    timeoutMs: config.timeoutMs,
    buildArgs: (reportPath) => [
      "run",
      ...buildRunArgs(runArgs, { reportPath, config }),
    ],
  });

  assertReportSize(processResult.reportRaw, config.maxReportBytes);
  const normalized = normalizeBruReport({
    exitCode: processResult.exitCode,
    stderr: processResult.stderr,
    ...(processResult.reportRaw === undefined
      ? {}
      : { reportRaw: processResult.reportRaw }),
  });
  const report = filterResponseBodies(redactReport(normalized), {
    mode: input.responseBodyMode,
    ...(input.maxResponseBodyBytes === undefined
      ? {}
      : { maxBodyBytes: input.maxResponseBodyBytes }),
  });

  return {
    ...jsonResult({ ...report }),
    isError: report.isError,
  };
}

/** Register the `bruno_run` tool. */
export function registerRun(
  server: McpServer,
  config: Config,
  dependencies: RunDependencies = {},
): void {
  server.registerTool(
    RUN_TOOL_NAME,
    {
      title: "Run Bruno requests",
      description:
        "Execute requests, folders, or an entire Bruno collection using Bruno CLI v4. Returns structured execution results. Do not pass credentials or other secrets through variables. MCP tool arguments may be visible to the model and host.",
      inputSchema: runInputSchema,
    },
    (input) => runTool(() => handleRun(config, input, dependencies)),
  );
}
