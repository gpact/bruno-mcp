import { Buffer } from "node:buffer";

import { BrunoMcpError } from "./errors.js";

/** Raw process fields needed to normalize a Bruno JSON report. */
export interface BruReportInput {
  readonly exitCode: number;
  readonly stderr: string;
  readonly reportRaw?: string;
}

/** Stable execution states derived from the Bruno process exit code. */
export type ExecutionStatus = "passed" | "failed" | "error";

export interface NormalizedExecution {
  readonly status: ExecutionStatus;
  readonly exitCode: number;
  readonly durationMs?: number;
}

export interface NormalizedSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
}

export interface NormalizedRequest {
  readonly method?: string;
  readonly url?: string;
}

export interface NormalizedResponse {
  readonly status?: number | string;
  readonly durationMs?: number;
  readonly body?: unknown;
  readonly bodyTruncated?: true;
  readonly originalBodyBytes?: number;
}

export type NormalizedTestStatus = "passed" | "failed" | "unknown";

export interface NormalizedTest {
  readonly name: string;
  readonly status: NormalizedTestStatus;
  readonly error?: string;
}

export interface NormalizedRequestResult {
  readonly path: string;
  readonly name: string;
  readonly request: NormalizedRequest;
  readonly response: NormalizedResponse;
  readonly tests: NormalizedTest[];
}

export type ReportErrorCode =
  | "BRUNO_EXECUTION_ERROR"
  | "REPORT_PARSE_ERROR";

export interface NormalizedReportError {
  readonly code: ReportErrorCode;
  readonly message: string;
}

export interface ReportDiagnostics {
  readonly stderr: string;
  readonly reportError?: NormalizedReportError;
}

/**
 * Normalized execution payload plus the MCP tool-error classification that the
 * run tool must apply. Failed requests and assertions are inspectable results,
 * while CLI execution failures are tool errors.
 */
export interface NormalizedBruReport {
  readonly isError: boolean;
  readonly execution: NormalizedExecution;
  readonly summary?: NormalizedSummary;
  readonly results?: NormalizedRequestResult[];
  readonly reportAvailable?: false;
  readonly diagnostics?: ReportDiagnostics;
  readonly code?: ReportErrorCode;
  readonly message?: string;
}

type UnknownRecord = Record<string, unknown>;

interface DerivedSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly errors: number;
}

interface NormalizedIterations {
  readonly durationMs?: number;
  readonly summary: NormalizedSummary;
  readonly results: NormalizedRequestResult[];
}

const REPORT_PARSE_MESSAGE = "Bruno JSON reporter output could not be parsed.";

/** Default maximum serialized size of one normalized response body (256 KiB). */
export const DEFAULT_MAX_RESPONSE_BODY_BYTES = 262_144;

/** Controls which normalized response bodies are included in MCP output. */
export type ResponseBodyMode = "none" | "onFailure" | "full";

export interface ResponseBodyOutputOptions {
  readonly mode?: ResponseBodyMode;
  readonly maxBodyBytes?: number;
}

/**
 * Reject raw reporter output whose UTF-8 byte length exceeds the configured
 * limit. The error includes sizes only and never includes reporter content.
 */
export function assertReportSize(
  reportRaw: string | undefined,
  maxReportBytes: number,
): void {
  if (reportRaw === undefined) {
    return;
  }

  const reportBytes = Buffer.byteLength(reportRaw, "utf8");
  if (reportBytes > maxReportBytes) {
    throw new BrunoMcpError(
      "REPORT_TOO_LARGE",
      `Bruno JSON report is ${reportBytes} bytes, exceeding the ${maxReportBytes} byte limit.`,
    );
  }
}

function bodyByteLength(body: unknown): number {
  if (typeof body === "string") {
    return Buffer.byteLength(body, "utf8");
  }

  const serialized = JSON.stringify(body);
  return serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
}

function hasFailedCheck(result: NormalizedRequestResult): boolean {
  return result.tests.some((test) => test.status === "failed");
}

/**
 * Return a copy of a normalized report containing only the requested response
 * bodies. Oversized included bodies are replaced by deterministic size metadata.
 */
