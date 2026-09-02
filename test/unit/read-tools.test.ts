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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BrunoMcpError } from "../../src/bruno/errors.js";
import { type Config, loadConfig } from "../../src/config/config.js";
import { requestRevision } from "../../src/opencollection/revision.js";
import {
  LIST_COLLECTIONS_TOOL_NAME,
  listCollections,
  registerListCollections,
} from "../../src/tools/list-collections.js";
import {
  LIST_REQUESTS_TOOL_NAME,
  listRequests,
  registerListRequests,
} from "../../src/tools/list-requests.js";
import {
  GET_REQUEST_TOOL_NAME,
  getRequest,
  registerGetRequest,
} from "../../src/tools/get-request.js";

/** Search request source, reused to assert `includeSource` returns it verbatim. */
const SEARCH_SOURCE = [
  "info:",
  "  name: Search",
  "  type: http",
  "  seq: 1",
  "http:",
  "  method: POST",
  '  url: "{{baseUrl}}/api/hotel/properties"',
  "script:",
  "  req: |-",
  '    bru.setVar("ts", Date.now())',
  "",
].join("\n");

const RETRIEVE_SOURCE = [
  "info:",
  "  name: Retrieve",
  "  type: http",
  "  seq: 2",
  "http:",
  "  method: GET",
  '  url: "{{baseUrl}}/api/reservations/{{reservationId}}"',
  "",
].join("\n");

const FEED_SOURCE = [
  "info:",
  "  name: Feed",
  "  type: websocket",
  "  seq: 3",
  "websocket:",
  "  url: wss://example.com/feed",
  "",
].join("\n");

const FLIGHTS_SOURCE = [
  "info:",
  "  name: Flights",
  "  type: http",
  "  seq: 1",
  "http:",
  "  method: GET",
  '  url: "{{baseUrl}}/flights"',
  "",
].join("\n");

/** Expected normalized summaries for the hotel collection, in path order. */
const HOTEL_REQUESTS = [
  {
    path: "Hotel/Search.yml",
    name: "Search",
    type: "http",
    sequence: 1,
    method: "POST",
    url: "{{baseUrl}}/api/hotel/properties",
  },
  {
    path: "Reservation/Retrieve.yml",
    name: "Retrieve",
    type: "http",
    sequence: 2,
    method: "GET",
    url: "{{baseUrl}}/api/reservations/{{reservationId}}",
  },
  {
    path: "Ws/Feed.yml",
    name: "Feed",
    type: "websocket",
    sequence: 3,
  },
];

let root: string;
let config: Config;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bruno-mcp-read-tools-")));

  writeCollection("airline", "2.0.0", "Airline APIs");
  write("airline/Flights.yml", FLIGHTS_SOURCE);

  writeCollection("hotel", "1.0.0", "Hotel APIs");
  write("hotel/Hotel/Search.yml", SEARCH_SOURCE);
  write("hotel/Reservation/Retrieve.yml", RETRIEVE_SOURCE);
  write("hotel/Ws/Feed.yml", FEED_SOURCE);
  // A file without an info block: skipped by listing, still readable directly.
  write("hotel/NoInfo.yml", "http:\n  method: GET\n  url: /ping\n");

  // Sequence order (Zeta=1, Alpha=2) is the reverse of path order, proving the
  // list tool re-sorts by path rather than echoing discovery run order.
  writeCollection("sorting", "1.0.0", "Sorting");
  write("sorting/Group/Zeta.yml", "info:\n  name: Zeta\n  type: http\n  seq: 1\n");
  write("sorting/Group/Alpha.yml", "info:\n  name: Alpha\n  type: http\n  seq: 2\n");

  config = loadConfig({ BRUNO_MCP_ROOT: root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relativePath: string, content: string): void {
  const absolute = join(root, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function writeCollection(id: string, version: string, name: string): void {
  write(
    `${id}/opencollection.yml`,
    `opencollection: ${version}\ninfo:\n  name: ${name}\n`,
  );
}

function expectErrorCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`expected ${code} to be thrown`);
  } catch (error) {
    expect(error).toBeInstanceOf(BrunoMcpError);
    expect((error as BrunoMcpError).code).toBe(code);
  }
}

