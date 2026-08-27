import { readFileSync, readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { basename } from "node:path";

import { BrunoMcpError } from "../bruno/errors.js";
import { redactSecretValue } from "../security/redact.js";
import { resolveWithinCollection } from "../security/paths.js";
import { resolveCollection } from "./collection.js";
import { ENVIRONMENTS_DIR, YAML_EXTENSION, isYamlFile } from "./paths.js";
import { parseYaml } from "./parser.js";
import type {
  EnvironmentDetail,
  EnvironmentDocument,
  EnvironmentSummary,
  EnvironmentVariable,
  EnvironmentVariableDetail,
} from "./types.js";

/**
 * Enumerate every `environments/*.yml` definition beneath a collection root and
 * summarize each. Variable values are never placed into the summary, so this
 * path cannot leak any variable data (secret or not).
 *
 * Returns an empty list when the collection has no `environments/` directory.
 * Files that escape the collection root (for example symlinks pointing outside)
 * are skipped, as are files whose YAML cannot be parsed, so a single malformed
 * environment never hides the rest. Results are sorted lexicographically by name
 * for deterministic output.
 */
export function listEnvironments(
  root: string,
  collectionId: string,
): EnvironmentSummary[] {
  const collectionRoot = resolveCollection(root, collectionId);
  const environmentsDir = resolveWithinCollection(
    root,
    collectionRoot,
    ENVIRONMENTS_DIR,
  );

  const summaries: EnvironmentSummary[] = [];

  for (const entry of readDirectoryEntries(environmentsDir)) {
    if (!entry.isFile() || !isYamlFile(entry.name)) {
      continue;
    }

    const relativePath = `${ENVIRONMENTS_DIR}/${entry.name}`;

    let filePath: string;
    try {
      filePath = resolveWithinCollection(root, collectionRoot, relativePath);
    } catch {
      // Skip environment files that resolve outside the collection root.
      continue;
    }

    let variables: EnvironmentVariable[];
    try {
      variables = readEnvironmentVariables(filePath, relativePath);
    } catch (error) {
      if (isInvalidYamlError(error)) {
        // Skip environment files whose YAML cannot be parsed: one malformed
        // file must not hide the rest of the collection's environments.
        // Mirrors the skip-and-continue behavior of collection discovery.
        continue;
      }
      throw error;
    }

    summaries.push({
      name: environmentNameFromFile(entry.name),
      path: relativePath,
      variableCount: variables.length,
      secretCount: variables.filter((variable) => variable.secret === true)
        .length,
    });
  }

  summaries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  return summaries;
}

/**
 * Resolve a single environment for inspection.
 *
 * The `reference` may be a bare name (`Local`) or a collection-relative file
 * path (`environments/Local.yml`); both normalize to the same target. Secret
 * variable values are replaced with the redaction placeholder before returning.
 *
 * @throws {BrunoMcpError} `ENVIRONMENT_NOT_FOUND` when no matching environment
 *   file exists (including references that escape the collection root).
 */
export function getEnvironment(
  root: string,
  collectionId: string,
  reference: string,
): EnvironmentDetail {
  const collectionRoot = resolveCollection(root, collectionId);
  const name = normalizeEnvironmentReference(reference);
  const relativePath = `${ENVIRONMENTS_DIR}/${name}${YAML_EXTENSION}`;

  let filePath: string;
  try {
    filePath = resolveWithinCollection(root, collectionRoot, relativePath);
  } catch {
    throw environmentNotFound(reference);
  }

  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      throw environmentNotFound(reference);
    }
    throw error;
  }

  return {
    name,
    variables: parseEnvironmentVariables(content, relativePath).map(
      toVariableDetail,
    ),
  };
}

/**
 * Map a stored variable to its exposable form. Secret values are collapsed to
 * the redaction placeholder here, so callers never observe the raw value.
 */
function toVariableDetail(
  variable: EnvironmentVariable,
): EnvironmentVariableDetail {
  const secret = variable.secret === true;
  return {
    name: variable.name,
    value: redactSecretValue(variable.value, secret),
    secret,
  };
}

/**
 * Normalize a bare name or collection-relative path to the environment's base
 * name. `Local`, `Local.yml`, and `environments/Local.yml` all reduce to
 * `Local`. Traversal segments are preserved and later rejected by path security.
 */
function normalizeEnvironmentReference(reference: string): string {
  let value = reference.trim();

  const prefix = `${ENVIRONMENTS_DIR}/`;
  if (value.startsWith(prefix)) {
    value = value.slice(prefix.length);
  }

  if (value.toLowerCase().endsWith(YAML_EXTENSION)) {
    value = value.slice(0, -YAML_EXTENSION.length);
  }

  return value;
}

function readEnvironmentVariables(
  filePath: string,
  source: string,
): EnvironmentVariable[] {
  return parseEnvironmentVariables(readFileSync(filePath, "utf8"), source);
}

function parseEnvironmentVariables(
  content: string,
  source: string,
): EnvironmentVariable[] {
  const document = parseYaml(content, { source }) as EnvironmentDocument | null;

  if (!isRecord(document) || !Array.isArray(document.variables)) {
    return [];
  }

  const variables: EnvironmentVariable[] = [];
  for (const entry of document.variables) {
    if (isRecord(entry) && typeof entry.name === "string") {
      variables.push(entry as EnvironmentVariable);
    }
  }
  return variables;
}

function environmentNameFromFile(fileName: string): string {
  return basename(fileName, YAML_EXTENSION);
}

function readDirectoryEntries(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isInvalidYamlError(error: unknown): boolean {
  return error instanceof BrunoMcpError && error.code === "INVALID_YAML";
}

function environmentNotFound(reference: string): BrunoMcpError {
  return new BrunoMcpError(
    "ENVIRONMENT_NOT_FOUND",
    `Environment "${reference}" does not exist.`,
  );
}
