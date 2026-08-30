import { realpathSync } from "node:fs";

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";

import type { BruProcessResult } from "../../src/bruno/cli.js";
import { type Config, loadConfig } from "../../src/config/config.js";
import { REDACTED } from "../../src/security/redact.js";
import {
  type RunDependencies,
  handleRun,
  registerRun,
  runInputSchema,
} from "../../src/tools/run.js";
import { runTool } from "../../src/tools/result.js";

const root = realpathSync(new URL("../fixtures/workspace", import.meta.url));
const baseConfig = loadConfig({ BRUNO_MCP_ROOT: root });

type RunProcess = NonNullable<RunDependencies["runProcess"]>;
type RunProcessOptions = Parameters<RunProcess>[0];

function input(overrides: Record<string, unknown> = {}) {
  return runInputSchema.parse({ collection: "example", ...overrides });
}

function processResult(
  overrides: Partial<BruProcessResult> = {},
): BruProcessResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    reportPath: "/tmp/bruno-mcp-test/report.json",
    ...overrides,
  };
}

function reportWithBody(body: unknown): string {
  return JSON.stringify([
    {
      results: [
        {
          path: "Health.yml",
          name: "Health",
          request: { method: "GET", url: "http://localhost/health" },
          response: { status: 200, data: body },
          testResults: [{ description: "returns 200", status: "pass" }],
        },
      ],
      summary: {
        totalRequests: 1,
        passedRequests: 1,
        failedRequests: 0,
      },
    },
  ]);
}

describe("runInputSchema", () => {
  it("applies safe execution defaults", () => {
    expect(runInputSchema.parse({ collection: "example" })).toEqual({
      collection: "example",
      targets: [],
      bail: false,
      testsOnly: false,
      sandbox: "safe",
      insecure: false,
      responseBodyMode: "onFailure",
    });
  });

  it("rejects invalid delays, variables, and response body options", () => {
    expect(() =>
      runInputSchema.parse({ collection: "example", delayMs: -1 }),
    ).toThrow();
    expect(() =>
      runInputSchema.parse({
        collection: "example",
        variables: { retries: 3 },
      }),
    ).toThrow();
    expect(() =>
      runInputSchema.parse({
        collection: "example",
        responseBodyMode: "errors",
      }),
    ).toThrow();
    expect(() =>
      runInputSchema.parse({
        collection: "example",
        maxResponseBodyBytes: 0,
      }),
    ).toThrow();
  });
});

describe("handleRun policy", () => {
  it("returns DEVELOPER_SANDBOX_DISABLED without invoking Bruno", async () => {
    const runProcess = vi.fn<RunProcess>();

    const result = await runTool(() =>
      handleRun(baseConfig, input({ sandbox: "developer" }), { runProcess }),
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      code: "DEVELOPER_SANDBOX_DISABLED",
      message: "Developer sandbox execution is disabled by server policy.",
    });
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("returns INSECURE_DISABLED without invoking Bruno", async () => {
    const runProcess = vi.fn<RunProcess>();

    const result = await runTool(() =>
      handleRun(baseConfig, input({ insecure: true }), { runProcess }),
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      code: "INSECURE_DISABLED",
      message: "Insecure TLS execution is disabled by server policy.",
    });
    expect(runProcess).not.toHaveBeenCalled();
  });
});

