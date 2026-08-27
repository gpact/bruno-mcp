import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_BRU_EXECUTABLE,
  DEFAULT_LOG_LEVEL,
  DEFAULT_MAX_REPORT_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  loadConfig,
} from "../../src/config/config.js";

describe("loadConfig", () => {
  it("applies defaults when the environment is empty", () => {
    const config = loadConfig({});

    expect(config).toEqual({
      root: realpathSync(process.cwd()),
      bru: DEFAULT_BRU_EXECUTABLE,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      allowDeveloperSandbox: false,
      allowInsecure: false,
      maxReportBytes: DEFAULT_MAX_REPORT_BYTES,
      logLevel: DEFAULT_LOG_LEVEL,
    });
  });

  it("reads and stores all provided values", () => {
    const config = loadConfig({
      BRUNO_MCP_BRU: "/usr/local/bin/bru",
      BRUNO_MCP_TIMEOUT_MS: "60000",
      BRUNO_MCP_ALLOW_DEVELOPER_SANDBOX: "true",
      BRUNO_MCP_ALLOW_INSECURE: "yes",
      BRUNO_MCP_MAX_REPORT_BYTES: "1048576",
      BRUNO_MCP_LOG_LEVEL: "debug",
    });

    expect(config.bru).toBe("/usr/local/bin/bru");
    expect(config.timeoutMs).toBe(60_000);
    expect(config.allowDeveloperSandbox).toBe(true);
    expect(config.allowInsecure).toBe(true);
    expect(config.maxReportBytes).toBe(1_048_576);
    expect(config.logLevel).toBe("debug");
  });

  it("does not trim or shell-escape the bru executable path beyond whitespace", () => {
    expect(loadConfig({ BRUNO_MCP_BRU: "  bru custom  " }).bru).toBe(
      "bru custom",
    );
    expect(loadConfig({ BRUNO_MCP_BRU: "" }).bru).toBe(DEFAULT_BRU_EXECUTABLE);
  });

  describe("boolean parsing", () => {
    it.each([
      ["true", true],
      ["TRUE", true],
      ["1", true],
      ["yes", true],
      ["on", true],
      ["false", false],
      ["0", false],
      ["no", false],
      ["off", false],
      ["  On  ", true],
    ])("parses %s as %s", (raw, expected) => {
      expect(
        loadConfig({ BRUNO_MCP_ALLOW_INSECURE: raw }).allowInsecure,
      ).toBe(expected);
    });

    it("rejects non-boolean values with a clear message", () => {
      expect(() =>
        loadConfig({ BRUNO_MCP_ALLOW_DEVELOPER_SANDBOX: "maybe" }),
      ).toThrow(/BRUNO_MCP_ALLOW_DEVELOPER_SANDBOX: must be a boolean/);
    });
  });

  describe("timeout cap behavior", () => {
    it("keeps values at or below the cap", () => {
      expect(loadConfig({ BRUNO_MCP_TIMEOUT_MS: "900000" }).timeoutMs).toBe(
        MAX_TIMEOUT_MS,
      );
      expect(loadConfig({ BRUNO_MCP_TIMEOUT_MS: "1" }).timeoutMs).toBe(1);
    });

    it("clamps values above the cap deterministically", () => {
      expect(loadConfig({ BRUNO_MCP_TIMEOUT_MS: "1000000" }).timeoutMs).toBe(
        MAX_TIMEOUT_MS,
      );
      expect(
        loadConfig({ BRUNO_MCP_TIMEOUT_MS: "99999999999" }).timeoutMs,
      ).toBe(MAX_TIMEOUT_MS);
    });

    it.each(["0", "-1", "abc", "12.5"])(
      "rejects the invalid timeout %s",
      (raw) => {
        expect(() => loadConfig({ BRUNO_MCP_TIMEOUT_MS: raw })).toThrow(
          /BRUNO_MCP_TIMEOUT_MS: must be a positive integer/,
        );
      },
    );

    it("treats a whitespace-only value as unset and uses the default", () => {
      expect(loadConfig({ BRUNO_MCP_TIMEOUT_MS: "   " }).timeoutMs).toBe(
        DEFAULT_TIMEOUT_MS,
      );
    });
  });

  describe("max report bytes", () => {
    it("rejects invalid sizes", () => {
      expect(() =>
        loadConfig({ BRUNO_MCP_MAX_REPORT_BYTES: "-5" }),
      ).toThrow(/BRUNO_MCP_MAX_REPORT_BYTES: must be a positive integer/);
    });
  });

  describe("log level", () => {
    it("rejects unknown log levels", () => {
      expect(() => loadConfig({ BRUNO_MCP_LOG_LEVEL: "verbose" })).toThrow(
        /BRUNO_MCP_LOG_LEVEL: must be one of error, warn, info, debug/,
      );
    });
  });

  describe("root canonicalization", () => {
    it("resolves BRUNO_MCP_ROOT to its canonical real path", () => {
      const realDir = mkdtempSync(join(tmpdir(), "bruno-mcp-root-"));
      const nested = join(realDir, "a", "..");

      const config = loadConfig({ BRUNO_MCP_ROOT: nested });

      expect(config.root).toBe(realpathSync(realDir));
    });

    it("rejects a root that cannot be resolved", () => {
      expect(() =>
        loadConfig({
          BRUNO_MCP_ROOT: join(tmpdir(), "definitely-missing-bruno-mcp-dir"),
        }),
      ).toThrow(/BRUNO_MCP_ROOT: could not resolve directory/);
    });
  });

  it("aggregates multiple invalid values into one message", () => {
    expect(() =>
      loadConfig({
        BRUNO_MCP_TIMEOUT_MS: "nope",
        BRUNO_MCP_LOG_LEVEL: "loud",
      }),
    ).toThrow(/BRUNO_MCP_TIMEOUT_MS:.*BRUNO_MCP_LOG_LEVEL:/s);
  });
});
