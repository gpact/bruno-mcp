import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { McpServer } from "@modelcontextprotocol/server";
import { isCollection, isMap, isNode, isScalar } from "yaml";
import { z } from "zod";

import { BrunoMcpError } from "../bruno/errors.js";
import type { Config } from "../config/config.js";
import { logger } from "../logger.js";
import { resolveCollection } from "../opencollection/collection.js";
import { parseYamlDocument } from "../opencollection/parser.js";
import {
  REQUEST_REVISION_PATTERN,
  requestRevision,
} from "../opencollection/revision.js";
import { resolveRequest } from "../opencollection/request.js";
import { relativeToRoot } from "../security/paths.js";
import {
  REQUEST_FIELD_SCHEMAS,
  assertNoSymlinks,
  assertOutsideNestedCollection,
  assertValidRequestPath,
} from "./create-request.js";
import { jsonResult, runTool } from "./result.js";

/** MCP tool name. */
export const UPDATE_REQUEST_TOOL_NAME = "bruno_update_request";

const inputSchema = z.strictObject({
  collection: z
    .string()
    .describe(
      "Collection identifier: the collection's path relative to the workspace root (as returned by bruno_list_collections), not its display name.",
    ),
  request: z
    .string()
    .describe(
      "Existing HTTP request path relative to the collection root, including the .yml extension.",
    ),
  expectedRevision: z
    .union([z.string().regex(REQUEST_REVISION_PATTERN), z.literal("*")])
    .describe(
      'Revision returned by bruno_get_request, or "*" to patch the latest version without a preliminary read.',
    ),
  name: REQUEST_FIELD_SCHEMAS.name.optional(),
  method: REQUEST_FIELD_SCHEMAS.method.optional(),
  url: REQUEST_FIELD_SCHEMAS.url.optional(),
  sequence: REQUEST_FIELD_SCHEMAS.sequence.nullable().optional(),
  tags: REQUEST_FIELD_SCHEMAS.tags.nullable().optional(),
  description: REQUEST_FIELD_SCHEMAS.description.optional(),
  headers: REQUEST_FIELD_SCHEMAS.headers.nullable().optional(),
  params: REQUEST_FIELD_SCHEMAS.params.nullable().optional(),
  body: REQUEST_FIELD_SCHEMAS.body.nullable().optional(),
  auth: REQUEST_FIELD_SCHEMAS.auth.nullable().optional(),
  runtime: REQUEST_FIELD_SCHEMAS.runtime.nullable().optional(),
  settings: REQUEST_FIELD_SCHEMAS.settings.nullable().optional(),
  examples: REQUEST_FIELD_SCHEMAS.examples.nullable().optional(),
  docs: REQUEST_FIELD_SCHEMAS.docs.nullable().optional(),
  app: REQUEST_FIELD_SCHEMAS.app.nullable().optional(),
});

/** Validated input for {@link updateRequest}. */
export type UpdateRequestInput = z.infer<typeof inputSchema>;

/** Output payload of the `bruno_update_request` tool. */
export interface UpdateRequestOutput {
  collection: string;
  path: string;
  changed: boolean;
  revision: string;
}

const PATCH_PATHS = {
  name: ["info", "name"],
  sequence: ["info", "seq"],
  tags: ["info", "tags"],
  description: ["info", "description"],
  method: ["http", "method"],
  url: ["http", "url"],
  headers: ["http", "headers"],
  params: ["http", "params"],
  body: ["http", "body"],
  auth: ["http", "auth"],
  runtime: ["runtime"],
  settings: ["settings"],
  examples: ["examples"],
  docs: ["docs"],
  app: ["app"],
} as const satisfies Record<string, readonly string[]>;

type PatchField = keyof typeof PATCH_PATHS;
const PATCH_FIELDS = Object.keys(PATCH_PATHS) as PatchField[];

/** Patch an existing Bruno v4 OpenCollection HTTP request in place. */
export function updateRequest(
  config: Config,
  input: UpdateRequestInput,
): UpdateRequestOutput {
  const resolved = resolveMutationTarget(config, input);
  const lock = acquireRequestLock(resolved.collectionRoot, resolved.path, input);
  try {
    return updateLockedRequest(config, input, resolved);
  } finally {
    releaseRequestLock(lock);
  }
}

