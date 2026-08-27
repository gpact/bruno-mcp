import { realpathSync, statSync } from "node:fs";

import { z } from "zod";

import { LOG_LEVELS, type LogLevel } from "../logger.js";

/** Default per-run execution timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 120_000;
/** Hard upper bound for the per-run execution timeout in milliseconds. */
export const MAX_TIMEOUT_MS = 900_000;
/** Default maximum reporter output size in bytes (5 MiB). */
export const DEFAULT_MAX_REPORT_BYTES = 5_242_880;
/** Default Bruno CLI executable name resolved from PATH. */
export const DEFAULT_BRU_EXECUTABLE = "bru";
/** Default log level when none is configured. */
export const DEFAULT_LOG_LEVEL: LogLevel = "info";

/**
 * Fully validated, immutable runtime configuration derived from the process
 * environment. The only filesystem I/O performed while producing a `Config`
 * is canonicalizing and validating {@link Config.root}.
 */
export interface Config {
  /** Canonical real path all collection/request/env/exec paths must stay within. */
  readonly root: string;
  /** Path or name of the Bruno CLI executable. Never interpolated into a shell. */
  readonly bru: string;
  /** Per-run execution timeout in milliseconds (capped at {@link MAX_TIMEOUT_MS}). */
  readonly timeoutMs: number;
  /** Whether the Bruno developer sandbox may be enabled for a run. */
  readonly allowDeveloperSandbox: boolean;
  /** Whether MCP calls may request Bruno's insecure TLS behavior. */
  readonly allowInsecure: boolean;
  /** Maximum accepted reporter output size in bytes. */
  readonly maxReportBytes: number;
  /** Configured logger level. */
  readonly logLevel: LogLevel;
}

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off"]);

function isUnset(raw: string | undefined): raw is undefined | "" {
  return raw === undefined || raw.trim() === "";
}

function booleanField(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (isUnset(raw)) {
        return defaultValue;
      }

      const normalized = raw.trim().toLowerCase();
      if (TRUE_VALUES.has(normalized)) {
        return true;
      }
      if (FALSE_VALUES.has(normalized)) {
        return false;
      }

      ctx.addIssue({
        code: "custom",
        message: `must be a boolean (true/false/1/0/yes/no/on/off), received "${raw}"`,
      });
      return z.NEVER;
    });
}

function positiveIntegerField(
  defaultValue: number,
  unit: string,
  cap?: number,
) {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (isUnset(raw)) {
        return defaultValue;
      }

      const trimmed = raw.trim();
      const value = Number(trimmed);
      if (
        !/^\d+$/.test(trimmed) ||
        !Number.isSafeInteger(value) ||
        value <= 0
      ) {
        ctx.addIssue({
          code: "custom",
          message: `must be a positive integer number of ${unit}, received "${raw}"`,
        });
        return z.NEVER;
      }

      return cap === undefined ? value : Math.min(value, cap);
    });
}

const rootField = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    const candidate = isUnset(raw) ? process.cwd() : raw;

    try {
      const canonicalPath = realpathSync(candidate);
      if (!statSync(canonicalPath).isDirectory()) {
        ctx.addIssue({
          code: "custom",
          message: `must resolve to a directory, received "${candidate}"`,
        });
        return z.NEVER;
      }

      return canonicalPath;
    } catch {
      ctx.addIssue({
        code: "custom",
        message: `could not resolve directory "${candidate}" to a canonical real path`,
      });
      return z.NEVER;
    }
  });

const bruField = z
  .string()
  .optional()
  .transform((raw) => raw ?? DEFAULT_BRU_EXECUTABLE);

const logLevelField = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    if (isUnset(raw)) {
      return DEFAULT_LOG_LEVEL;
    }

    const normalized = raw.trim().toLowerCase();
    if ((LOG_LEVELS as readonly string[]).includes(normalized)) {
      return normalized as LogLevel;
    }

    ctx.addIssue({
      code: "custom",
      message: `must be one of ${LOG_LEVELS.join(", ")}, received "${raw}"`,
    });
    return z.NEVER;
  });

const configSchema = z.object({
  BRUNO_MCP_ROOT: rootField,
  BRUNO_MCP_BRU: bruField,
  BRUNO_MCP_TIMEOUT_MS: positiveIntegerField(
    DEFAULT_TIMEOUT_MS,
    "milliseconds",
    MAX_TIMEOUT_MS,
  ),
  BRUNO_MCP_ALLOW_DEVELOPER_SANDBOX: booleanField(false),
  BRUNO_MCP_ALLOW_INSECURE: booleanField(false),
  BRUNO_MCP_MAX_REPORT_BYTES: positiveIntegerField(
    DEFAULT_MAX_REPORT_BYTES,
    "bytes",
  ),
  BRUNO_MCP_LOG_LEVEL: logLevelField,
});

/**
 * Parse and validate configuration from the given environment. Throws an
 * `Error` with an aggregated, human-readable message when any value is invalid.
 *
 * @param env - Environment source, defaults to `process.env`.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const key =
          issue.path.length > 0 ? issue.path.join(".") : "configuration";
        return `${key}: ${issue.message}`;
      })
      .join("; ");

    throw new Error(`Invalid Bruno MCP configuration: ${details}`);
  }

  const data = result.data;

  return {
    root: data.BRUNO_MCP_ROOT,
    bru: data.BRUNO_MCP_BRU,
    timeoutMs: data.BRUNO_MCP_TIMEOUT_MS,
    allowDeveloperSandbox: data.BRUNO_MCP_ALLOW_DEVELOPER_SANDBOX,
    allowInsecure: data.BRUNO_MCP_ALLOW_INSECURE,
    maxReportBytes: data.BRUNO_MCP_MAX_REPORT_BYTES,
    logLevel: data.BRUNO_MCP_LOG_LEVEL,
  };
}
