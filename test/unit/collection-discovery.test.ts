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
  loadCollection,
  resolveCollection,
} from "../../src/opencollection/collection.js";
import { discoverCollections } from "../../src/opencollection/discovery.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bruno-mcp-discovery-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function createCollection(
  relativePath: string,
  name: string,
  version = "1.0.0",
): string {
  const directory = join(root, relativePath);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "opencollection.yml"),
    `opencollection: ${version}\ninfo:\n  name: ${name}\n`,
  );
  return directory;
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

describe("discoverCollections", () => {
  it("discovers one collection", () => {
    createCollection("hotel", "Hotel API");

    expect(discoverCollections(root)).toEqual([
      {
        id: "hotel",
        name: "Hotel API",
        path: "hotel",
        openCollectionVersion: "1.0.0",
      },
    ]);
  });

  it("discovers multiple nested collections sorted by relative id", () => {
    createCollection("services/payments", "Shared API");
    createCollection("hotel", "Shared API", "1.1.0");

    expect(discoverCollections(root)).toEqual([
      {
        id: "hotel",
        name: "Shared API",
        path: "hotel",
        openCollectionVersion: "1.1.0",
      },
      {
        id: "services/payments",
        name: "Shared API",
        path: "services/payments",
        openCollectionVersion: "1.0.0",
      },
    ]);
  });

  it("uses a relative dot identifier when the configured root is a collection", () => {
    createCollection(".", "Root API");

    expect(discoverCollections(root)[0]).toMatchObject({ id: ".", path: "." });
  });

  it("ignores ordinary YAML directories", () => {
    mkdirSync(join(root, "ordinary"));
    writeFileSync(join(root, "ordinary", "request.yml"), "info:\n  name: Ping\n");

    expect(discoverCollections(root)).toEqual([]);
  });

  it("skips malformed and marker-less opencollection documents", () => {
    mkdirSync(join(root, "malformed"));
    writeFileSync(
      join(root, "malformed", "opencollection.yml"),
      "opencollection: [unterminated\n",
    );
    mkdirSync(join(root, "missing-marker"));
    writeFileSync(
      join(root, "missing-marker", "opencollection.yml"),
      "info:\n  name: Not a Collection\n",
    );
    createCollection("valid", "Valid API");

    expect(discoverCollections(root).map((collection) => collection.id)).toEqual([
      "valid",
    ]);
  });

  it("discovers only directories with explicit markers below a collection", () => {
    createCollection("outer", "Outer API");
    mkdirSync(join(root, "outer", "requests"));
    writeFileSync(join(root, "outer", "requests", "Ping.yml"), "info: {}\n");
    createCollection("outer/nested", "Nested API");

    expect(discoverCollections(root).map((collection) => collection.id)).toEqual([
      "outer",
      "outer/nested",
    ]);
  });

  it("does not follow directory symlinks", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "bruno-mcp-out-")));
    try {
      mkdirSync(join(outside, "external"));
      writeFileSync(
        join(outside, "external", "opencollection.yml"),
        "opencollection: 1.0.0\ninfo:\n  name: External\n",
      );
      symlinkSync(join(outside, "external"), join(root, "escape"));

      expect(discoverCollections(root)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("collection access", () => {
  it("loads collection metadata by relative path", () => {
    createCollection("services/hotel", "Hotel API");

    expect(loadCollection(root, "services/hotel")).toEqual({
      id: "services/hotel",
      name: "Hotel API",
      path: "services/hotel",
      openCollectionVersion: "1.0.0",
    });
  });

  it("resolves a collection id to its canonical absolute root", () => {
    const collectionRoot = createCollection("hotel", "Hotel API");

    expect(resolveCollection(root, "hotel")).toBe(collectionRoot);
  });

  it("throws COLLECTION_NOT_FOUND when the id is not a collection", () => {
    mkdirSync(join(root, "ordinary"));

    expectErrorCode(
      () => resolveCollection(root, "ordinary"),
      "COLLECTION_NOT_FOUND",
    );
    expectErrorCode(
      () => resolveCollection(root, "missing"),
      "COLLECTION_NOT_FOUND",
    );
  });

  it("throws INVALID_COLLECTION for an invalid explicit marker", () => {
    mkdirSync(join(root, "broken"));
    writeFileSync(
      join(root, "broken", "opencollection.yml"),
      "opencollection: [unterminated\n",
    );

    expectErrorCode(
      () => resolveCollection(root, "broken"),
      "INVALID_COLLECTION",
    );
  });

  it("rejects collection ids that escape the configured root", () => {
    expectErrorCode(
      () => resolveCollection(root, "../../outside"),
      "PATH_OUTSIDE_ROOT",
    );
  });
});
