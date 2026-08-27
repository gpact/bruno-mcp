import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "../../src/config/config.js";
import { loadConfig } from "../../src/config/config.js";
import {
  GET_ENVIRONMENT_TOOL_NAME,
  registerGetEnvironment,
} from "../../src/tools/get-environment.js";
import {
  LIST_ENVIRONMENTS_TOOL_NAME,
  registerListEnvironments,
} from "../../src/tools/list-environments.js";

interface ToolConfig {
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

type ToolHandler = (
  input: Record<string, unknown>,
) => Promise<CallToolResult> | CallToolResult;

interface CapturedTool {
  config: ToolConfig;
  handler: ToolHandler;
}

const LOCAL_ENV = `variables:
  - name: baseUrl
    value: http://localhost:4080
    secret: false

  - name: apiKey
    value: plaintext-should-be-hidden
    secret: true

  - name: clientSecret
    value: another-secret
    secret: true
`;

let root: string;
let config: Config;
let tools: Map<string, CapturedTool>;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bruno-mcp-env-tools-")));
  config = loadConfig({ BRUNO_MCP_ROOT: root });

  tools = new Map<string, CapturedTool>();
  const server = {
    registerTool(name: string, toolConfig: ToolConfig, handler: ToolHandler) {
      tools.set(name, { config: toolConfig, handler });
    },
  } as unknown as McpServer;

  registerListEnvironments(server, config);
  registerGetEnvironment(server, config);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function createCollection(relativePath: string, name = "Hotel API"): void {
  const directory = join(root, relativePath);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "opencollection.yml"),
    `opencollection: 1.0.0\ninfo:\n  name: ${name}\n`,
  );
}

function writeEnvironment(
  collectionPath: string,
  fileName: string,
  contents: string,
): void {
  const environmentsDir = join(root, collectionPath, "environments");
  mkdirSync(environmentsDir, { recursive: true });
  writeFileSync(join(environmentsDir, fileName), contents);
}

function tool(name: string): CapturedTool {
  const captured = tools.get(name);
  if (captured === undefined) {
    throw new Error(`tool ${name} was not registered`);
  }
  return captured;
}

async function call(
  name: string,
  input: Record<string, unknown>,
): Promise<CallToolResult> {
  return tool(name).handler(input);
}

describe("environment tool registration", () => {
  it("registers both environment tools with descriptions and input schemas", () => {
    const list = tool(LIST_ENVIRONMENTS_TOOL_NAME);
    const get = tool(GET_ENVIRONMENT_TOOL_NAME);

    expect(list.config.description).toBe(
      "List environments available to a Bruno collection without exposing variable values.",
    );
    expect(get.config.description).toBe(
      "Inspect a Bruno environment. Variables marked as secrets are always redacted.",
    );
    expect(list.config.inputSchema).toBeDefined();
    expect(get.config.inputSchema).toBeDefined();
  });

  it("does not advertise an output schema, avoiding client-side output validation mismatches", () => {
    expect(tool(LIST_ENVIRONMENTS_TOOL_NAME).config.outputSchema).toBeUndefined();
    expect(tool(GET_ENVIRONMENT_TOOL_NAME).config.outputSchema).toBeUndefined();
  });
});

describe("bruno_list_environments", () => {
  it("returns environment counts without any variable values", async () => {
    createCollection("hotel");
    writeEnvironment("hotel", "Production.yml", "variables: []\n");
    writeEnvironment("hotel", "Local.yml", LOCAL_ENV);

    const result = await call(LIST_ENVIRONMENTS_TOOL_NAME, {
      collection: "hotel",
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      environments: [
        {
          name: "Local",
          path: "environments/Local.yml",
          variableCount: 3,
          secretCount: 2,
        },
        {
          name: "Production",
          path: "environments/Production.yml",
          variableCount: 0,
          secretCount: 0,
        },
      ],
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("http://localhost:4080");
    expect(serialized).not.toContain("plaintext-should-be-hidden");
    expect(serialized).not.toContain("another-secret");
  });

  it("mirrors the structured payload as pretty-printed JSON text", async () => {
    createCollection("hotel");
    writeEnvironment("hotel", "Local.yml", LOCAL_ENV);

    const result = await call(LIST_ENVIRONMENTS_TOOL_NAME, {
      collection: "hotel",
    });

    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify(result.structuredContent, null, 2),
      },
    ]);
  });

  it("surfaces COLLECTION_NOT_FOUND as a structured tool error", async () => {
    const result = await call(LIST_ENVIRONMENTS_TOOL_NAME, {
      collection: "missing",
    });

    expect(result.isError).toBe(true);
    expect((result.structuredContent as { code: string }).code).toBe(
      "COLLECTION_NOT_FOUND",
    );
  });
});

describe("bruno_get_environment", () => {
  it("returns non-secret values and redacts secrets", async () => {
    createCollection("hotel");
    writeEnvironment("hotel", "Local.yml", LOCAL_ENV);

    const result = await call(GET_ENVIRONMENT_TOOL_NAME, {
      collection: "hotel",
      environment: "Local",
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      name: "Local",
      variables: [
        { name: "baseUrl", value: "http://localhost:4080", secret: false },
        { name: "apiKey", value: "[REDACTED]", secret: true },
        { name: "clientSecret", value: "[REDACTED]", secret: true },
      ],
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("plaintext-should-be-hidden");
    expect(serialized).not.toContain("another-secret");
  });

  it("resolves the environment by bare name and by relative path", async () => {
    createCollection("hotel");
    writeEnvironment("hotel", "Local.yml", LOCAL_ENV);

    const byName = await call(GET_ENVIRONMENT_TOOL_NAME, {
      collection: "hotel",
      environment: "Local",
    });
    const byPath = await call(GET_ENVIRONMENT_TOOL_NAME, {
      collection: "hotel",
      environment: "environments/Local.yml",
    });

    expect(byPath.structuredContent).toEqual(byName.structuredContent);
  });

  it("surfaces ENVIRONMENT_NOT_FOUND as a structured tool error", async () => {
    createCollection("hotel");
    writeEnvironment("hotel", "Local.yml", LOCAL_ENV);

    const result = await call(GET_ENVIRONMENT_TOOL_NAME, {
      collection: "hotel",
      environment: "Nope",
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      code: "ENVIRONMENT_NOT_FOUND",
      message: 'Environment "Nope" does not exist.',
    });
  });
});
