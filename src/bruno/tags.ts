import { BrunoMcpError } from "./errors.js";

/** Bruno OpenCollection/YAML tag pattern accepted by the app UI. */
export const TAG_ALLOWED_CHARS = /^[\p{L}\p{N}_-](?:[\p{L}\p{N}_ -]*[\p{L}\p{N}_-])?$/u;

export type TagFieldName = "tags" | "excludeTags";

/**
 * Whether `value` contains any C0 control character (U+0000-U+001F) or DEL
 * (U+007F). These bytes can break argument framing, corrupt YAML/UI display, or
 * smuggle terminal control sequences, so MCP-authored tags reject them.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }

  return false;
}

/**
 * Normalize and validate one Bruno tag according to the app's tag contract.
 *
 * @throws {BrunoMcpError} `INVALID_TAG` when the tag is empty or blank, carries
 *   a control character, or contains unsupported punctuation.
 */
export function normalizeTag(tag: string, fieldName: TagFieldName): string {
  if (hasControlCharacter(tag)) {
    throw new BrunoMcpError(
      "INVALID_TAG",
      `Tag ${JSON.stringify(tag)} in ${fieldName} must not contain control characters.`,
    );
  }

  const trimmed = tag.trim();
  if (trimmed.length === 0) {
    throw new BrunoMcpError(
      "INVALID_TAG",
      `Tag in ${fieldName} must not be empty.`,
    );
  }

  if (!TAG_ALLOWED_CHARS.test(trimmed)) {
    throw new BrunoMcpError(
      "INVALID_TAG",
      `Tag ${JSON.stringify(tag)} in ${fieldName} must only contain Unicode letters, numbers, spaces, "-", and "_".`,
    );
  }

  return trimmed;
}

/** Normalize and validate tag lists without reordering or deduplicating them. */
export function normalizeTags(
  tags: readonly string[],
  fieldName: TagFieldName,
): string[] {
  const normalized: string[] = [];
  for (const tag of tags) {
    normalized.push(normalizeTag(tag, fieldName));
  }
  return normalized;
}

/** Format validated tags into Bruno CLI's comma-separated tag filter syntax. */
export function formatTags(
  tags: readonly string[],
  fieldName: TagFieldName,
): string {
  return normalizeTags(tags, fieldName).join(",");
}