/** Register a single-tool registrar against a fake server and capture its callback. */
interface CapturedTool {
  name: string;
  handler: (input?: unknown) => CallToolResult | Promise<CallToolResult>;
}

function captureTool(
  register: (server: McpServer, config: Config) => void,
): CapturedTool {
  let captured: CapturedTool | undefined;
  const fakeServer = {
    registerTool(
      name: string,
      _config: unknown,
      handler: CapturedTool["handler"],
    ) {
      captured = { name, handler };
    },
  } as unknown as McpServer;

  register(fakeServer, config);
  if (captured === undefined) {
    throw new Error("registrar did not register a tool");
  }
  return captured;
}

describe("listCollections", () => {
  it("returns collections sorted by id with only public fields", () => {
    expect(listCollections(config)).toEqual({
      collections: [
        { id: "airline", name: "Airline APIs", openCollectionVersion: "2.0.0" },
        { id: "hotel", name: "Hotel APIs", openCollectionVersion: "1.0.0" },
        { id: "sorting", name: "Sorting", openCollectionVersion: "1.0.0" },
      ],
    });
  });

  it("returns an empty list when no collections exist", () => {
    const emptyRoot = realpathSync(mkdtempSync(join(tmpdir(), "bruno-mcp-empty-")));
    try {
      const emptyConfig = loadConfig({ BRUNO_MCP_ROOT: emptyRoot });
      expect(listCollections(emptyConfig)).toEqual({ collections: [] });
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});

describe("listRequests", () => {
  it("lists a collection's requests sorted by path with literal URLs", () => {
    expect(listRequests(config, { collection: "hotel" })).toEqual({
      collection: "hotel",
      requests: HOTEL_REQUESTS,
    });
  });

  it("sorts by path even when discovery run order differs", () => {
    expect(
      listRequests(config, { collection: "sorting" }).requests.map(
        (request) => request.path,
      ),
    ).toEqual(["Group/Alpha.yml", "Group/Zeta.yml"]);
  });

  it("filters by a case-insensitive query across name, path, and URL", () => {
    // Name match.
    expect(
      listRequests(config, { collection: "hotel", query: "SEARCH" }).requests.map(
        (request) => request.path,
      ),
    ).toEqual(["Hotel/Search.yml"]);

    // Path and URL match: "reservation" appears in both for Retrieve only.
    expect(
      listRequests(config, {
        collection: "hotel",
        query: "reservation",
      }).requests.map((request) => request.path),
    ).toEqual(["Reservation/Retrieve.yml"]);

    // URL-only match.
    expect(
      listRequests(config, {
        collection: "hotel",
        query: "properties",
      }).requests.map((request) => request.path),
    ).toEqual(["Hotel/Search.yml"]);
  });

  it("filters by method case-insensitively", () => {
    expect(
      listRequests(config, { collection: "hotel", method: "post" }).requests.map(
        (request) => request.path,
      ),
    ).toEqual(["Hotel/Search.yml"]);
  });

  it("filters by request type", () => {
    expect(
      listRequests(config, { collection: "hotel", type: "websocket" }).requests.map(
        (request) => request.path,
      ),
    ).toEqual(["Ws/Feed.yml"]);
  });

  it("applies query, method, and type filters together", () => {
    expect(
      listRequests(config, {
        collection: "hotel",
        query: "retrieve",
        method: "GET",
        type: "http",
      }).requests.map((request) => request.path),
    ).toEqual(["Reservation/Retrieve.yml"]);
  });

  it("treats blank filters as absent", () => {
    expect(
      listRequests(config, {
        collection: "hotel",
        query: "  ",
        method: "",
      }).requests,
    ).toEqual(HOTEL_REQUESTS);
  });

  it("throws COLLECTION_NOT_FOUND for an unknown collection", () => {
    expectErrorCode(
      () => listRequests(config, { collection: "ghost" }),
      "COLLECTION_NOT_FOUND",
    );
  });
});

describe("getRequest", () => {
  it("returns the parsed document and normalized metadata without a source by default", () => {
    const result = getRequest(config, {
      collection: "hotel",
      request: "Hotel/Search.yml",
    });

    expect(result).toEqual({
      collection: "hotel",
      path: "Hotel/Search.yml",
      revision: requestRevision(SEARCH_SOURCE),
      metadata: {
        name: "Search",
        type: "http",
        sequence: 1,
        method: "POST",
        url: "{{baseUrl}}/api/hotel/properties",
      },
      document: {
        info: { name: "Search", type: "http", seq: 1 },
        http: { method: "POST", url: "{{baseUrl}}/api/hotel/properties" },
        script: { req: 'bru.setVar("ts", Date.now())' },
      },
    });
    expect(result).not.toHaveProperty("source");
    expect(result.revision).toMatch(/^[A-Za-z0-9_-]{21}[AQgw]$/);
  });

  it("returns only the compact preflight fields in revision mode", () => {
    const result = getRequest(config, {
      collection: "hotel",
      request: "Hotel/Search.yml",
      responseMode: "revision",
    });

    expect(result).toEqual({
      collection: "hotel",
      path: "Hotel/Search.yml",
      revision: requestRevision(SEARCH_SOURCE),
    });
  });

  it("includes the raw source verbatim when includeSource is true", () => {
    const result = getRequest(config, {
      collection: "hotel",
      request: "Hotel/Search.yml",
      includeSource: true,
    });

    expect(result.source).toBe(SEARCH_SOURCE);
    expect(result.revision).toBe(requestRevision(SEARCH_SOURCE));
  });

  it("falls back to empty metadata for a file without an info block", () => {
    const result = getRequest(config, {
      collection: "hotel",
      request: "NoInfo.yml",
    });

    expect(result.metadata).toEqual({ name: "", type: "" });
    expect(result.document).toEqual({ http: { method: "GET", url: "/ping" } });
  });

  it("throws REQUEST_NOT_FOUND when the request does not exist", () => {
    expectErrorCode(
      () => getRequest(config, { collection: "hotel", request: "Hotel/Missing.yml" }),
      "REQUEST_NOT_FOUND",
    );
  });

  it("throws PATH_OUTSIDE_ROOT for a traversal attempt", () => {
    expectErrorCode(
      () => getRequest(config, { collection: "hotel", request: "../../etc/passwd" }),
      "PATH_OUTSIDE_ROOT",
    );
  });

  it("throws COLLECTION_NOT_FOUND for an unknown collection", () => {
    expectErrorCode(
      () => getRequest(config, { collection: "ghost", request: "Search.yml" }),
      "COLLECTION_NOT_FOUND",
    );
  });
});

describe("tool registration", () => {
  it("registers bruno_list_collections and returns structured content", async () => {
    const tool = captureTool(registerListCollections);
    expect(tool.name).toBe(LIST_COLLECTIONS_TOOL_NAME);

    const result = await tool.handler();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(listCollections(config));
    const [block] = result.content;
    expect(block).toMatchObject({ type: "text" });
    expect(JSON.parse((block as { text: string }).text)).toEqual(
      result.structuredContent,
    );
  });

  it("registers bruno_list_requests and returns structured content", async () => {
    const tool = captureTool(registerListRequests);
    expect(tool.name).toBe(LIST_REQUESTS_TOOL_NAME);

    const result = await tool.handler({ collection: "hotel" });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      collection: "hotel",
      requests: HOTEL_REQUESTS,
    });
  });

  it("registers bruno_get_request and surfaces PATH_OUTSIDE_ROOT as a structured error", async () => {
    const tool = captureTool(registerGetRequest);
    expect(tool.name).toBe(GET_REQUEST_TOOL_NAME);

    const result = await tool.handler({
      collection: "hotel",
      request: "../../etc/passwd",
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "PATH_OUTSIDE_ROOT" });
  });
});
