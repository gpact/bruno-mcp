import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { BrunoMcpError } from "../../src/bruno/errors.js";
import {
  DEFAULT_MAX_RESPONSE_BODY_BYTES,
  assertReportSize,
  filterResponseBodies,
  normalizeBruReport,
} from "../../src/bruno/report.js";

function reportFixture(name: string): string {
  return readFileSync(new URL(`../fixtures/reports/${name}`, import.meta.url), "utf8");
}

describe("normalizeBruReport captured reports", () => {
  it("normalizes a successful Bruno report", () => {
    const normalized = normalizeBruReport({
      exitCode: 0,
      stderr: "",
      reportRaw: reportFixture("success.json"),
    });

    expect(normalized).toEqual({
      isError: false,
      execution: { status: "passed", exitCode: 0, durationMs: 245 },
      summary: { total: 1, passed: 1, failed: 0 },
      results: [
        {
          path: "Health.yml",
          name: "Health",
          request: {
            method: "GET",
            url: "http://127.0.0.1:4015/health",
          },
          response: {
            status: 200,
            durationMs: 16,
            body: { status: "ok" },
          },
          tests: [{ name: "returns HTTP 200", status: "passed" }],
        },
      ],
    });
  });

  it("normalizes failed tests and assertions without making them MCP errors", () => {
    const normalized = normalizeBruReport({
      exitCode: 1,
      stderr: "",
      reportRaw: reportFixture("failed-assertion.json"),
    });

    expect(normalized.isError).toBe(false);
    expect(normalized.execution).toEqual({
      status: "failed",
      exitCode: 1,
      durationMs: 316,
    });
    expect(normalized.summary).toEqual({ total: 1, passed: 0, failed: 1 });
    expect(normalized.results?.[0]?.tests).toEqual([
      {
        name: "returns the expected status",
        status: "failed",
        error: "expected 200 to equal 201",
      },
      {
        name: "res.status eq 201",
        status: "failed",
        error: "expected 200 to equal 201",
      },
    ]);
  });
});

describe("normalizeBruReport exit codes", () => {
  it.each([
    [0, "passed", false, undefined],
    [1, "failed", false, undefined],
    [4, "error", true, "BRUNO_EXECUTION_ERROR"],
    [5, "error", true, "BRUNO_EXECUTION_ERROR"],
    [6, "error", true, "ENVIRONMENT_NOT_FOUND"],
    [255, "error", true, "BRUNO_EXECUTION_ERROR"],
  ] as const)(
    "classifies exit code %i as %s with isError=%s",
    (exitCode, status, isError, errorCode) => {
      const normalized = normalizeBruReport({
        exitCode,
        stderr: "bru diagnostic",
      });

      expect(normalized.execution).toEqual({ status, exitCode });
      expect(normalized.isError).toBe(isError);
      expect(normalized.reportAvailable).toBe(false);
      expect(normalized.diagnostics?.stderr).toBe("bru diagnostic");
      expect(normalized.code).toBe(errorCode);
    },
  );

  it("keeps a valid report inspectable when the CLI exits with an execution error", () => {
    const normalized = normalizeBruReport({
      exitCode: 4,
      stderr: "not in a collection",
      reportRaw: reportFixture("success.json"),
    });

    expect(normalized.isError).toBe(true);
    expect(normalized.code).toBe("BRUNO_EXECUTION_ERROR");
    expect(normalized.execution.status).toBe("error");
    expect(normalized.summary).toEqual({ total: 1, passed: 1, failed: 0 });
    expect(normalized.results).toHaveLength(1);
    expect(normalized.diagnostics?.stderr).toBe("not in a collection");
  });
});

describe("normalizeBruReport resilience", () => {
  it("returns the unavailable diagnostic shape for missing reports", () => {
    expect(
      normalizeBruReport({ exitCode: 1, stderr: "report was not written" }),
    ).toEqual({
      isError: false,
      execution: { status: "failed", exitCode: 1 },
      reportAvailable: false,
      diagnostics: { stderr: "report was not written" },
    });
  });

  it("surfaces parse errors without discarding stderr", () => {
    const normalized = normalizeBruReport({
      exitCode: 0,
      stderr: "reporter warning",
      reportRaw: "{not-json",
    });

    expect(normalized).toMatchObject({
      isError: false,
      execution: { status: "passed", exitCode: 0 },
      reportAvailable: false,
      diagnostics: { stderr: "reporter warning" },
      code: "REPORT_PARSE_ERROR",
    });
  });

  it("treats a valid non-reporter JSON value as a parse error", () => {
    const normalized = normalizeBruReport({
      exitCode: 1,
      stderr: "schema changed",
      reportRaw: JSON.stringify({ results: [] }),
    });

    expect(normalized.code).toBe("REPORT_PARSE_ERROR");
    expect(normalized.reportAvailable).toBe(false);
    expect(normalized.isError).toBe(false);
  });

  it("preserves both execution and reporter errors for malformed error reports", () => {
    const normalized = normalizeBruReport({
      exitCode: 6,
      stderr: "missing environment",
      reportRaw: "null",
    });

    expect(normalized.code).toBe("ENVIRONMENT_NOT_FOUND");
    expect(normalized.isError).toBe(true);
    expect(normalized.diagnostics).toEqual({
      stderr: "missing environment",
      reportError: {
        code: "REPORT_PARSE_ERROR",
        message: "Bruno JSON reporter output could not be parsed.",
      },
    });
  });

  it("derives missing summaries and tolerates unknown and optional fields", () => {
    const normalized = normalizeBruReport({
      exitCode: 1,
      stderr: "",
      reportRaw: JSON.stringify([
        {
          futureIterationField: true,
          results: [
            {
              test: { filename: "Folder/Partial.yml" },
              request: { method: "POST", futureRequestField: "ignored" },
              response: { data: null },
              testResults: [{ description: "partial check" }],
              futureResultField: { value: 1 },
            },
          ],
        },
      ]),
    });

    expect(normalized).toEqual({
      isError: false,
      execution: { status: "failed", exitCode: 1 },
      summary: { total: 1, passed: 1, failed: 0 },
      results: [
        {
          path: "Folder/Partial.yml",
          name: "Partial",
          request: { method: "POST" },
          response: { body: null },
          tests: [{ name: "partial check", status: "unknown" }],
        },
      ],
    });
  });

  it("uses available partial summary fields and derives the rest", () => {
    const normalized = normalizeBruReport({
      exitCode: 1,
      stderr: "",
      reportRaw: JSON.stringify([
        {
          results: [
            {
              path: "Failure.yml",
              status: "pass",
              assertionResults: [{ status: "fail" }],
            },
          ],
          summary: { totalRequests: 7 },
        },
      ]),
    });

    expect(normalized.summary).toEqual({ total: 7, passed: 0, failed: 1 });
  });
});