describe("handleRun execution", () => {
  it("composes arguments and returns a normalized, redacted result", async () => {
    const calls: RunProcessOptions[] = [];
    const runProcess: RunProcess = async (options) => {
      calls.push(options);
      return processResult({
        reportRaw: reportWithBody({
          Authorization: "Bearer private-token",
          value: "visible",
        }),
      });
    };
    const config: Config = {
      ...baseConfig,
      bru: "/opt/bruno/bin/bru",
      timeoutMs: 4_321,
    };

    const result = await handleRun(
      config,
      input({
        targets: ["Health.yml"],
        environment: "Local",
        variables: { locale: "en-US" },
        bail: true,
        responseBodyMode: "full",
        maxResponseBodyBytes: 1_024,
      }),
      { runProcess },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      binary: "/opt/bruno/bin/bru",
      collectionRoot: realpathSync(new URL("../fixtures/workspace/example", import.meta.url)),
      timeoutMs: 4_321,
    });
    expect(calls[0]!.buildArgs("/tmp/report.json")).toEqual([
      "run",
      "Health.yml",
      "--env=Local",
      "--env-var=locale=en-US",
      "--bail",
      "--reporter-json",
      "/tmp/report.json",
    ]);
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      isError: false,
      execution: { status: "passed", exitCode: 0 },
      summary: { total: 1, passed: 1, failed: 0 },
      results: [
        {
          path: "Health.yml",
          response: {
            status: 200,
            body: { Authorization: REDACTED, value: "visible" },
          },
        },
      ],
    });
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(result)).not.toContain("private-token");
  });

  it("keeps exit code 1 as an inspectable non-error result", async () => {
    const runProcess: RunProcess = async () =>
      processResult({
        exitCode: 1,
        reportRaw: JSON.stringify([
          {
            results: [
              {
                path: "Failure.yml",
                status: "failed",
                response: { status: 200, data: { value: "actual" } },
                assertionResults: [
                  {
                    lhsExpr: "res.status",
                    rhsExpr: "201",
                    status: "fail",
                    error: "expected 200 to equal 201",
                  },
                ],
              },
            ],
          },
        ]),
      });

    const result = await handleRun(baseConfig, input(), { runProcess });

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      isError: false,
      execution: { status: "failed", exitCode: 1 },
      summary: { total: 1, passed: 0, failed: 1 },
      results: [
        {
          response: { status: 200, body: { value: "actual" } },
          tests: [
            {
              status: "failed",
              error: "expected 200 to equal 201",
            },
          ],
        },
      ],
    });
  });

  it("omits successful bodies by default without changing result details", async () => {
    const runProcess: RunProcess = async () =>
      processResult({ reportRaw: reportWithBody({ value: "large payload" }) });

    const result = await handleRun(baseConfig, input(), { runProcess });

    expect(result.structuredContent).toMatchObject({
      execution: { status: "passed", exitCode: 0 },
      summary: { total: 1, passed: 1, failed: 0 },
      results: [
        {
          response: { status: 200 },
          tests: [{ name: "returns 200", status: "passed" }],
        },
      ],
    });
    expect(
      (
        result.structuredContent as
          | { results?: { response: unknown }[] }
          | undefined
      )?.results?.[0]?.response,
    ).toEqual({ status: 200 });
  });

  it("supports suppressing failed bodies and limiting full output", async () => {
    const runProcess: RunProcess = async () =>
      processResult({
        exitCode: 1,
        reportRaw: JSON.stringify([
          {
            results: [
              {
                path: "Failure.yml",
                response: { status: 200, data: "four" },
                assertionResults: [{ status: "fail" }],
              },
            ],
          },
        ]),
      });

    const withoutBodies = await handleRun(
      baseConfig,
      input({ responseBodyMode: "none" }),
      { runProcess },
    );
    const limitedFull = await handleRun(
      baseConfig,
      input({ responseBodyMode: "full", maxResponseBodyBytes: 3 }),
      { runProcess },
    );

    expect(
      (
        withoutBodies.structuredContent as
          | { results?: { response: unknown }[] }
          | undefined
      )?.results?.[0]?.response,
    ).toEqual({ status: 200 });
    expect(
      (
        limitedFull.structuredContent as
          | { results?: { response: unknown }[] }
          | undefined
      )?.results?.[0]?.response,
    ).toEqual({
      status: 200,
      bodyTruncated: true,
      originalBodyBytes: 4,
    });
  });

  it("marks exit codes from 2 through 255 as MCP tool errors", async () => {
    for (const exitCode of [2, 9, 255]) {
      const runProcess: RunProcess = async () =>
        processResult({ exitCode, stderr: "bru failed" });

      const result = await handleRun(baseConfig, input(), { runProcess });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        isError: true,
        code: "BRUNO_EXECUTION_ERROR",
        execution: { status: "error", exitCode },
        diagnostics: { stderr: "bru failed" },
      });
    }
  });

  it("rejects oversized raw reports before returning reporter content", async () => {
    const config: Config = { ...baseConfig, maxReportBytes: 10 };
    const runProcess: RunProcess = async () =>
      processResult({ reportRaw: "private reporter contents" });

    const result = await runTool(() =>
      handleRun(config, input(), { runProcess }),
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "REPORT_TOO_LARGE" });
    expect(JSON.stringify(result)).not.toContain("private reporter contents");
  });

  it("does not write variable override values to logs", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const runProcess: RunProcess = async (options) => {
      options.buildArgs("/tmp/report.json");
      return processResult({ reportRaw: reportWithBody({ ok: true }) });
    };

    await handleRun(
      baseConfig,
      input({ variables: { token: "do-not-log-this-value" } }),
      { runProcess },
    );

    const logged = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(logged).not.toContain("do-not-log-this-value");
  });
});

describe("registerRun", () => {
  it("registers the schema and the full variables warning", () => {
    let captured:
      | {
          name: string;
          config: { description?: string; inputSchema?: unknown };
          handler: (input: unknown) => CallToolResult | Promise<CallToolResult>;
        }
      | undefined;
    const server = {
      registerTool(
        name: string,
        config: { description?: string; inputSchema?: unknown },
        handler: (input: unknown) => CallToolResult | Promise<CallToolResult>,
      ) {
        captured = { name, config, handler };
      },
    } as unknown as McpServer;

    registerRun(server, baseConfig);

    expect(captured?.name).toBe("bruno_run");
    expect(captured?.config.inputSchema).toBe(runInputSchema);
    expect(captured?.config.description).toContain(
      "Do not pass credentials or other secrets through variables.",
    );
    expect(captured?.config.description).toContain(
      "MCP tool arguments may be visible to the model and host.",
    );
  });
});
