import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrunoMcpError } from "../../src/bruno/errors.js";
import { type Config, loadConfig } from "../../src/config/config.js";
import * as requestDiscovery from "../../src/opencollection/request.js";
import {
  SEARCH_REQUESTS_TOOL_NAME,
  registerSearchRequests,
  searchRequests,
} from "../../src/tools/search-requests.js";

let root: string;
let config: Config;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bruno-mcp-search-")));

  writeCollection("airline", "Shared APIs");
  write(
    "airline/Zed.yml",
    request("Search Flights", "http", 1, "GET", "{{baseUrl}}/flights"),
  );
  write("airline/Graph/Search.yml", request("Inventory Query", "graphql", 3));

  writeCollection("hotel", "Shared APIs");
  write(
    "hotel/Hotel/Search.yml",
    request(
      "Search Properties",
      "http",
      2,
      "POST",
      "{{baseUrl}}/properties",
    ),
  );
  write(
    "hotel/Health.yml",
    request("Health", "http", 1, "GET", "{{baseUrl}}/health"),
  );

  write("invalid/opencollection.yml", "opencollection: 1.0.0\ninfo: bad\n");
  config = loadConfig({ BRUNO_MCP_ROOT: root });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function write(relativePath: string, content: string): void {
  const absolute = join(root, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function writeCollection(id: string, name: string): void {
  write(
    `${id}/opencollection.yml`,
    `opencollection: 1.0.0\ninfo:\n  name: ${name}\n`,
  );
}

function request(
  name: string,
  type: string,
  sequence: number,
  method?: string,
  url?: string,
): string {
  const lines = [
    "info:",
    `  name: ${name}`,
    `  type: ${type}`,
    `  seq: ${sequence}`,
  ];
  if (method !== undefined || url !== undefined) {
    lines.push("http:");
  }
  if (method !== undefined) {
    lines.push(`  method: ${method}`);
  }
  if (url !== undefined) {
    lines.push(`  url: "${url}"`);
  }
  return `${lines.join("\n")}\n`;
}

describe("searchRequests", () => {
  it("returns tagged cross-collection matches in deterministic order", () => {
    expect(searchRequests(config, { query: "search" })).toEqual({
      results: [
        {
          collection: "airline",
          path: "Graph/Search.yml",
          name: "Inventory Query",
          type: "graphql",
          sequence: 3,
        },
        {
          collection: "airline",
          path: "Zed.yml",
          name: "Search Flights",
          type: "http",
          sequence: 1,
          method: "GET",
          url: "{{baseUrl}}/flights",
        },
        {
          collection: "hotel",
          path: "Hotel/Search.yml",
          name: "Search Properties",
          type: "http",
          sequence: 2,
          method: "POST",
          url: "{{baseUrl}}/properties",
        },
      ],
    });
  });

  it("matches query against name, path, and literal URL", () => {
    expect(searchRequests(config, { query: "FLIGHTS" }).results).toHaveLength(1);
    expect(searchRequests(config, { query: "graph" }).results).toHaveLength(1);
    expect(searchRequests(config, { query: "properties" }).results).toEqual([
      expect.objectContaining({
        collection: "hotel",
        url: "{{baseUrl}}/properties",
      }),
    ]);
  });

  it("combines case-insensitive query, method, and type filters", () => {
    expect(
      searchRequests(config, {
        query: "SEARCH",
        method: " post ",
        type: "HTTP",
      }).results,
    ).toEqual([
      expect.objectContaining({
        collection: "hotel",
        path: "Hotel/Search.yml",
      }),
    ]);
  });

  it("filters by request type", () => {
    expect(searchRequests(config, { query: "search", type: "GraphQL" }).results).toEqual([
      expect.objectContaining({
        collection: "airline",
        path: "Graph/Search.yml",
      }),
    ]);
  });

  it("returns no results for a nonmatching query", () => {
    expect(searchRequests(config, { query: "missing" })).toEqual({ results: [] });
  });

  it("continues past malformed collections", () => {
    expect(searchRequests(config, { query: "health" }).results).toEqual([
      expect.objectContaining({ collection: "hotel", path: "Health.yml" }),
    ]);
  });

  it("skips a collection when request discovery reports a skippable error", () => {
    const discoverRequests = requestDiscovery.discoverRequests;
    vi.spyOn(requestDiscovery, "discoverRequests").mockImplementation(
      (workspaceRoot, collection) => {
        if (collection === "airline") {
          throw new BrunoMcpError("INVALID_COLLECTION", "invalid collection");
        }
        return discoverRequests(workspaceRoot, collection);
      },
    );

    expect(searchRequests(config, { query: "health" }).results).toEqual([
      expect.objectContaining({ collection: "hotel", path: "Health.yml" }),
    ]);
  });
});

describe("tool registration", () => {
  it("registers bruno_search_requests and returns structured content", async () => {
    let name: string | undefined;
    let handler:
      | ((input: { query: string }) => CallToolResult | Promise<CallToolResult>)
      | undefined;
    const fakeServer = {
      registerTool(
        toolName: string,
        _toolConfig: unknown,
        toolHandler: typeof handler,
      ) {
        name = toolName;
        handler = toolHandler;
      },
    } as unknown as McpServer;

    registerSearchRequests(fakeServer, config);

    expect(name).toBe(SEARCH_REQUESTS_TOOL_NAME);
    if (handler === undefined) {
      throw new Error("registrar did not register a tool");
    }
    const result = await handler({ query: "health" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      results: [
        expect.objectContaining({ collection: "hotel", path: "Health.yml" }),
      ],
    });
  });
});