describe("report output limits", () => {
  it("measures the raw report as UTF-8 bytes and rejects oversized output", () => {
    expect(() => assertReportSize("é", 2)).not.toThrow();

    let caught: unknown;
    try {
      assertReportSize("é", 1);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BrunoMcpError);
    expect((caught as BrunoMcpError).code).toBe("REPORT_TOO_LARGE");
    expect((caught as BrunoMcpError).message).toContain("2 bytes");
    expect((caught as BrunoMcpError).message).not.toContain("é");
  });

  it("accepts missing reports and output exactly at the configured limit", () => {
    expect(() => assertReportSize(undefined, 1)).not.toThrow();
    expect(() => assertReportSize("abc", 3)).not.toThrow();
  });

  it("removes oversized bodies and exposes deterministic byte metadata", () => {
    const report = normalizeBruReport({
      exitCode: 0,
      stderr: "",
      reportRaw: JSON.stringify([
        {
          results: [
            {
              path: "Large.yml",
              response: { status: 200, data: { payload: "éé" } },
            },
            {
              path: "Small.yml",
              response: { status: 204, data: "ok" },
            },
          ],
        },
      ]),
    });

    const limited = filterResponseBodies(report, {
      mode: "full",
      maxBodyBytes: 10,
    });

    expect(limited.results?.[0]?.response).toEqual({
      status: 200,
      bodyTruncated: true,
      originalBodyBytes: 18,
    });
    expect(limited.results?.[1]?.response).toEqual({ status: 204, body: "ok" });
    expect(report.results?.[0]?.response).toEqual({
      status: 200,
      body: { payload: "éé" },
    });
  });

  it("uses a conservative response-body limit by default", () => {
    const report = normalizeBruReport({
      exitCode: 0,
      stderr: "",
      reportRaw: JSON.stringify([
        {
          results: [
            {
              path: "Large.yml",
              response: {
                data: "x".repeat(DEFAULT_MAX_RESPONSE_BODY_BYTES + 1),
              },
            },
          ],
        },
      ]),
    });

    expect(
      filterResponseBodies(report, { mode: "full" }).results?.[0]?.response,
    ).toEqual({
      bodyTruncated: true,
      originalBodyBytes: DEFAULT_MAX_RESPONSE_BODY_BYTES + 1,
    });
  });

  it("omits all response bodies in none mode", () => {
    const report = normalizeBruReport({
      exitCode: 1,
      stderr: "",
      reportRaw: JSON.stringify([
        {
          results: [
            {
              path: "Failure.yml",
              response: { status: 200, data: { value: "actual" } },
              assertionResults: [{ status: "fail" }],
            },
          ],
        },
      ]),
    });

    expect(
      filterResponseBodies(report, { mode: "none" }).results?.[0]?.response,
    ).toEqual({ status: 200 });
  });

  it("defaults to bodies for failed checks only", () => {
    const report = normalizeBruReport({
      exitCode: 1,
      stderr: "",
      reportRaw: JSON.stringify([
        {
          results: [
            {
              path: "Success.yml",
              response: { status: 200, data: "success body" },
              testResults: [{ status: "pass" }],
            },
            {
              path: "Failure.yml",
              response: { status: 200, data: "failure body" },
              assertionResults: [{ status: "fail" }],
            },
          ],
        },
      ]),
    });

    const filtered = filterResponseBodies(report);

    expect(filtered.results?.[0]?.response).toEqual({ status: 200 });
    expect(filtered.results?.[1]?.response).toEqual({
      status: 200,
      body: "failure body",
    });
    expect(filtered.results?.[1]?.tests).toEqual([
      { name: "Assertion", status: "failed" },
    ]);
  });
});
