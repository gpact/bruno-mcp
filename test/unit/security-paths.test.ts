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
  relativeToRoot,
  resolveWithinCollection,
  resolveWithinRoot,
} from "../../src/security/paths.js";

let root: string;

beforeEach(() => {
  // `realpathSync` so the root is already canonical on macOS where the temp
  // dir is itself a symlink (/var -> /private/var).
  root = realpathSync(mkdtempSync(join(tmpdir(), "bruno-mcp-paths-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function expectPathOutsideRoot(fn: () => unknown): void {
  try {
    fn();
    expect.unreachable("expected PATH_OUTSIDE_ROOT to be thrown");
  } catch (error) {
    expect(error).toBeInstanceOf(BrunoMcpError);
    expect((error as BrunoMcpError).code).toBe("PATH_OUTSIDE_ROOT");
  }
}

describe("resolveWithinRoot", () => {
  it("allows a valid relative path and returns a canonical absolute path", () => {
    mkdirSync(join(root, "hotel"));
    writeFileSync(join(root, "hotel", "Search.yml"), "");

    const resolved = resolveWithinRoot(root, "hotel/Search.yml");

    expect(resolved).toBe(join(root, "hotel", "Search.yml"));
  });

  it("resolves the root itself", () => {
    expect(resolveWithinRoot(root, ".")).toBe(root);
  });

  it("allows a not-yet-existing target beneath the root", () => {
    const resolved = resolveWithinRoot(root, "hotel/new/Request.yml");

    expect(resolved).toBe(join(root, "hotel", "new", "Request.yml"));
  });

  it("rejects `..` traversal", () => {
    expectPathOutsideRoot(() => resolveWithinRoot(root, "../secret.yml"));
  });

  it("rejects deep `..` traversal", () => {
    expectPathOutsideRoot(() =>
      resolveWithinRoot(root, "../../etc/passwd"),
    );
  });

  it("rejects an absolute-path escape", () => {
    expectPathOutsideRoot(() => resolveWithinRoot(root, "/etc/passwd"));
  });

  it("does not treat a sibling directory sharing a prefix as contained", () => {
    const sibling = `${root}-evil`;
    mkdirSync(sibling);
    try {
      expectPathOutsideRoot(() => resolveWithinRoot(root, sibling));
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("rejects a symlink escape when the target exists", () => {
    // hotel/escape -> /etc ; accessing escape/passwd must be rejected.
    mkdirSync(join(root, "hotel"));
    symlinkSync("/etc", join(root, "hotel", "escape"));

    expectPathOutsideRoot(() =>
      resolveWithinRoot(root, "hotel/escape/passwd"),
    );
  });

  it("rejects a symlink escape when the leaf target does not exist", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "bruno-mcp-out-")));
    try {
      mkdirSync(join(root, "hotel"));
      symlinkSync(outside, join(root, "hotel", "escape"));

      // The leaf does not exist; nearest-existing-ancestor canonicalization
      // must still follow the symlink out of the root.
      expectPathOutsideRoot(() =>
        resolveWithinRoot(root, "hotel/escape/does-not-exist.yml"),
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a broken symlink pointing outside the root", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "bruno-mcp-out-")));
    try {
      symlinkSync(join(outside, "future"), join(root, "escape"));

      expectPathOutsideRoot(() =>
        resolveWithinRoot(root, "escape/does-not-exist.yml"),
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("allows a symlink that stays within the root", () => {
    mkdirSync(join(root, "hotel"));
    writeFileSync(join(root, "hotel", "Search.yml"), "");
    symlinkSync(join(root, "hotel"), join(root, "alias"));

    const resolved = resolveWithinRoot(root, "alias/Search.yml");

    // Canonicalized back to the real (non-aliased) location, still inside root.
    expect(resolved).toBe(join(root, "hotel", "Search.yml"));
  });
});

describe("resolveWithinCollection", () => {
  it("resolves a request beneath its collection root", () => {
    mkdirSync(join(root, "hotel"));
    writeFileSync(join(root, "hotel", "opencollection.yml"), "");
    writeFileSync(join(root, "hotel", "Search.yml"), "");

    const resolved = resolveWithinCollection(root, "hotel", "Search.yml");

    expect(resolved).toBe(join(root, "hotel", "Search.yml"));
  });

  it("rejects the forbidden { collection: hotel, request: ../../secret.yml }", () => {
    mkdirSync(join(root, "hotel"));

    expectPathOutsideRoot(() =>
      resolveWithinCollection(root, "hotel", "../../secret.yml"),
    );
  });

  it("rejects a request that escapes the collection but not the root", () => {
    // `../` climbs out of the collection into a sibling collection: still
    // forbidden because it leaves the collection root.
    mkdirSync(join(root, "hotel"));
    mkdirSync(join(root, "payments"));
    writeFileSync(join(root, "payments", "Secret.yml"), "");

    expectPathOutsideRoot(() =>
      resolveWithinCollection(root, "hotel", "../payments/Secret.yml"),
    );
  });

  it("rejects a collection root that escapes the root", () => {
    expectPathOutsideRoot(() =>
      resolveWithinCollection(root, "../elsewhere", "Search.yml"),
    );
  });
});

describe("relativeToRoot", () => {
  it("returns a POSIX relative path for a nested target", () => {
    const absolute = join(root, "hotel", "Search.yml");

    expect(relativeToRoot(root, absolute)).toBe("hotel/Search.yml");
  });

  it("returns `.` for the root itself", () => {
    expect(relativeToRoot(root, root)).toBe(".");
  });

  it("throws PATH_OUTSIDE_ROOT for a path outside the root", () => {
    expectPathOutsideRoot(() => relativeToRoot(root, "/etc/passwd"));
  });

  it("throws PATH_OUTSIDE_ROOT for a path through an escaping symlink", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "bruno-mcp-out-")));
    try {
      symlinkSync(outside, join(root, "escape"));

      expectPathOutsideRoot(() =>
        relativeToRoot(root, join(root, "escape", "Request.yml")),
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("canonicalizes an in-root symlink before making the path relative", () => {
    mkdirSync(join(root, "hotel"));
    writeFileSync(join(root, "hotel", "Search.yml"), "");
    symlinkSync(join(root, "hotel"), join(root, "alias"));

    expect(relativeToRoot(root, join(root, "alias", "Search.yml"))).toBe(
      "hotel/Search.yml",
    );
  });

  it("round-trips with resolveWithinRoot", () => {
    mkdirSync(join(root, "hotel"));
    writeFileSync(join(root, "hotel", "Search.yml"), "");

    const absolute = resolveWithinRoot(root, "hotel/Search.yml");
    const rel = relativeToRoot(root, absolute);

    expect(resolveWithinRoot(root, rel)).toBe(absolute);
  });
});
