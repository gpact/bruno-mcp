import { readFileSync, statSync } from "node:fs";

import { BrunoMcpError } from "../bruno/errors.js";
import {
  relativeToRoot,
  resolveWithinCollection,
  resolveWithinRoot,
} from "../security/paths.js";
import { parseYaml } from "./parser.js";
import { OPENCOLLECTION_FILE } from "./paths.js";
import type {
  CollectionSummary,
  OpenCollectionDocument,
} from "./types.js";

/** Load and validate the minimum metadata required for a collection summary. */
export function loadCollection(
  root: string,
  collectionPath: string,
): CollectionSummary {
  const collectionRoot = resolveWithinRoot(root, collectionPath);
  const relativePath = relativeToRoot(root, collectionRoot);

  if (!isDirectory(collectionRoot)) {
    throw collectionNotFound(collectionPath);
  }

  const metadataPath = resolveWithinCollection(
    root,
    collectionRoot,
    OPENCOLLECTION_FILE,
  );

  if (!isFile(metadataPath)) {
    throw collectionNotFound(collectionPath);
  }

  let document: unknown;
  try {
    document = parseYaml(readFileSync(metadataPath, "utf8"), {
      source:
        relativePath === "."
          ? OPENCOLLECTION_FILE
          : `${relativePath}/${OPENCOLLECTION_FILE}`,
    });
  } catch (error) {
    throw invalidCollection(relativePath, error);
  }

  if (!isOpenCollectionDocument(document)) {
    throw invalidCollection(relativePath);
  }

  return {
    id: relativePath,
    name: getCollectionName(document),
    path: relativePath,
    openCollectionVersion: document.opencollection,
  };
}

/** Resolve a collection identifier to its canonical absolute directory. */
export function resolveCollection(root: string, id: string): string {
  const collectionRoot = resolveWithinRoot(root, id);
  loadCollection(root, collectionRoot);
  return collectionRoot;
}

function isOpenCollectionDocument(
  value: unknown,
): value is OpenCollectionDocument & { opencollection: string } {
  return (
    isRecord(value) &&
    typeof value.opencollection === "string" &&
    value.opencollection.length > 0
  );
}

function getCollectionName(document: OpenCollectionDocument): string {
  return isRecord(document.info) && typeof document.info.name === "string"
    ? document.info.name
    : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function collectionNotFound(id: string): BrunoMcpError {
  return new BrunoMcpError(
    "COLLECTION_NOT_FOUND",
    `Collection "${id}" does not exist.`,
  );
}

function invalidCollection(id: string, cause?: unknown): BrunoMcpError {
  const options =
    cause === undefined
      ? undefined
      : { cause: cause instanceof Error ? cause : new Error(String(cause)) };
  return new BrunoMcpError(
    "INVALID_COLLECTION",
    `Collection "${id}" has an invalid ${OPENCOLLECTION_FILE}.`,
    options,
  );
}
