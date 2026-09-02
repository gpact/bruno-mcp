import { createHash } from "node:crypto";

/** Return a stable revision for the exact UTF-8 request source. */
export function requestRevision(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}
