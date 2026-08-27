import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BrunoMcpError } from "../../src/bruno/errors.js";
import {
  discoverRequests,
  resolveRequest,
} from "../../src/opencollection/request.js";

let root: string;
let collectionRoot: string;

const COLLECTION_ID = "hotel";

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bruno-mcp-request-")));
  collectionRoot = join(root, COLLECTION_ID);
  mkdirSync(collectionRoot, { recursive: true });
  writeFileSync(
    join(collectionRoot, "opencollection.yml"),
    "opencollection: 1.0.0\ninfo:\n  name: Hotel API\n",
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeRequest(relativePath: string, content: string): string {
  const absolute = join(collectionRoot, relativePath);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content);
  return absolute;
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

describe("discoverRequests", () => {
  it("finds nested requests and extracts HTTP method and URL", () => {
    writeRequest(
      "Hotel/Search.yml",
      [
        "info:",
        "  name: Search",
        "  type: http",
        "  seq: 1",
        "http:",
        "  method: POST",
        '  url: "{{baseUrl}}/api/hotel/properties"',
        "",
      ].join("\n"),
    );
    writeRequest(
      "Reservation/Retrieve.yml",
      [
        "info:",
        "  name: Retrieve",
        "  type: http",
        "  seq: 2",
        "http:",
        "  method: GET",
        '  url: "{{baseUrl}}/api/reservations/{{reservationId}}"',
        "",
      ].join("\n"),
    );

    expect(discoverRequests(root, COLLECTION_ID)).toEqual([
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
    ]);
  });

  it("returns the URL exactly as stored without interpolating variables", () => {
    writeRequest(
      "Ping.yml",
      [
        "info:",
        "  name: Ping",
        "  type: http",
        "http:",
        "  method: GET",
        '  url: "{{baseUrl}}/ping?token={{apiKey}}"',
        "",
      ].join("\n"),
    );

    expect(discoverRequests(root, COLLECTION_ID)[0]?.url).toBe(
      "{{baseUrl}}/ping?token={{apiKey}}",
    );
  });

  it("ignores collection, folder, and marker metadata files", () => {
    writeFileSync(join(collectionRoot, "collection.yml"), "info:\n  name: Meta\n");
    writeRequest("Hotel/folder.yml", "info:\n  name: Hotel Folder\n");
    writeRequest(
      "Hotel/Search.yml",
      "info:\n  name: Search\n  type: http\n",
    );
    mkdirSync(join(collectionRoot, "Hotel", "nested"), { recursive: true });
    writeFileSync(
      join(collectionRoot, "Hotel", "nested", "opencollection.yml"),
      "opencollection: 1.0.0\ninfo:\n  name: Nested\n",
    );

    expect(
      discoverRequests(root, COLLECTION_ID).map((request) => request.path),
    ).toEqual(["Hotel/Search.yml"]);
  });

  it("ignores environment definitions", () => {
    mkdirSync(join(collectionRoot, "environments"), { recursive: true });
    writeFileSync(
      join(collectionRoot, "environments", "Local.yml"),
      "variables:\n  - name: baseUrl\n    value: http://localhost\n",
    );
    writeFileSync(
      join(collectionRoot, "environments", "Production.yml"),
      "info:\n  name: Production\n  type: http\n",
    );
    writeRequest("Search.yml", "info:\n  name: Search\n  type: http\n");

    expect(
      discoverRequests(root, COLLECTION_ID).map((request) => request.path),
    ).toEqual(["Search.yml"]);
  });

  it("does not descend into nested collections", () => {
    writeRequest("Search.yml", "info:\n  name: Search\n  type: http\n");
    const nested = join(collectionRoot, "child");
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(nested, "opencollection.yml"),
      "opencollection: 1.0.0\ninfo:\n  name: Child\n",
    );
    writeFileSync(
      join(nested, "Inner.yml"),
      "info:\n  name: Inner\n  type: http\n",
    );

    expect(
      discoverRequests(root, COLLECTION_ID).map((request) => request.path),
    ).toEqual(["Search.yml"]);
  });

  it("handles non-HTTP request types with generic metadata only", () => {
    writeRequest(
      "Realtime.yml",
      [
        "info:",
        "  name: Realtime Feed",
        "  type: websocket",
        "  seq: 3",
        "websocket:",
        "  url: wss://example.com/feed",
        "",
      ].join("\n"),
    );

    expect(discoverRequests(root, COLLECTION_ID)).toEqual([
      {
        path: "Realtime.yml",
        name: "Realtime Feed",
        type: "websocket",
        sequence: 3,
      },
    ]);
  });

  it("tolerates unknown fields and requests without a type", () => {
    writeRequest(
      "Future.yml",
      [
        "info:",
        "  name: Something New",
        "  type: some-future-type",
        "newFeature:",
        "  enabled: true",
        "  options:",
        "    - one",
        "    - two",
        "",
      ].join("\n"),
    );
    writeRequest("Bare.yml", "info:\n  name: Bare\n");

    expect(discoverRequests(root, COLLECTION_ID)).toEqual([
      { path: "Bare.yml", name: "Bare", type: "" },
      {
        path: "Future.yml",
        name: "Something New",
        type: "some-future-type",
      },
    ]);
  });

  it("skips invalid YAML without aborting the listing", () => {
    writeRequest("Broken.yml", "info:\n  name: [unterminated\n");
    writeRequest("Search.yml", "info:\n  name: Search\n  type: http\n");

    expect(
      discoverRequests(root, COLLECTION_ID).map((request) => request.path),
    ).toEqual(["Search.yml"]);
  });

  it("skips YAML documents that lack an info block", () => {
    writeRequest("scalar.yml", "just a string\n");
    writeRequest("list.yml", "- one\n- two\n");
    writeRequest("no-info.yml", "http:\n  method: GET\n  url: /ping\n");
    writeRequest("Search.yml", "info:\n  name: Search\n  type: http\n");

    expect(
      discoverRequests(root, COLLECTION_ID).map((request) => request.path),
    ).toEqual(["Search.yml"]);
  });

  it("orders requests within a folder by sequence, not by name", () => {
    writeRequest("Api/Charlie.yml", "info:\n  name: Charlie\n  type: http\n  seq: 1\n");
    writeRequest("Api/Alpha.yml", "info:\n  name: Alpha\n  type: http\n  seq: 2\n");
    writeRequest("Api/Bravo.yml", "info:\n  name: Bravo\n  type: http\n  seq: 3\n");

    expect(
      discoverRequests(root, COLLECTION_ID).map((request) => request.path),
    ).toEqual(["Api/Charlie.yml", "Api/Alpha.yml", "Api/Bravo.yml"]);
  });

  it("orders folders by their folder.yml sequence", () => {
    writeRequest("Zeta/folder.yml", "info:\n  name: Zeta\n  seq: 1\n");
    writeRequest("Zeta/Req.yml", "info:\n  name: Zeta Req\n  type: http\n");
    writeRequest("Alpha/folder.yml", "info:\n  name: Alpha\n  seq: 2\n");
    writeRequest("Alpha/Req.yml", "info:\n  name: Alpha Req\n  type: http\n");

    expect(
      discoverRequests(root, COLLECTION_ID).map((request) => request.path),
    ).toEqual(["Zeta/Req.yml", "Alpha/Req.yml"]);
  });

  it("lists nested folders before requests in the same directory", () => {
    writeRequest("RootReq.yml", "info:\n  name: Root\n  type: http\n  seq: 1\n");
    writeRequest("Sub/Nested.yml", "info:\n  name: Nested\n  type: http\n  seq: 1\n");

    expect(
      discoverRequests(root, COLLECTION_ID).map((request) => request.path),
    ).toEqual(["Sub/Nested.yml", "RootReq.yml"]);
  });

  it("sorts entries without a sequence last, then by name", () => {
    writeRequest("Api/Sequenced.yml", "info:\n  name: Seq\n  type: http\n  seq: 5\n");
    writeRequest("Api/Bare-B.yml", "info:\n  name: B\n  type: http\n");
    writeRequest("Api/Bare-A.yml", "info:\n  name: A\n  type: http\n");

    expect(
      discoverRequests(root, COLLECTION_ID).map((request) => request.path),
    ).toEqual(["Api/Sequenced.yml", "Api/Bare-A.yml", "Api/Bare-B.yml"]);
  });

  it("falls back to folder name order when folder.yml is missing or has no seq", () => {
    writeRequest("Beta/Req.yml", "info:\n  name: Beta Req\n  type: http\n");
    writeRequest("Alpha/Req.yml", "info:\n  name: Alpha Req\n  type: http\n");

    expect(
      discoverRequests(root, COLLECTION_ID).map((request) => request.path),
    ).toEqual(["Alpha/Req.yml", "Beta/Req.yml"]);
  });

  it("does not follow directory symlinks out of the collection", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "bruno-mcp-out-")));
    try {
      writeFileSync(
        join(outside, "External.yml"),
        "info:\n  name: External\n  type: http\n",
      );
      symlinkSync(outside, join(collectionRoot, "escape"));
      writeRequest("Search.yml", "info:\n  name: Search\n  type: http\n");

      expect(
        discoverRequests(root, COLLECTION_ID).map((request) => request.path),
      ).toEqual(["Search.yml"]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("throws COLLECTION_NOT_FOUND for an unknown collection", () => {
    expectErrorCode(
      () => discoverRequests(root, "missing"),
      "COLLECTION_NOT_FOUND",
    );
  });
});