function updateLockedRequest(
  config: Config,
  input: UpdateRequestInput,
  resolved: ReturnType<typeof resolveMutationTarget>,
): UpdateRequestOutput {
  const { collectionRoot, target, path } = resolved;
  const { source } = readVerifiedRequest(collectionRoot, target, input);
  const revision = requestRevision(source);
  if (input.expectedRevision !== "*" && revision !== input.expectedRevision) {
    throw revisionConflict(input.request, input.collection);
  }

  const document = parseYamlDocument(source, {
    source: `${input.collection}/${path}`,
  });
  const current = assertHttpMutationTarget(document, input);
  let changed = false;

  for (const field of PATCH_FIELDS) {
    const value = input[field];
    if (value === undefined) continue;

    const fieldPath = PATCH_PATHS[field];
    const exists = hasValueAtPath(current, fieldPath);
    if (value === null) {
      if (exists) {
        document.deleteIn(fieldPath);
        changed = true;
      }
      continue;
    }

    if (exists && isDeepStrictEqual(valueAtPath(current, fieldPath), value)) {
      continue;
    }

    setDocumentValue(document, fieldPath, value);
    changed = true;
  }

  if (!changed) {
    return {
      collection: input.collection,
      path,
      changed: false,
      revision,
    };
  }

  const updatedSource = stringifyUpdatedDocument(document, source);
  atomicReplaceRequest(
    config,
    input,
    collectionRoot,
    target,
    updatedSource,
    revision,
  );

  return {
    collection: input.collection,
    path,
    changed: true,
    revision: requestRevision(updatedSource),
  };
}

/** Register the `bruno_update_request` tool. */
export function registerUpdateRequest(server: McpServer, config: Config): void {
  server.registerTool(
    UPDATE_REQUEST_TOOL_NAME,
    {
      title: "Update Bruno request",
      description:
        'Patch an existing Bruno v4 OpenCollection HTTP request while preserving untouched YAML content. Omitted fields are unchanged, optional null fields are removed, and expectedRevision prevents stale writes. Use expectedRevision="*" to patch the latest version without first retrieving it. Do not pass credentials or other secrets directly through MCP arguments; prefer Bruno variables and environments.',
      inputSchema,
    },
    (input) => runTool(() => jsonResult({ ...updateRequest(config, input) })),
  );
}

function resolveMutationTarget(
  config: Config,
  input: Pick<UpdateRequestInput, "collection" | "request">,
): { collectionRoot: string; target: string; path: string } {
  const collectionRoot = resolveCollection(config.root, input.collection);
  assertValidRequestPath(input.request);
  assertNoSymlinks(collectionRoot, input.request);

  const lexicalTarget = resolve(collectionRoot, input.request);
  const target = resolveRequest(config.root, input.collection, input.request);
  if (target !== lexicalTarget) {
    throw new BrunoMcpError(
      "INVALID_REQUEST_PATH",
      `Request path "${input.request}" must not contain symbolic links.`,
    );
  }

  assertOutsideNestedCollection(collectionRoot, target, input.request);
  return {
    collectionRoot,
    target,
    path: relativeToRoot(collectionRoot, target),
  };
}

function assertHttpMutationTarget(
  document: ReturnType<typeof parseYamlDocument>,
  input: Pick<UpdateRequestInput, "collection" | "request">,
): Record<string, unknown> {
  const value: unknown = document.toJS();
  const info = isRecord(value) ? value.info : undefined;
  const http = isRecord(value) ? value.http : undefined;
  const valid =
    isMap(document.contents) &&
    isMap(document.get("info", true)) &&
    isMap(document.get("http", true)) &&
    isRecord(value) &&
    isRecord(info) &&
    info.type === "http" &&
    isNonBlankString(info.name) &&
    isRecord(http) &&
    isNonBlankString(http.method) &&
    isNonBlankString(http.url);

  if (!valid) {
    throw new BrunoMcpError(
      "INVALID_MUTATION_TARGET",
      `Request "${input.request}" in collection "${input.collection}" is not a valid HTTP request.`,
    );
  }

  return value;
}

