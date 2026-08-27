export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogContext = Readonly<Record<string, unknown>>;
export type LogRedactor = (
  context: LogContext,
  level: LogLevel,
) => LogContext;

export interface Logger {
  error(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  redact?: LogRedactor;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const REDACTED = "[REDACTED]";
const SENSITIVE_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "xapikey",
  "xauthtoken",
  "password",
  "passwd",
  "clientsecret",
  "accesstoken",
  "refreshtoken",
  "variables",
  "variableoverrides",
  "overrides",
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function redactValue(
  value: unknown,
  level: LogLevel,
  seen: WeakSet<object>,
): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }

    seen.add(value);
    return value.map((item) => redactValue(item, level, seen));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);
  const source = value as Record<string, unknown>;
  const secretValue = source.secret === true;

  return Object.fromEntries(
    Object.entries(source).map(([key, item]) => {
      const normalizedKey = normalizeKey(key);
      const isSensitive =
        SENSITIVE_KEYS.has(normalizedKey) ||
        (secretValue && normalizedKey === "value") ||
        (level !== "debug" && normalizedKey === "body");

      return [
        key,
        isSensitive ? REDACTED : redactValue(item, level, seen),
      ];
    }),
  );
}

export function redactLogContext(
  context: LogContext,
  level: LogLevel,
): LogContext {
  return redactValue(context, level, new WeakSet()) as LogContext;
}

export function readLogLevel(
  env: NodeJS.ProcessEnv = process.env,
): LogLevel {
  const value = env.BRUNO_MCP_LOG_LEVEL;
  return LOG_LEVELS.includes(value as LogLevel) ? (value as LogLevel) : "info";
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const configuredLevel = options.level ?? readLogLevel();

  function log(
    level: LogLevel,
    message: string,
    context?: LogContext,
  ): void {
    if (LEVEL_PRIORITY[level] > LEVEL_PRIORITY[configuredLevel]) {
      return;
    }

    let suffix = "";
    if (context !== undefined) {
      const customRedacted = options.redact?.(context, level) ?? context;
      suffix = ` ${JSON.stringify(redactLogContext(customRedacted, level))}`;
    }

    process.stderr.write(`[${level}] ${message}${suffix}\n`);
  }

  return {
    error: (message, context) => log("error", message, context),
    warn: (message, context) => log("warn", message, context),
    info: (message, context) => log("info", message, context),
    debug: (message, context) => log("debug", message, context),
  };
}

export const logger = createLogger();