describe("resolveRequest", () => {
  it("resolves a request path to its canonical absolute file", () => {
    const absolute = writeRequest(
      "Hotel/Search.yml",
      "info:\n  name: Search\n  type: http\n",
    );

    expect(resolveRequest(root, COLLECTION_ID, "Hotel/Search.yml")).toBe(
      absolute,
    );
  });

  it("throws REQUEST_NOT_FOUND when the request file is missing", () => {
    expectErrorCode(
      () => resolveRequest(root, COLLECTION_ID, "Hotel/Missing.yml"),
      "REQUEST_NOT_FOUND",
    );
  });

  it("throws REQUEST_NOT_FOUND when the path is a directory", () => {
    mkdirSync(join(collectionRoot, "Hotel"), { recursive: true });

    expectErrorCode(
      () => resolveRequest(root, COLLECTION_ID, "Hotel"),
      "REQUEST_NOT_FOUND",
    );
  });

  it("rejects request paths that escape the collection root", () => {
    expectErrorCode(
      () => resolveRequest(root, COLLECTION_ID, "../../etc/passwd"),
      "PATH_OUTSIDE_ROOT",
    );
  });

  it("throws COLLECTION_NOT_FOUND for an unknown collection", () => {
    expectErrorCode(
      () => resolveRequest(root, "missing", "Search.yml"),
      "COLLECTION_NOT_FOUND",
    );
  });
});
