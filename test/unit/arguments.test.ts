import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildRunArgs,
  type BuildRunArgsContext,
  type RunArgsParams,
} from "../../src/bruno/arguments.js";
import { BrunoMcpError } from "../../src/bruno/errors.js";
import {
  DEFAULT_BRU_EXECUTABLE,
  DEFAULT_MAX_REPORT_BYTES,
  DEFAULT_TIMEOUT_MS,
  type Config,
} from "../../src/config/config.js";

const COLLECTION_ID = "hotel";
const REPORT_PATH = "/tmp/bruno-mcp-report/report.json";

let root: string;

beforeEach(() => {
  // `realpathSync` so the root is already canonical on platforms where the temp
  // dir is itself a symlink (e.g. macOS /var -> /private/var).
  root = realpathSync(mkdtempSync(join(tmpdir(), "bruno-mcp-args-")));
  mkdirSync(join(root, COLLECTION_ID, "Reservation"), { recursive: true });
  mkdirSync(join(root, COLLECTION_ID, "Hotel"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    root,
    bru: DEFAULT_BRU_EXECUTABLE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    allowDeveloperSandbox: false,
    allowInsecure: false,
    maxReportBytes: DEFAULT_MAX_REPORT_BYTES,
    logLevel: "info",
    ...overrides,
  };
}

function build(
  params: Omit<RunArgsParams, "collection"> & { collection?: string },
  context: Partial<BuildRunArgsContext> = {},
): string[] {
  return buildRunArgs(
    { collection: COLLECTION_ID, ...params },
    { reportPath: REPORT_PATH, config: makeConfig(), ...context },
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

describe("buildRunArgs", () => {
  it("matches the canonical acceptance example exactly", () => {
    const args = build({
      targets: ["Foo.yml"],
      environment: "Local",
      variables: { foo: "bar" },
      bail: true,
    });

    expect(args).toEqual([
      "Foo.yml",
      "--env",
      "Local",
      "--env-var",
      "foo=bar",
      "--bail",
      "--reporter-json",
      REPORT_PATH,
    ]);
  });

  it("matches a multi-segment target invocation exactly", () => {
    const args = build({
      targets: ["Reservation/Retrieve.yml"],
      environment: "Local",
      variables: { reservationId: "123" },
      bail: true,
    });

    expect(args).toEqual([
      "Reservation/Retrieve.yml",
      "--env",
      "Local",
      "--env-var",
      "reservationId=123",
      "--bail",
      "--reporter-json",
      REPORT_PATH,
    ]);
  });

  it("runs the whole collection when targets is empty", () => {
    expect(build({ targets: [] })).toEqual([
      "--reporter-json",
      REPORT_PATH,
    ]);
  });

  it("runs the whole collection when targets is omitted", () => {
    expect(build({})).toEqual(["--reporter-json", REPORT_PATH]);
  });

  it("passes each target as an individual argument", () => {
    const args = build({
      targets: ["Hotel/Search.yml", "Hotel/Details.yml"],
    });

    expect(args).toEqual([
      "Hotel/Search.yml",
      "Hotel/Details.yml",
      "--reporter-json",
      REPORT_PATH,
    ]);
  });

  it("accepts folder targets without requiring a .yml suffix", () => {
    const args = build({ targets: ["Hotel"] });

    expect(args).toEqual(["Hotel", "--reporter-json", REPORT_PATH]);
  });

  it("emits a repeated --env-var flag for each override, preserving order", () => {
    const args = build({
      variables: { reservationId: "123", locale: "en-US" },
    });

    expect(args).toEqual([
      "--env-var",
      "reservationId=123",
      "--env-var",
      "locale=en-US",
      "--reporter-json",
      REPORT_PATH,
    ]);
  });

  it("keeps a value containing '=' intact in the pair", () => {
    const args = build({ variables: { token: "a=b=c" } });

    expect(args).toEqual([
      "--env-var",
      "token=a=b=c",
      "--reporter-json",
      REPORT_PATH,
    ]);
  });

  it("omits --env when no environment is provided", () => {
    expect(build({ variables: { a: "1" } })).not.toContain("--env");
  });

  it("adds --tests-only when requested", () => {
    expect(build({ testsOnly: true })).toEqual([
      "--tests-only",
      "--reporter-json",
      REPORT_PATH,
    ]);
  });

  it("adds --delay with the millisecond value when provided", () => {
    expect(build({ delayMs: 250 })).toEqual([
      "--delay",
      "250",
      "--reporter-json",
      REPORT_PATH,
    ]);
  });

  it("emits --delay 0 when a zero delay is explicitly provided", () => {
    expect(build({ delayMs: 0 })).toEqual([
      "--delay",
      "0",
      "--reporter-json",
      REPORT_PATH,
    ]);
  });

  it("omits --delay when no delay is provided", () => {
    expect(build({})).not.toContain("--delay");
  });

  it("adds --sandbox developer only for the developer sandbox", () => {
    expect(build({ sandbox: "developer" })).toEqual([
      "--sandbox",
      "developer",
      "--reporter-json",
      REPORT_PATH,
    ]);
  });

  it("omits the sandbox flag for safe mode", () => {
    expect(build({ sandbox: "safe" })).not.toContain("--sandbox");
  });

  it("omits the sandbox flag when unspecified", () => {
    expect(build({})).not.toContain("--sandbox");
  });

  it("emits developer sandbox regardless of config, trusting upstream policy", () => {
    // The builder assumes the run tool already enforced sandbox policy; it must
    // not silently downgrade based on configuration it does not own.
    const args = buildRunArgs(
      { collection: COLLECTION_ID, sandbox: "developer" },
      {
        reportPath: REPORT_PATH,
        config: makeConfig({ allowDeveloperSandbox: false }),
      },
    );

    expect(args).toContain("--sandbox");
    expect(args).toContain("developer");
  });

  it("adds --insecure when requested", () => {
    expect(build({ insecure: true })).toEqual([
      "--insecure",
      "--reporter-json",
      REPORT_PATH,
    ]);
  });

  it("always appends --reporter-json with the report path last", () => {
    const args = build({
      targets: ["Hotel"],
      environment: "Local",
      variables: { a: "1" },
      bail: true,
      insecure: true,
    });

    expect(args.slice(-2)).toEqual(["--reporter-json", REPORT_PATH]);
  });

  it("orders every option deterministically in a full invocation", () => {
    const args = build({
      targets: ["Hotel/Search.yml", "Hotel"],
      environment: "Local",
      variables: { reservationId: "123", locale: "en-US" },
      bail: true,
      testsOnly: true,
      delayMs: 50,
      sandbox: "developer",
      insecure: true,
    });

    expect(args).toEqual([
      "Hotel/Search.yml",
      "Hotel",
      "--env",
      "Local",
      "--env-var",
      "reservationId=123",
      "--env-var",
      "locale=en-US",
      "--bail",
      "--tests-only",
      "--delay",
      "50",
      "--sandbox",
      "developer",
      "--insecure",
      "--reporter-json",
      REPORT_PATH,
    ]);
  });

  it("returns a plain string array with no joined shell string", () => {
    const args = build({
      targets: ["Hotel/Search.yml"],
      environment: "Local",
      variables: { a: "1" },
      bail: true,
    });

    expect(Array.isArray(args)).toBe(true);
    for (const arg of args) {
      expect(typeof arg).toBe("string");
    }
    // Flags and their values are always separate entries, so no single element
    // is ever a whole command line.
    expect(args).not.toContain("bru run Hotel/Search.yml --env Local");
    expect(args.some((arg) => arg.includes(" --"))).toBe(false);
  });

  describe("target containment", () => {
    it("rejects a parent-traversal target that escapes the collection", () => {
      expectErrorCode(
        () => build({ targets: ["../secret.yml"] }),
        "PATH_OUTSIDE_ROOT",
      );
    });

    it("rejects a traversal target that escapes the root entirely", () => {
      expectErrorCode(
        () => build({ targets: ["../../etc/passwd"] }),
        "PATH_OUTSIDE_ROOT",
      );
    });

    it("rejects an absolute-path target", () => {
      expectErrorCode(
        () => build({ targets: ["/etc/passwd"] }),
        "PATH_OUTSIDE_ROOT",
      );
    });

    it("rejects as soon as one target in a list escapes", () => {
      expectErrorCode(
        () => build({ targets: ["Hotel/Search.yml", "../escape"] }),
        "PATH_OUTSIDE_ROOT",
      );
    });
  });

  describe("variable name validation", () => {
    it("rejects a name containing a NUL byte", () => {
      expectErrorCode(
        () => build({ variables: { "bad\0name": "value" } }),
        "INVALID_VARIABLE_NAME",
      );
    });

    it("rejects a name containing a newline", () => {
      expectErrorCode(
        () => build({ variables: { "bad\nname": "value" } }),
        "INVALID_VARIABLE_NAME",
      );
    });

    it("rejects a name containing a carriage return", () => {
      expectErrorCode(
        () => build({ variables: { "bad\rname": "value" } }),
        "INVALID_VARIABLE_NAME",
      );
    });

    it("allows unusual but harmless names and values", () => {
      const args = build({
        variables: { "with space": "a b", "dot.name": "" },
      });

      expect(args).toEqual([
        "--env-var",
        "with space=a b",
        "--env-var",
        "dot.name=",
        "--reporter-json",
        REPORT_PATH,
      ]);
    });
  });
});