export function filterResponseBodies(
  report: NormalizedBruReport,
  options: ResponseBodyOutputOptions = {},
): NormalizedBruReport {
  if (report.results === undefined) {
    return report;
  }

  const mode = options.mode ?? "onFailure";
  const maxBodyBytes =
    options.maxBodyBytes ?? DEFAULT_MAX_RESPONSE_BODY_BYTES;
  let changed = false;
  const results = report.results.map((result) => {
    const includeBody =
      mode === "full" || (mode === "onFailure" && hasFailedCheck(result));
    if (!includeBody) {
      if (
        !Object.hasOwn(result.response, "body") &&
        result.response.bodyTruncated === undefined &&
        result.response.originalBodyBytes === undefined
      ) {
        return result;
      }

      changed = true;
      const {
        body: _body,
        bodyTruncated: _bodyTruncated,
        originalBodyBytes: _originalBodyBytes,
        ...response
      } = result.response;
      return { ...result, response };
    }

    if (!Object.hasOwn(result.response, "body")) {
      return result;
    }

    const originalBodyBytes = bodyByteLength(result.response.body);
    if (originalBodyBytes <= maxBodyBytes) {
      return result;
    }

    changed = true;
    const { body: _body, ...response } = result.response;
    return {
      ...result,
      response: {
        ...response,
        bodyTruncated: true as const,
        originalBodyBytes,
      },
    };
  });

  return changed ? { ...report, results } : report;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asCount(value: unknown): number | undefined {
  const number = asNumber(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

function normalizedTestStatus(value: unknown): NormalizedTestStatus {
  if (value === "pass" || value === "passed") {
    return "passed";
  }
  if (value === "fail" || value === "failed" || value === "error") {
    return "failed";
  }
  return "unknown";
}

function assertionName(assertion: UnknownRecord): string | undefined {
  const expression = asString(assertion.lhsExpr);
  const expected = asString(assertion.rhsExpr);
  const parts = [expression, expected].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function normalizeTest(
  value: unknown,
  assertion: boolean,
): NormalizedTest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const name =
    asString(value.description) ??
    asString(value.name) ??
    (assertion ? assertionName(value) : undefined) ??
    (assertion ? "Assertion" : "Test");
  const error = asString(value.error);

  return {
    name,
    status: normalizedTestStatus(value.status),
    ...(error === undefined ? {} : { error }),
  };
}

function normalizeTestArray(
  result: UnknownRecord,
  field: string,
  assertion = false,
): NormalizedTest[] {
  const values = result[field];
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => normalizeTest(value, assertion))
    .filter((value): value is NormalizedTest => value !== undefined);
}

function defaultName(path: string): string {
  const filename = path.split(/[\\/]/).at(-1) ?? "";
  return filename.replace(/\.ya?ml$/i, "");
}

function normalizeResult(value: UnknownRecord): NormalizedRequestResult {
  const test = isRecord(value.test) ? value.test : undefined;
  const path = asString(value.path) ?? asString(test?.filename) ?? "";
  const name = asString(value.name) ?? defaultName(path);
  const rawRequest = isRecord(value.request) ? value.request : {};
  const rawResponse = isRecord(value.response) ? value.response : {};

  const method = asString(rawRequest.method);
  const url = asString(rawRequest.url);
  const status = rawResponse.status;
  const durationMs =
    asNumber(rawResponse.duration) ?? asNumber(rawResponse.responseTime);
  const hasBody = Object.hasOwn(rawResponse, "data");

  return {
    path,
    name,
    request: {
      ...(method === undefined ? {} : { method }),
      ...(url === undefined ? {} : { url }),
    },
    response: {
      ...(typeof status === "number" || typeof status === "string"
        ? { status }
        : {}),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(hasBody ? { body: rawResponse.data } : {}),
    },
    tests: [
      ...normalizeTestArray(value, "preRequestTestResults"),
      ...normalizeTestArray(value, "testResults"),
      ...normalizeTestArray(value, "assertionResults", true),
      ...normalizeTestArray(value, "postResponseTestResults"),
    ],
  };
}

function rawChecks(result: UnknownRecord): unknown[] {
  const fields = [
    "preRequestTestResults",
    "testResults",
    "assertionResults",
    "postResponseTestResults",
  ];
  return fields.flatMap((field) => {
    const value = result[field];
    return Array.isArray(value) ? value : [];
  });
}

function deriveSummary(results: UnknownRecord[]): DerivedSummary {
  let passed = 0;
  let failed = 0;
  let errors = 0;

  for (const result of results) {
    if (result.skipped === true || result.status === "skipped") {
      continue;
    }

    const status = asString(result.status);
    const hasFailedCheck = rawChecks(result).some(
      (check) =>
        isRecord(check) && normalizedTestStatus(check.status) === "failed",
    );
    if (hasFailedCheck || status === "fail" || status === "failed") {
      failed += 1;
    } else if (
      status === "error" ||
      (result.error !== undefined && result.error !== null)
    ) {
      errors += 1;
    } else {
      passed += 1;
    }
  }

  return { total: results.length, passed, failed, errors };
}

function iterationSummary(
  iteration: UnknownRecord,
  results: UnknownRecord[],
): NormalizedSummary {
  const derived = deriveSummary(results);
  const summary = isRecord(iteration.summary) ? iteration.summary : {};
  const failedRequests = asCount(summary.failedRequests) ?? derived.failed;
  const errorRequests = asCount(summary.errorRequests) ?? derived.errors;

  return {
    total: asCount(summary.totalRequests) ?? derived.total,
    passed: asCount(summary.passedRequests) ?? derived.passed,
    failed: failedRequests + errorRequests,
  };
}

function normalizeIterations(iterations: UnknownRecord[]): NormalizedIterations {
  const results: NormalizedRequestResult[] = [];
  let total = 0;
  let passed = 0;
  let failed = 0;
  let durationSeconds = 0;
  let durationAvailable = false;

  for (const iteration of iterations) {
    const rawResults = Array.isArray(iteration.results)
      ? iteration.results.filter(isRecord)
      : [];
    const summary = iterationSummary(iteration, rawResults);
    total += summary.total;
    passed += summary.passed;
    failed += summary.failed;

    for (const result of rawResults) {
      results.push(normalizeResult(result));
      const runDuration = asNumber(result.runDuration);
      if (runDuration !== undefined) {
        durationAvailable = true;
        durationSeconds += runDuration;
      }
    }
  }

  return {
    ...(durationAvailable
      ? { durationMs: Math.round(durationSeconds * 1_000) }
      : {}),
    summary: { total, passed, failed },
    results,
  };
}

function executionStatus(exitCode: number): ExecutionStatus {
  if (exitCode === 0) {
    return "passed";
  }
  return exitCode === 1 ? "failed" : "error";
}

function executionError(exitCode: number): NormalizedReportError {
  return {
    code: "BRUNO_EXECUTION_ERROR",
    message: `Bruno execution failed with exit code ${exitCode}.`,
  };
}

function unavailableReport(input: BruReportInput): NormalizedBruReport {
  const execution = {
    status: executionStatus(input.exitCode),
    exitCode: input.exitCode,
  } as const;

  if (input.exitCode === 0 || input.exitCode === 1) {
    return {
      isError: false,
      execution,
      reportAvailable: false,
      diagnostics: { stderr: input.stderr },
    };
  }

  const error = executionError(input.exitCode);
  return {
    isError: true,
    execution,
    reportAvailable: false,
    diagnostics: { stderr: input.stderr },
    ...error,
  };
}

function unparseableReport(input: BruReportInput): NormalizedBruReport {
  const reportError: NormalizedReportError = {
    code: "REPORT_PARSE_ERROR",
    message: REPORT_PARSE_MESSAGE,
  };
  const execution = {
    status: executionStatus(input.exitCode),
    exitCode: input.exitCode,
  } as const;

  if (input.exitCode === 0 || input.exitCode === 1) {
    return {
      isError: false,
      execution,
      reportAvailable: false,
      diagnostics: { stderr: input.stderr },
      ...reportError,
    };
  }

  const error = executionError(input.exitCode);
  return {
    isError: true,
    execution,
    reportAvailable: false,
    diagnostics: { stderr: input.stderr, reportError },
    ...error,
  };
}

/**
 * Parse and normalize a Bruno JSON reporter document. The report is treated as
 * untrusted versioned input: unknown fields are ignored and absent optional
 * sections fall back to empty or derived values.
 */
export function normalizeBruReport(input: BruReportInput): NormalizedBruReport {
  if (input.reportRaw === undefined) {
    return unavailableReport(input);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.reportRaw) as unknown;
  } catch {
    return unparseableReport(input);
  }

  if (!Array.isArray(parsed) || !parsed.every(isRecord)) {
    return unparseableReport(input);
  }

  const normalized = normalizeIterations(parsed);
  const execution = {
    status: executionStatus(input.exitCode),
    exitCode: input.exitCode,
    ...(normalized.durationMs === undefined
      ? {}
      : { durationMs: normalized.durationMs }),
  };

  if (input.exitCode === 0 || input.exitCode === 1) {
    return {
      isError: false,
      execution,
      summary: normalized.summary,
      results: normalized.results,
    };
  }

  const error = executionError(input.exitCode);
  return {
    isError: true,
    execution,
    summary: normalized.summary,
    results: normalized.results,
    diagnostics: { stderr: input.stderr },
    ...error,
  };
}
