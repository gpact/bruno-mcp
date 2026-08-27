import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
  McpServer,
  type CallToolResult,
  type JSONRPCMessage,
} from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type BruProcessResult,
  runBruProcess,
} from "../../src/bruno/cli.js";
import { loadConfig } from "../../src/config/config.js";
import { REDACTED } from "../../src/security/redact.js";
import {
  RUN_TOOL_NAME,
  type RunDependencies,
  registerRun,
} from "../../src/tools/run.js";
import {
  startTestHttpServer,
  type TestHttpServer,
} from "./http-server.js";

const workspaceRoot = fileURLToPath(
  new URL("../fixtures/workspace/", import.meta.url),
);
const bruExecutable = fileURLToPath(
  new URL("../../node_modules/.bin/bru", import.meta.url),
);
const secret = "integration-test-secret";

interface RpcResponse {
  readonly result?: CallToolResult;
  readonly error?: unknown;
}

interface RunObservation {
  readonly result: CallToolResult;
  readonly processResults: BruProcessResult[];
}

type RunProcess = NonNullable<RunDependencies["runProcess"]>;

let httpServer: TestHttpServer;

beforeAll(async () => {
  httpServer = await startTestHttpServer({ slowDelayMs: 15_000 });
});

afterAll(async () => {
  await httpServer.close();
});

async function connectClient(server: McpServer): Promise<{
  request(method: string, params?: Record<string, unknown>): Promise<RpcResponse>;
  close(): Promise<void>;
}> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const pending = new Map<string, (response: RpcResponse) => void>();
  let nextId = 0;

  clientTransport.onmessage = (message) => {
    if ("id" in message) {
      const resolve = pending.get(String(message.id));
      if (resolve !== undefined) {
        pending.delete(String(message.id));
        resolve(message as RpcResponse);
      }
    }
  };

  await server.connect(serverTransport);
  await clientTransport.start();

  const request = (
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<RpcResponse> => {
    const id = ++nextId;
    const response = new Promise<RpcResponse>((resolve) => {
      pending.set(String(id), resolve);
    });
    void clientTransport.send({
      jsonrpc: "2.0",
      id,
      method,
      params,
    } as JSONRPCMessage);
    return response;
  };

  await request("initialize", {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "bruno-run-integration", version: "0.0.0" },
  });
  await clientTransport.send({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  } as JSONRPCMessage);

  return {
    request,
    async close() {
      await clientTransport.close();
      await server.close();
    },
  };
}

async function executeRun(
  arguments_: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<RunObservation> {
  const tempDirectories: string[] = [];
  const processResults: BruProcessResult[] = [];
  const runProcess: RunProcess = async (options) => {
    const result = await runBruProcess({
      ...options,
      makeTempDir: async () => {
        const directory = await mkdtemp(
          join(tmpdir(), "bruno-mcp-integration-"),
        );
        tempDirectories.push(directory);
        return directory;
      },
    });
    processResults.push(result);
    return result;
  };
  const config = loadConfig({
    BRUNO_MCP_ROOT: workspaceRoot,
    BRUNO_MCP_BRU: bruExecutable,
    BRUNO_MCP_TIMEOUT_MS: String(timeoutMs),
  });
  const server = new McpServer({
    name: "bruno-run-integration",
    version: "0.0.0",
  });
  registerRun(server, config, { runProcess });
  const client = await connectClient(server);

  try {
    const response = await client.request("tools/call", {
      name: RUN_TOOL_NAME,
      arguments: {
        collection: "example",
        variables: { baseUrl: httpServer.baseUrl },
        ...arguments_,
      },
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toBeDefined();
    expect(tempDirectories).toHaveLength(1);
    await Promise.all(
      tempDirectories.map(async (directory) => {
        await expect(access(directory)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }),
    );

    return { result: response.result!, processResults };
  } finally {
    await client.close();
  }
}

describe("bruno_run with Bruno CLI 4.x", () => {
  it("executes a successful request and normalizes its response", async () => {
    const { result, processResults } = await executeRun({
      targets: ["Health.yml"],
      environment: "Local",
    });

    expect(processResults).toHaveLength(1);
    expect(processResults[0]?.exitCode).toBe(0);
    expect(processResults[0]?.reportRaw).toBeDefined();
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      isError: false,
      execution: { status: "passed", exitCode: 0 },
      summary: { total: 1, passed: 1, failed: 0 },
      results: [
        {
          path: "Health.yml",
          response: { status: 200 },
        },
      ],
    });
  });

  it("keeps a failed assertion as an inspectable tool result", async () => {
    const { result, processResults } = await executeRun({
      targets: ["Failure.yml"],
      environment: "Local",
    });

    expect(processResults[0]?.exitCode).toBe(1);
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      isError: false,
      execution: { status: "failed", exitCode: 1 },
      results: [
        {
          response: { status: 200 },
          tests: expect.arrayContaining([
            expect.objectContaining({
              status: "failed",
              error: expect.any(String),
            }),
          ]),
        },
      ],
    });
  });

  it("maps Bruno's missing-environment exit to a tool error", async () => {
    const { result, processResults } = await executeRun({
      targets: ["Health.yml"],
      environment: "DoesNotExist",
    });

    expect(processResults[0]?.exitCode).toBe(6);
    expect(processResults[0]?.reportRaw).toBeUndefined();
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      isError: true,
      code: "ENVIRONMENT_NOT_FOUND",
      execution: { status: "error", exitCode: 6 },
      reportAvailable: false,
    });
  });

  it("redacts an echoed Authorization credential", async () => {
    const { result, processResults } = await executeRun({
      targets: ["Users/Get User.yml"],
      environment: "Local",
      responseBodyMode: "full",
    });

    expect(processResults[0]?.exitCode).toBe(0);
    expect(result.structuredContent).toMatchObject({
      results: [
        {
          response: {
            status: 200,
            body: { authorization: REDACTED },
          },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("terminates a timed-out run and returns EXECUTION_TIMEOUT", async () => {
    const slowRequestsBefore = httpServer.getSlowRequestCount();
    const { result, processResults } = await executeRun(
      {
        targets: ["Slow.yml"],
        environment: "Local",
      },
      5_000,
    );

    expect(httpServer.getSlowRequestCount()).toBe(slowRequestsBefore + 1);
    expect(processResults).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: "EXECUTION_TIMEOUT",
    });
  }, 15_000);
});
