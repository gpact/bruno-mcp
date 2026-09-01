import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
  McpServer,
} from "@modelcontextprotocol/server";
import type { JSONRPCMessage } from "@modelcontextprotocol/server";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import {
  PACKAGE_VERSION,
  SERVER_NAME,
  createServer,
} from "../../src/server.js";
import { TOOL_NAMES } from "../../src/tools/index.js";

/**
 * A tiny JSON-RPC client over an in-memory transport, just enough to drive a
 * real MCP handshake and `tools/list` without spawning a process. This lets us
 * assert tool registration at runtime rather than only through the types.
 */
async function connectClient(server: McpServer): Promise<{
  request: (
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<{ result?: any; error?: any }>;
  notify: (method: string, params?: Record<string, unknown>) => Promise<void>;
  close: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const pending = new Map<string, (message: any) => void>();

  clientTransport.onmessage = (message: any) => {
    if (message?.id !== undefined && pending.has(String(message.id))) {
      const resolve = pending.get(String(message.id))!;
      pending.delete(String(message.id));
      resolve(message);
    }
  };

  await server.connect(serverTransport);
  await clientTransport.start();

  let nextId = 0;

  return {
    request(method, params = {}) {
      const id = ++nextId;
      const response = new Promise<{ result?: any; error?: any }>((resolve) => {
        pending.set(String(id), resolve);
      });
      void clientTransport.send({
        jsonrpc: "2.0",
        id,
        method,
        params,
      } as unknown as JSONRPCMessage);
      return response;
    },
    async notify(method, params = {}) {
      await clientTransport.send({
        jsonrpc: "2.0",
        method,
        params,
      } as unknown as JSONRPCMessage);
    },
    async close() {
      await clientTransport.close();
      await server.close();
    },
  };
}

async function initialize(
  client: Awaited<ReturnType<typeof connectClient>>,
): Promise<{ result?: any; error?: any }> {
  const init = await client.request("initialize", {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "bruno-mcp-test", version: "0.0.0" },
  });
  await client.notify("notifications/initialized");
  return init;
}

const config = loadConfig({});

describe("createServer", () => {
  it("constructs an MCP server without spawning a process", () => {
    const server = createServer(config);
    expect(server).toBeInstanceOf(McpServer);
  });

  it("starts by connecting to a transport", async () => {
    const server = createServer(config);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await expect(server.connect(serverTransport)).resolves.toBeUndefined();

    await clientTransport.close();
    await server.close();
  });

  it("advertises the package name and version in the handshake", async () => {
    const client = await connectClient(createServer(config));

    const init = await initialize(client);

    expect(init.error).toBeUndefined();
    expect(init.result?.serverInfo).toMatchObject({
      name: SERVER_NAME,
      version: PACKAGE_VERSION,
    });

    await client.close();
  });
});

describe("tool registration", () => {
  it("registers the eight required tools over MCP", async () => {
    const client = await connectClient(createServer(config));
    await initialize(client);

    const listed = await client.request("tools/list", {});

    expect(listed.error).toBeUndefined();
    const names: string[] = (listed.result?.tools ?? []).map(
      (tool: { name: string }) => tool.name,
    );

    for (const required of [
      "bruno_create_request",
      "bruno_list_collections",
      "bruno_list_requests",
      "bruno_get_request",
      "bruno_list_environments",
      "bruno_get_environment",
      "bruno_run",
      "bruno_search_requests",
    ]) {
      expect(names).toContain(required);
    }

    await client.close();
  });

  it("exposes exactly the tools declared in the registry", async () => {
    const client = await connectClient(createServer(config));
    await initialize(client);

    const listed = await client.request("tools/list", {});
    const names: string[] = (listed.result?.tools ?? []).map(
      (tool: { name: string }) => tool.name,
    );

    expect([...names].sort()).toEqual([...TOOL_NAMES].sort());

    await client.close();
  });

  it("creates a request and reports validation and conflict errors over MCP", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "bruno-mcp-server-create-")));
    mkdirSync(join(root, "api"));
    writeFileSync(
      join(root, "api/opencollection.yml"),
      "opencollection: 1.0.0\ninfo:\n  name: API\n",
    );
    const client = await connectClient(
      createServer(loadConfig({ BRUNO_MCP_ROOT: root })),
    );

    try {
      await initialize(client);
      const arguments_ = {
        collection: "api",
        request: "Users/Create.yml",
        name: "Create User",
        method: "POST",
        url: "{{baseUrl}}/users",
        body: [
          {
            title: "JSON",
            selected: true,
            body: { type: "json", data: '{"name":"Ada"}' },
          },
          {
            title: "Form",
            body: {
              type: "form-urlencoded",
              data: [{ name: "name", value: "Ada" }],
            },
          },
        ],
      };

      const created = await client.request("tools/call", {
        name: "bruno_create_request",
        arguments: arguments_,
      });
      expect(created.error).toBeUndefined();
      expect(created.result?.isError).toBeFalsy();
      expect(created.result).toMatchObject({
        structuredContent: {
          collection: "api",
          path: "Users/Create.yml",
        },
      });

      const invalid = await client.request("tools/call", {
        name: "bruno_create_request",
        arguments: { ...arguments_, request: "Users/Invalid.yml", url: "" },
      });
      expect(invalid.error).toBeUndefined();
      expect(invalid.result?.isError).toBe(true);

      const conflict = await client.request("tools/call", {
        name: "bruno_create_request",
        arguments: arguments_,
      });
      expect(conflict.error).toBeUndefined();
      expect(conflict.result).toMatchObject({
        isError: true,
        structuredContent: { code: "REQUEST_ALREADY_EXISTS" },
      });
    } finally {
      await client.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
