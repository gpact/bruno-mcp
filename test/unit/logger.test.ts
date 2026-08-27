import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger, readLogLevel } from "../../src/logger.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function captureOutput() {
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);

  return { stderr, stdout };
}

describe("readLogLevel", () => {
  it("reads a valid level and defaults invalid or missing values to info", () => {
    expect(readLogLevel({ BRUNO_MCP_LOG_LEVEL: "debug" })).toBe("debug");
    expect(readLogLevel({ BRUNO_MCP_LOG_LEVEL: "verbose" })).toBe("info");
    expect(readLogLevel({})).toBe("info");
  });
});

describe("createLogger", () => {
  it("reads BRUNO_MCP_LOG_LEVEL when no explicit level is provided", () => {
    vi.stubEnv("BRUNO_MCP_LOG_LEVEL", "error");
    const { stderr } = captureOutput();
    const logger = createLogger();

    logger.error("visible");
    logger.warn("filtered");

    expect(stderr).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalledWith("[error] visible\n");
  });

  it("writes enabled levels to stderr and never stdout", () => {
    const { stderr, stdout } = captureOutput();
    const logger = createLogger({ level: "warn" });

    logger.error("failure");
    logger.warn("warning");
    logger.info("filtered info");
    logger.debug("filtered debug");

    expect(stderr.mock.calls.map(([chunk]) => String(chunk))).toEqual([
      "[error] failure\n",
      "[warn] warning\n",
    ]);
    expect(stdout).not.toHaveBeenCalled();
  });

  it("redacts sensitive context and bodies below debug level", () => {
    const { stderr } = captureOutput();
    const logger = createLogger({ level: "info" });

    logger.info("request completed", {
      headers: {
        Authorization: "Bearer secret",
        Cookie: "session=secret",
        Accept: "application/json",
      },
      variables: { apiUrl: "https://example.test" },
      environmentVariable: {
        name: "apiKey",
        value: "environment secret",
        secret: true,
      },
      response: { status: 200, body: "response secret" },
    });

    const output = String(stderr.mock.calls[0]?.[0]);
    expect(output).toContain('"Authorization":"[REDACTED]"');
    expect(output).toContain('"Cookie":"[REDACTED]"');
    expect(output).toContain('"variables":"[REDACTED]"');
    expect(output).toContain('"value":"[REDACTED]"');
    expect(output).toContain('"body":"[REDACTED]"');
    expect(output).toContain('"Accept":"application/json"');
    expect(output).not.toContain("Bearer secret");
    expect(output).not.toContain("response secret");
  });

  it("applies a custom redactor before mandatory baseline redaction", () => {
    const { stderr } = captureOutput();
    const redact = vi.fn((context) => ({
      ...context,
      tenantCredential: "[REDACTED]",
    }));
    const logger = createLogger({ level: "debug", redact });

    logger.debug("custom context", {
      tenantCredential: "domain secret",
      authorization: "baseline secret",
      body: "debug response body",
    });

    const output = String(stderr.mock.calls[0]?.[0]);
    expect(redact).toHaveBeenCalledOnce();
    expect(output).toContain('"tenantCredential":"[REDACTED]"');
    expect(output).toContain('"authorization":"[REDACTED]"');
    expect(output).toContain('"body":"debug response body"');
    expect(output).not.toContain("domain secret");
    expect(output).not.toContain("baseline secret");
  });
});
