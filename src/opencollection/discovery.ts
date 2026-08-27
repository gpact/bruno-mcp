import { readdirSync } from "node:fs";
import { join } from "node:path";

import { BrunoMcpError } from "../bruno/errors.js";
import { resolveWithinRoot } from "../security/paths.js";
import { loadCollection } from "./collection.js";
import { OPENCOLLECTION_FILE } from "./paths.js";
import type { CollectionSummary } from "./types.js";

/** Recursively discover valid OpenCollection roots beneath the configured root. */
export function discoverCollections(root: string): CollectionSummary[] {
  const canonicalRoot = resolveWithinRoot(root, ".");
  const collections: CollectionSummary[] = [];

  walk(canonicalRoot);
  collections.sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  return collections;

  function walk(directory: string): void {
    const entries = readdirSync(directory, { withFileTypes: true });

    if (entries.some((entry) => entry.name === OPENCOLLECTION_FILE)) {
      try {
        collections.push(loadCollection(canonicalRoot, directory));
      } catch (error) {
        if (!isSkippableCollectionError(error)) {
          throw error;
        }
      }
    }

    for (const entry of entries) {
      // Do not follow directory symlinks: they can create cycles, aliases, or
      // leave the configured root. Explicit real directories are still walked.
      if (entry.isDirectory()) {
        walk(join(directory, entry.name));
      }
    }
  }
}

function isSkippableCollectionError(error: unknown): boolean {
  return (
    error instanceof BrunoMcpError &&
    (error.code === "INVALID_COLLECTION" ||
      error.code === "COLLECTION_NOT_FOUND" ||
      error.code === "PATH_OUTSIDE_ROOT")
  );
}
