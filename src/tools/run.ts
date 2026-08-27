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
      "Collection identifier: the collection's path relative to the workspace root (as returned by bruno_list_collections), not its display name.",
    ),
  targets: z
    .array(z.string())
    .default([])
    .describe(
      "Request files or folders relative to the collection root. An empty list runs the entire collection.",
    ),
  environment: z
    .string()
    .optional()
    .describe("Bruno environment name to use for this run."),
  variables: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Non-secret environment variable overrides. Do not include credentials or other secrets.",
    ),
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
  sandbox: z
    .enum(["safe", "developer"])
    .default("safe")
    .describe(
      "JavaScript sandbox mode. Developer mode must be enabled by server policy.",
    ),
  insecure: z
    .boolean()
    .default(false)
    .describe(
      "Disable normal TLS certificate verification. Must be enabled by server policy.",
    ),
  responseBodyMode: z
    .enum(["none", "onFailure", "full"])
    .default("onFailure")
    .describe(
      "Response bodies to return in the MCP payload: none, only results with failed tests or assertions, or all results.",
    ),
  maxResponseBodyBytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Maximum serialized UTF-8 size of each returned response body. Oversized bodies are replaced by size metadata.",
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
        "Execute requests, folders, or an entire Bruno collection using Bruno CLI v4. Returns structured request, response, test, and assertion results. Variable overrides must not contain secrets. Do not pass credentials or other secrets through variables. MCP tool arguments may be visible to the model and host. Provide secrets through Bruno's normal environment or process environment mechanisms instead.",
      inputSchema: runInputSchema,
    },
    (input) => runTool(() => handleRun(config, input, dependencies)),
  );
}
