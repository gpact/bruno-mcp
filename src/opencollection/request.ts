import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { BrunoMcpError } from "../bruno/errors.js";
import { resolveWithinCollection } from "../security/paths.js";
import { resolveCollection } from "./collection.js";
import { parseYaml } from "./parser.js";
import {
  FOLDER_FILE,
  OPENCOLLECTION_FILE,
  isCollectionMetadataFile,
  isEnvironmentsDir,
  isYamlFile,
} from "./paths.js";
import type {
  RequestDocument,
  RequestMetadata,
  RequestSummary,
} from "./types.js";

/** Request type that carries HTTP method and URL metadata. */
const HTTP_REQUEST_TYPE = "http";

/** A subdirectory encountered during discovery, with its ordering hint. */
interface FolderEntry {
  /** Directory base name, used as the ordering tiebreak. */
  name: string;
  /** Path relative to the collection root. */
  relativePath: string;
  /** Absolute path used to recurse into the folder. */
  absolutePath: string;
  /** `folder.yml` `info.seq`, when the folder declares one. */
  sequence?: number;
}

/**
 * Discover and classify every request YAML file beneath a collection root.
 *
 * Candidate files are `.yml` documents that are neither collection/folder
 * metadata nor environment definitions. A candidate is treated as a request
 * when it parses with an `info` block; its `info.type` is reported verbatim so
 * non-HTTP request types are listed rather than dropped.
 *
 * Invalid YAML is skipped instead of aborting the listing. URLs are returned
 * exactly as stored, without interpolating Bruno variables.
 *
 * Results follow the order Bruno itself presents and executes: a pre-order walk
 * where, within each directory, nested folders come before requests. Folders
 * are ordered by their `folder.yml` `info.seq` (then name) and requests by
 * their `info.seq` (then path); items lacking a sequence sort last. This mirrors
 * `@usebruno/cli`'s collection traversal so listing order matches run order.
 */
export function discoverRequests(
  root: string,
  collectionId: string,
): RequestSummary[] {
  const collectionRoot = resolveCollection(root, collectionId);
  const requests: RequestSummary[] = [];

  collect(collectionRoot, "", true);
  return requests;

  function collect(
    absoluteDir: string,
    relativeDir: string,
    isCollectionRoot: boolean,
  ): void {
    const entries = readdirSync(absoluteDir, { withFileTypes: true });

    // A nested directory carrying its own marker is a separate collection; its
    // requests belong to that collection, not this one.
    if (
      !isCollectionRoot &&
      entries.some((entry) => entry.name === OPENCOLLECTION_FILE)
    ) {
      return;
    }

    const folders: FolderEntry[] = [];
    const directRequests: RequestSummary[] = [];

    for (const entry of entries) {
      const childRelative =
        relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;

      // `isDirectory`/`isFile` report false for symlinks, so directory and file
      // symlinks are never followed. This keeps discovery within the real tree.
      if (entry.isDirectory()) {
        if (isCollectionRoot && isEnvironmentsDir(entry.name)) {
          continue;
        }
        const absoluteChild = join(absoluteDir, entry.name);
        const folder: FolderEntry = {
          name: entry.name,
          relativePath: childRelative,
          absolutePath: absoluteChild,
        };
        const sequence = readFolderSequence(absoluteChild, childRelative);
        if (sequence !== undefined) {
          folder.sequence = sequence;
        }
        folders.push(folder);
        continue;
      }

      if (
        entry.isFile() &&
        isYamlFile(entry.name) &&
        !isCollectionMetadataFile(entry.name)
      ) {
        const summary = classifyRequest(
          join(absoluteDir, entry.name),
          childRelative,
        );
        if (summary !== undefined) {
          directRequests.push(summary);
        }
      }
    }

    // Folders first (recursed in order), then this directory's own requests,
    // matching Bruno's `folders.concat(requests)` layout.
    folders.sort(compareFolders);
    for (const folder of folders) {
      collect(folder.absolutePath, folder.relativePath, false);
    }

    directRequests.sort(compareRequests);
    requests.push(...directRequests);
  }
}

/**
 * Resolve a request path (relative to its collection root) to a canonical
 * absolute file path via the path-security helpers.
 *
 * @throws {BrunoMcpError} `COLLECTION_NOT_FOUND` / `INVALID_COLLECTION` when the
 *   collection is unknown or malformed, `PATH_OUTSIDE_ROOT` when the request
 *   path escapes the collection, or `REQUEST_NOT_FOUND` when no file exists at
 *   the resolved location.
 */
