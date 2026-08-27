/**
 * Shared secret-redaction primitives.
 *
 * The redaction placeholder and value-resolution rule live here so that every
 * surface exposing potentially sensitive data (environment inspection and
 * reporter output) applies identical, auditable behavior. Secret handling must be
 * defined in exactly one place to keep the guarantee "secrets never leave the
 * process" verifiable.
 */

/** Replacement emitted in place of any secret value exposed through MCP. */
export const REDACTED = "[REDACTED]";

/** Header names whose values must never be exposed through MCP. */
export const SENSITIVE_HEADERS = [
  "Authorization",
  "Proxy-Authorization",
  "Cookie",
  "Set-Cookie",
  "X-API-Key",
  "X-Auth-Token",
] as const;

const SENSITIVE_HEADER_NAMES = new Set(
  SENSITIVE_HEADERS.map((name) => name.toLowerCase()),
);

/**
 * Resolve the MCP-exposable form of a single variable value.
 *
 * Secret values always collapse to {@link REDACTED}, regardless of what is
 * physically stored: a secret accidentally saved as plaintext YAML must still
 * never be returned. Non-secret values are surfaced verbatim, coerced to a
 * string, with a missing value represented as an empty string.
 */
export function redactSecretValue(value: unknown, secret: boolean): string {
  if (secret) {
    return REDACTED;
  }
  if (value === undefined || value === null) {
    return "";
  }
  return String(value);
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const source = value as Record<string, unknown>;
  const secretValue = source.secret === true;

  return Object.fromEntries(
    Object.entries(source).map(([key, item]) => {
      const normalizedKey = key.toLowerCase();
      const sensitive =
        SENSITIVE_HEADER_NAMES.has(normalizedKey) ||
        (secretValue && normalizedKey === "value");
      return [key, sensitive ? REDACTED : redactValue(item)];
    }),
  );
}

/**
 * Return a recursively redacted copy of reporter data. Header names and all
 * non-sensitive structure are preserved, and the input value is not mutated.
 */
export function redactReport<T>(report: T): T {
  return redactValue(report) as T;
}
