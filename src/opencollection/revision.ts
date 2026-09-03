import { createHash } from "node:crypto";

/** Public request revisions are 128-bit base64url values without padding. */
export const REQUEST_REVISION_PATTERN = /^[A-Za-z0-9_-]{21}[AQgw]$/;

/** Return a stable revision for the exact UTF-8 request source. */
export function requestRevision(source: string): string {
  return createHash("sha256")
    .update(source, "utf8")
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}