export function resolveRequest(
  root: string,
  collectionId: string,
  requestPath: string,
): string {
  const collectionRoot = resolveCollection(root, collectionId);
  const target = resolveWithinCollection(root, collectionRoot, requestPath);

  if (!isFile(target)) {
    throw new BrunoMcpError(
      "REQUEST_NOT_FOUND",
      `Request "${requestPath}" does not exist in collection "${collectionId}".`,
    );
  }

  return target;
}

/**
 * Parse a candidate file and, when it declares an `info` block, extract its
 * normalized request metadata. Returns `undefined` for non-request files and
 * for documents whose YAML fails to parse.
 */
function classifyRequest(
  absolutePath: string,
  relativePath: string,
): RequestSummary | undefined {
  let document: unknown;
  try {
    document = parseYaml(readFileSync(absolutePath, "utf8"), {
      source: relativePath,
    });
  } catch (error) {
    if (isInvalidYamlError(error)) {
      return undefined;
    }
    throw error;
  }

  const metadata = extractRequestMetadata(document);
  if (metadata === undefined) {
    return undefined;
  }

  return { path: relativePath, ...metadata };
}

/**
 * Extract normalized request metadata from an already-parsed request document.
 *
 * Returns `undefined` when the document is not a request (no `info` block) so
 * discovery can skip it. `info.type` is reported verbatim; HTTP method and URL
 * are copied only for `http` requests, and the URL is preserved exactly as
 * stored, keeping literal Bruno variables such as `{{baseUrl}}`.
 */
export function extractRequestMetadata(
  document: unknown,
): RequestMetadata | undefined {
  if (!isRecord(document) || !isRecord(document.info)) {
    return undefined;
  }

  const info = document.info;
  const metadata: RequestMetadata = {
    name: typeof info.name === "string" ? info.name : "",
    type: typeof info.type === "string" ? info.type : "",
  };

  if (typeof info.seq === "number") {
    metadata.sequence = info.seq;
  }

  if (metadata.type === HTTP_REQUEST_TYPE) {
    applyHttpMetadata(metadata, (document as RequestDocument).http);
  }

  return metadata;
}

/**
 * Copy HTTP method and URL onto the metadata when present. The URL is preserved
 * exactly as stored, keeping literal Bruno variables such as `{{baseUrl}}`.
 */
function applyHttpMetadata(metadata: RequestMetadata, http: unknown): void {
  if (!isRecord(http)) {
    return;
  }

  if (typeof http.method === "string") {
    metadata.method = http.method;
  }
  if (typeof http.url === "string") {
    metadata.url = http.url;
  }
}

/**
 * Read a folder's ordering hint from its `folder.yml` `info.seq`, when present.
 *
 * A missing `folder.yml` is the common case and yields `undefined`. Unreadable
 * or invalid folder metadata is likewise treated as "no sequence" so a single
 * malformed folder never aborts discovery; it just falls back to name order.
 */
function readFolderSequence(
  absoluteDir: string,
  relativeDir: string,
): number | undefined {
  let content: string;
  try {
    content = readFileSync(join(absoluteDir, FOLDER_FILE), "utf8");
  } catch {
    // No folder.yml, or it is unreadable; order this folder by name only.
    return undefined;
  }

  let document: unknown;
  try {
    document = parseYaml(content, {
      source: `${relativeDir}/${FOLDER_FILE}`,
    });
  } catch (error) {
    if (isInvalidYamlError(error)) {
      return undefined;
    }
    throw error;
  }

  if (
    isRecord(document) &&
    isRecord(document.info) &&
    typeof document.info.seq === "number"
  ) {
    return document.info.seq;
  }
  return undefined;
}

/** Order requests by sequence, then by path so ties stay deterministic. */
function compareRequests(left: RequestSummary, right: RequestSummary): number {
  return (
    compareSequence(left.sequence, right.sequence) ||
    compareText(left.path, right.path)
  );
}

/** Order folders by sequence, then by name so ties stay deterministic. */
function compareFolders(left: FolderEntry, right: FolderEntry): number {
  return (
    compareSequence(left.sequence, right.sequence) ||
    compareText(left.name, right.name)
  );
}

/**
 * Compare two optional sequence hints. Declared sequences order ascending;
 * entries without one sort last, matching how Bruno places unsequenced items.
 */
function compareSequence(left?: number, right?: number): number {
  if (left === right) {
    return 0;
  }
  if (left === undefined) {
    return 1;
  }
  if (right === undefined) {
    return -1;
  }
  return left - right;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isInvalidYamlError(error: unknown): boolean {
  return error instanceof BrunoMcpError && error.code === "INVALID_YAML";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