function setDocumentValue(
  document: ReturnType<typeof parseYamlDocument>,
  path: readonly string[],
  value: unknown,
): void {
  const current = document.getIn(path, true);
  const replacement = document.createNode(value);

  if (isScalar(current) && isScalar(replacement)) {
    if (current.type !== undefined) replacement.type = current.type;
    if (
      typeof current.value === "number" &&
      typeof replacement.value === "number"
    ) {
      if (current.format !== undefined) replacement.format = current.format;
      if (current.minFractionDigits !== undefined) {
        replacement.minFractionDigits = current.minFractionDigits;
      }
    }
  }

  if (isNode(current) && isNode(replacement)) {
    if (current.comment !== undefined) replacement.comment = current.comment;
    if (current.commentBefore !== undefined) {
      replacement.commentBefore = current.commentBefore;
    }
    if (current.spaceBefore !== undefined) {
      replacement.spaceBefore = current.spaceBefore;
    }
    if (isCollection(current) && isCollection(replacement)) {
      if (current.flow !== undefined) replacement.flow = current.flow;
    }
    if (
      (isScalar(current) || isCollection(current)) &&
      (isScalar(replacement) || isCollection(replacement)) &&
      current.anchor !== undefined
    ) {
      replacement.anchor = current.anchor;
    }
  }

  document.setIn(path, replacement);
}

function stringifyUpdatedDocument(
  document: ReturnType<typeof parseYamlDocument>,
  originalSource: string,
): string {
  let source: string;
  try {
    source = document.toString({ lineWidth: 0, minContentWidth: 0 });
  } catch (error) {
    throw new BrunoMcpError(
      "INVALID_MUTATION_TARGET",
      "The request patch would leave invalid YAML references.",
      { cause: error instanceof Error ? error : new Error(String(error)) },
    );
  }

  if (originalSource.startsWith("\uFEFF")) {
    source = `\uFEFF${source}`;
  }
  const firstLineFeed = originalSource.indexOf("\n");
  const usesCrLf =
    firstLineFeed > 0 && originalSource[firstLineFeed - 1] === "\r";
  if (usesCrLf) {
    source = source.replaceAll("\n", "\r\n");
  }

  if (!originalSource.endsWith("\n")) {
    source = source.replace(/\r?\n$/, "");
  }
  return source;
}

