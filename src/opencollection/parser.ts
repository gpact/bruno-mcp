import {
  parse as parseYamlSource,
  parseDocument as parseYamlDocumentSource,
  stringify as stringifyYamlValue,
} from "yaml";
import type { Document, ParsedNode } from "yaml";

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

/** Parse YAML into its editable document tree while preserving source details. */
export function parseYamlDocument(
  content: string,
  options: ParseYamlOptions = {},
): Document.Parsed<ParsedNode> {
  try {
    const document = parseYamlDocumentSource(content, { logLevel: "error" });
    if (document.errors.length > 0) {
      throw document.errors[0];
    }
    return document;
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

/** Serialize a value as stable, human-readable OpenCollection YAML. */
export function stringifyYaml(value: unknown): string {
  return stringifyYamlValue(value, {
    defaultStringType: "PLAIN",
    indent: 2,
    lineWidth: 0,
    minContentWidth: 0,
  });
}
