/**
 * Shared secret-redaction primitives.
 *
 * The redaction placeholder and value-resolution rule live here so that every
 * surface exposing potentially sensitive data (environment inspection and, later,
 * reporter output) applies identical, auditable behavior. Secret handling must be
 * defined in exactly one place to keep the guarantee "secrets never leave the
 * process" verifiable.
 */

/** Replacement emitted in place of any secret value exposed through MCP. */
export const REDACTED = "[REDACTED]";

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