function atomicReplaceRequest(
  config: Config,
  input: UpdateRequestInput,
  collectionRoot: string,
  target: string,
  source: string,
  guardRevision: string,
): void {
  const temporaryPath = join(dirname(target), `.bruno-mcp-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  let stagedIdentity: FileIdentity | undefined;
  let temporaryExists = false;

  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    temporaryExists = true;
    const openedTarget = resolveOpenedFile(descriptor, temporaryPath);
    relativeToRoot(collectionRoot, openedTarget);
    const openedStats = fstatSync(descriptor, { bigint: true });
    const stagedPathStats = lstatSync(temporaryPath, { bigint: true });
    if (
      openedTarget !== temporaryPath ||
      !stagedPathStats.isFile() ||
      !sameFile(fileIdentity(openedStats), fileIdentity(stagedPathStats))
    ) {
      throw revisionConflict(input.request, input.collection);
    }
    stagedIdentity = fileIdentity(openedStats);
    writeFileSync(descriptor, source, { encoding: "utf8" });

    const verified = resolveMutationTarget(config, input);
    if (verified.target !== target) {
      throw revisionConflict(input.request, input.collection);
    }

    const current = readVerifiedRequest(collectionRoot, target, input);
    if (requestRevision(current.source) !== guardRevision) {
      throw revisionConflict(input.request, input.collection);
    }

    fchmodSync(descriptor, current.mode & 0o7777);
    fsyncSync(descriptor);

    const stagedStats = lstatSync(temporaryPath, { bigint: true });
    if (
      !stagedStats.isFile() ||
      !sameFile(stagedIdentity, fileIdentity(stagedStats)) ||
      realpathSync(temporaryPath) !== temporaryPath
    ) {
      throw revisionConflict(input.request, input.collection);
    }
    const finalSource = readVerifiedRequest(collectionRoot, target, input).source;
    if (requestRevision(finalSource) !== guardRevision) {
      throw revisionConflict(input.request, input.collection);
    }
    renameSync(temporaryPath, target);
    temporaryExists = false;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (temporaryExists) {
      try {
        const currentIdentity = fileIdentity(
          lstatSync(temporaryPath, { bigint: true }),
        );
        if (
          stagedIdentity !== undefined &&
          sameFile(stagedIdentity, currentIdentity)
        ) {
          unlinkSync(temporaryPath);
        }
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) {
          logger.warn("Failed to remove staged request update", {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
}

function readVerifiedRequest(
  collectionRoot: string,
  target: string,
  input: Pick<UpdateRequestInput, "collection" | "request">,
): { source: string; mode: number } {
  let descriptor: number;
  try {
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasErrorCode(error, "ELOOP")) {
      throw new BrunoMcpError(
        "INVALID_REQUEST_PATH",
        `Request path "${input.request}" must not contain symbolic links.`,
      );
    }
    throw error;
  }

  try {
    const openedTarget = resolveOpenedFile(descriptor, target);
    relativeToRoot(collectionRoot, openedTarget);
    if (openedTarget !== target) {
      throw revisionConflict(input.request, input.collection);
    }

    const stats = fstatSync(descriptor, { bigint: true });
    const pathStats = lstatSync(target, { bigint: true });
    if (
      !stats.isFile() ||
      !pathStats.isFile() ||
      !sameFile(fileIdentity(stats), fileIdentity(pathStats))
    ) {
      throw revisionConflict(input.request, input.collection);
    }
    return {
      source: readFileSync(descriptor, { encoding: "utf8" }),
      mode: Number(stats.mode),
    };
  } finally {
    closeSync(descriptor);
  }
}

const STALE_LOCK_MS = 5 * 60 * 1_000;
const MAX_LOCK_AGE_MS = 24 * 60 * 60 * 1_000;

interface RequestLock {
  descriptor: number;
  path: string;
  identity: FileIdentity;
}

function acquireRequestLock(
  collectionRoot: string,
  requestPath: string,
  input: Pick<UpdateRequestInput, "collection" | "request">,
): RequestLock {
  const lockPath = join(
    collectionRoot,
    `.bruno-mcp-update-${requestRevision(requestPath)}.lock`,
  );

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor: number;
    let ownedIdentity: FileIdentity | undefined;
    try {
      descriptor = openSync(
        lockPath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (
        hasErrorCode(error, "EEXIST") &&
        attempt === 0 &&
        removeStaleLock(lockPath)
      ) {
        continue;
      }
      if (hasErrorCode(error, "EEXIST") || hasErrorCode(error, "ELOOP")) {
        throw mutationConflict(input.request, input.collection);
      }
      throw error;
    }

    try {
      const openedTarget = resolveOpenedFile(descriptor, lockPath);
      relativeToRoot(collectionRoot, openedTarget);
      const descriptorStats = fstatSync(descriptor, { bigint: true });
      const pathStats = lstatSync(lockPath, { bigint: true });
      const identity = fileIdentity(descriptorStats);
      ownedIdentity = identity;
      if (
        openedTarget !== lockPath ||
        !descriptorStats.isFile() ||
        !pathStats.isFile() ||
        !sameFile(identity, fileIdentity(pathStats))
      ) {
        throw mutationConflict(input.request, input.collection);
      }

      writeFileSync(descriptor, JSON.stringify({ pid: process.pid }), {
        encoding: "utf8",
      });
      fsyncSync(descriptor);
      return { descriptor, path: lockPath, identity };
    } catch (error) {
      closeSync(descriptor);
      removeOwnedPath(lockPath, ownedIdentity);
      throw error;
    }
  }

  throw mutationConflict(input.request, input.collection);
}

function releaseRequestLock(lock: RequestLock): void {
  removeOwnedPath(lock.path, lock.identity);
  try {
    closeSync(lock.descriptor);
  } catch (error) {
    logCleanupFailure("Failed to close request update lock", error);
  }
}

function removeStaleLock(lockPath: string): boolean {
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return true;
    return false;
  }

  try {
    const descriptorStats = fstatSync(descriptor, { bigint: true });
    const identity = fileIdentity(descriptorStats);
    const source = readFileSync(descriptor, { encoding: "utf8" });
    const pid = lockOwnerPid(source);
    const age = Date.now() - Number(descriptorStats.mtimeMs);
    const stale =
      age > MAX_LOCK_AGE_MS ||
      (age > STALE_LOCK_MS && (pid === undefined || !isProcessAlive(pid)));
    const pathIdentity = fileIdentityIfPresent(lockPath);
    if (
      !stale ||
      pathIdentity === undefined ||
      !sameFile(identity, pathIdentity)
    ) {
      return false;
    }

    return reclaimStaleLock(lockPath, identity);
  } catch {
    return false;
  } finally {
    closeSync(descriptor);
  }
}

function reclaimStaleLock(
  lockPath: string,
  staleIdentity: FileIdentity,
): boolean {
  const generation = Math.floor(Date.now() / STALE_LOCK_MS);
  const claimPath = `${lockPath}.reclaim-${staleIdentity.device}-${staleIdentity.inode}-${generation}`;
  let descriptor: number;
  try {
    descriptor = openSync(
      claimPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    return false;
  }

  let claimIdentity: FileIdentity | undefined;
  try {
    claimIdentity = fileIdentity(fstatSync(descriptor, { bigint: true }));
    const pathIdentity = fileIdentityIfPresent(claimPath);
    const lockIdentity = fileIdentityIfPresent(lockPath);
    if (
      pathIdentity === undefined ||
      lockIdentity === undefined ||
      !sameFile(claimIdentity, pathIdentity) ||
      !sameFile(staleIdentity, lockIdentity)
    ) {
      return false;
    }

    unlinkSync(lockPath);
    return true;
  } finally {
    removeOwnedPath(claimPath, claimIdentity);
    closeSync(descriptor);
  }
}

function removeOwnedPath(
  path: string,
  expectedIdentity: FileIdentity | undefined,
): void {
  if (expectedIdentity === undefined) return;
  try {
    const currentIdentity = fileIdentityIfPresent(path);
    if (
      currentIdentity !== undefined &&
      sameFile(expectedIdentity, currentIdentity)
    ) {
      unlinkSync(path);
    }
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      logCleanupFailure("Failed to remove request update lock", error);
    }
  }
}

function fileIdentityIfPresent(path: string): FileIdentity | undefined {
  try {
    return fileIdentity(lstatSync(path, { bigint: true }));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function lockOwnerPid(source: string): number | undefined {
  try {
    const value: unknown = JSON.parse(source);
    if (
      isRecord(value) &&
      typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0
    ) {
      return value.pid;
    }
  } catch {
    // A newly created or interrupted lock is stale only after the timeout.
  }
  return undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, "ESRCH");
  }
}

function logCleanupFailure(message: string, error: unknown): void {
  logger.warn(message, {
    message: error instanceof Error ? error.message : String(error),
  });
}

interface FileIdentity {
  device: bigint;
  inode: bigint;
}

function fileIdentity(stats: { dev: bigint; ino: bigint }): FileIdentity {
  return { device: stats.dev, inode: stats.ino };
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function resolveOpenedFile(fileDescriptor: number, target: string): string {
  if (process.platform === "linux") {
    return realpathSync(`/proc/self/fd/${fileDescriptor}`);
  }
  return realpathSync(target);
}

function revisionConflict(request: string, collection: string): BrunoMcpError {
  return new BrunoMcpError(
    "REVISION_CONFLICT",
    `Request "${request}" in collection "${collection}" has changed since it was read.`,
  );
}

function mutationConflict(request: string, collection: string): BrunoMcpError {
  return new BrunoMcpError(
    "MUTATION_CONFLICT",
    `Request "${request}" in collection "${collection}" is already being updated.`,
  );
}

function hasValueAtPath(
  value: Record<string, unknown>,
  path: readonly string[],
): boolean {
  let current: unknown = value;
  for (const segment of path) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return false;
    current = current[segment];
  }
  return true;
}

function valueAtPath(
  value: Record<string, unknown>,
  path: readonly string[],
): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
