import { describe, expect, it, vi } from "vitest";

import {
  BrunoMcpError,
  toMcpErrorContent,
} from "../../src/bruno/errors.js";
import type { BruCommandRunner } from "../../src/bruno/cli.js";
import {
  isSupportedBrunoVersion,
  parseBrunoVersion,
  validateBrunoVersion,
} from "../../src/bruno/version.js";

/** Build a runner that resolves with the given stdout (and optional stderr). */
function runnerWith(
  stdout: string,
  stderr = "",
  exitCode = 0,
): BruCommandRunner {
  return vi.fn(async () => ({ stdout, stderr, exitCode }));
}

async function expectRejection(
  promise: Promise<unknown>,
): Promise<BrunoMcpError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BrunoMcpError);
    return error as BrunoMcpError;
  }

  throw new Error("Expected validateBrunoVersion to reject");
}

describe("parseBrunoVersion", () => {
  it("extracts the numeric core from a bare version string", () => {
    expect(parseBrunoVersion("4.1.2")).toEqual({
      major: 4,
      minor: 1,
      patch: 2,
      prerelease: null,
      build: null,
      raw: "4.1.2",
    });
  });

  it("finds the version embedded in surrounding text", () => {
    expect(parseBrunoVersion("bru version 4.0.0\n")).toMatchObject({
      major: 4,
      minor: 0,
      patch: 0,
    });
  });

  it("preserves valid pre-release and build metadata", () => {
    expect(parseBrunoVersion("4.2.0-beta.1+sha.abc123")).toMatchObject({
      major: 4,
      minor: 2,
      patch: 0,
      prerelease: "beta.1",
      build: "sha.abc123",
      raw: "4.2.0-beta.1+sha.abc123",
    });
  });

  it("returns null for garbled output", () => {
    for (const output of [
      "not-a-version",
      "",
      "4.2",
      "4.0.0.1",
      "x4.0.0y",
      "04.0.0",
      "4.0.0-01",
    ]) {
      expect(parseBrunoVersion(output)).toBeNull();
    }
  });
});

describe("isSupportedBrunoVersion", () => {
  it.each([
    ["4.0.0", true],
    ["4.9.9", true],
    ["4.999.999", true],
    ["4.2.0+build.1", true],
    ["4.2.0-beta.1", false],
    ["3.9.9", false],
    ["5.0.0", false],
    ["2.0.0", false],
    ["6.1.0", false],
  ])("treats %s as supported=%s", (raw, expected) => {
    const version = parseBrunoVersion(raw);
    expect(version).not.toBeNull();
    expect(isSupportedBrunoVersion(version!)).toBe(expected);
  });
});

describe("validateBrunoVersion", () => {
  it("invokes the runner with the configured bru path and --version, no shell", async () => {
    const run = runnerWith("4.0.0");

    await validateBrunoVersion({ bru: "/usr/local/bin/bru", run });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("/usr/local/bin/bru", ["--version"]);
  });

  it.each(["4.0.0", "4.9.9"])("accepts in-range version %s", async (raw) => {
    const version = await validateBrunoVersion({
      bru: "bru",
      run: runnerWith(raw),
    });

    expect(version.raw).toBe(raw);
  });

  it("accepts a version reported on stderr", async () => {
    const version = await validateBrunoVersion({
      bru: "bru",
      run: runnerWith("", "4.3.1\n"),
    });

    expect(version).toMatchObject({ major: 4, minor: 3, patch: 1 });
  });

  it("rejects a prerelease version", async () => {
    const error = await expectRejection(
      validateBrunoVersion({ bru: "bru", run: runnerWith("4.2.0-beta.1") }),
    );

    expect(error.code).toBe("UNSUPPORTED_BRUNO_VERSION");
    expect(error.message).toContain("Detected version: 4.2.0-beta.1.");
  });

  it.each(["3.9.9", "5.0.0"])(
    "rejects out-of-range version %s with UNSUPPORTED_BRUNO_VERSION",
    async (raw) => {
      const error = await expectRejection(
        validateBrunoVersion({ bru: "bru", run: runnerWith(raw) }),
      );

      expect(error.code).toBe("UNSUPPORTED_BRUNO_VERSION");
      expect(error.message).toContain(
        "Bruno MCP requires Bruno CLI >= 4.0.0 and < 5.0.0.",
      );
      expect(error.message).toContain(`Detected version: ${raw}.`);
    },
  );

  it("produces the exact spec message for a rejected 3.5.3", async () => {
    const error = await expectRejection(
      validateBrunoVersion({ bru: "bru", run: runnerWith("3.5.3") }),
    );

    expect(error.message).toBe(
      "Bruno MCP requires Bruno CLI >= 4.0.0 and < 5.0.0.\n" +
        "Detected version: 3.5.3.",
    );
  });

  it("rejects garbled version output with UNSUPPORTED_BRUNO_VERSION", async () => {
    const error = await expectRejection(
      validateBrunoVersion({ bru: "bru", run: runnerWith("garbled output") }),
    );

    expect(error.code).toBe("UNSUPPORTED_BRUNO_VERSION");
    expect(error.message).toContain("Could not detect a version");
  });

  it("maps a missing executable to BRUNO_NOT_FOUND", async () => {
    const run: BruCommandRunner = vi.fn(async () => {
      const error = new Error("spawn bru ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    });

    const error = await expectRejection(
      validateBrunoVersion({ bru: "bru", run }),
    );

    expect(error.code).toBe("BRUNO_NOT_FOUND");
    expect(error.message).toContain('"bru"');
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("maps a non-zero version command exit to UNSUPPORTED_BRUNO_VERSION", async () => {
    const error = await expectRejection(
      validateBrunoVersion({
        bru: "bru",
        run: runnerWith("4.0.0", "version check failed", 7),
      }),
    );

    expect(error.code).toBe("UNSUPPORTED_BRUNO_VERSION");
    expect(error.message).toContain("exited with status 7");
  });

  it("does not report unrelated runner failures as BRUNO_NOT_FOUND", async () => {
    const run: BruCommandRunner = vi.fn(async () => {
      const error = new Error("stdout maxBuffer exceeded") as NodeJS.ErrnoException;
      error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      throw error;
    });

    const error = await expectRejection(
      validateBrunoVersion({ bru: "bru", run }),
    );

    expect(error.code).toBe("UNSUPPORTED_BRUNO_VERSION");
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("exposes only stable code/message through MCP error content", async () => {
    const error = await expectRejection(
      validateBrunoVersion({ bru: "bru", run: runnerWith("3.0.0") }),
    );

    expect(Object.keys(toMcpErrorContent(error))).toEqual(["code", "message"]);
  });
});
