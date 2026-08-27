import { parse as parseYamlSource } from "yaml";

import { BrunoMcpError } from "../bruno/errors.js";

export interface ParseYamlOptions {
  /**
   * Human-readable label (typically a relative file path) included in the
   * `INVALID_YAML` error message to help locate the offending document.
   */
  source?: string;
}

/**
 * Parse YAML text into a plain JavaScript value.
 *
 * The `yaml` package performs no schema validation, so unknown OpenCollection
 * fields are tolerated by design. Parse failures are surfaced as a structured
 * {@link BrunoMcpError} with code `INVALID_YAML` rather than an uncaught exception.
 *
 * This function is read-only: it never rewrites the source.
 */
export function parseYaml(
  content: string,
  options: ParseYamlOptions = {},
): unknown {
  try {
    return parseYamlSource(content, { logLevel: "error" });
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    const where = options.source ? ` (${options.source})` : "";
    throw new BrunoMcpError(
      "INVALID_YAML",
      `Failed to parse YAML${where}.`,
      { cause },
    );
  }
}
