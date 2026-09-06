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
import { dirname, join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/server";
import { isCollection, isMap } from "yaml";
import { z } from "zod";

import { BrunoMcpError } from "../bruno/errors.js";
import type { Config } from "../config/config.js";
import { parseYamlDocument } from "../opencollection/parser.js";
import {
  type EnvironmentTarget,
  type EnvironmentMutationOutput,
  type StoredEnvironmentVariable,
  assertSupportedEnvironmentVariables,
  environmentVariableSchema,
  resolveEnvironmentTarget,
  toStoredEnvironmentVariables,
} from "./create-environment.js";
import { jsonResult, runTool } from "./result.js";

export const UPDATE_ENVIRONMENT_TOOL_NAME = "bruno_update_environment";

const updateEnvironmentInput = z.strictObject({
  collection: z
    .string()
    .min(1)
    .describe(
      "Collection path relative to workspace root (as returned by bruno_list_collections).",
    ),
  name: z
    .string()
    .min(1)
    .describe(
      "Environment name or path (e.g. Local or environments/Local.yml).",
    ),
  variables: z
    .array(environmentVariableSchema)
    .describe(
      "Replacement list of variables. Existing secrets must keep secret: true.",
    ),
});

export type UpdateEnvironmentInput = z.infer<typeof updateEnvironmentInput>;

interface ReadEnvironmentResult {
  source: string;
  mode: number;
  identity: FileIdentity;
}

export function updateEnvironment(
  config: Config,
  input: UpdateEnvironmentInput,
): EnvironmentMutationOutput {
  assertSupportedEnvironmentVariables(input.variables);
  const target = resolveEnvironmentTarget(
    config,
    input.collection,
    input.name,
  );
  const current = readVerifiedEnvironment(target.filePath, input);
  const document = parseYamlDocument(current.source, { source: target.path });
  if (!isMap(document.contents)) {
    throw new BrunoMcpError(
      "INVALID_MUTATION_TARGET",
      `Environment "${target.name}" in collection "${input.collection}" must be a YAML mapping.`,
    );
  }
  assertExistingSecretsPreserved(document, input.variables);
  const variables = toStoredEnvironmentVariables(input.variables);
  setVariables(document, variables);

  const source = stringifyUpdatedDocument(document, current.source);
  atomicReplaceEnvironment(config, input, target, source, current);

  return {
    collection: target.collection,
    path: target.path,
    name: target.name,
  };
}

export function registerUpdateEnvironment(
  server: McpServer,
  config: Config,
): void {
  server.registerTool(
    UPDATE_ENVIRONMENT_TOOL_NAME,
    {
      title: "Update Bruno environment",
      description:
        "Update an existing Bruno environment file. Existing secrets must be preserved with secret: true.",
      inputSchema: updateEnvironmentInput,
    },
    (input) => runTool(() => jsonResult({ ...updateEnvironment(config, input) })),
  );
}

function assertExistingSecretsPreserved(
  document: ReturnType<typeof parseYamlDocument>,
  variables: UpdateEnvironmentInput["variables"],
): void {
  const currentDocument = document.toJS() as { variables?: unknown };
  if (!Array.isArray(currentDocument.variables)) return;

  const existingCounts = new Map<string, number>();
  for (const variable of currentDocument.variables) {
    if (
      typeof variable === "object" &&
      variable !== null &&
      variable.secret === true &&
      typeof variable.name === "string"
    ) {
      existingCounts.set(
        variable.name,
        (existingCounts.get(variable.name) ?? 0) + 1,
      );
    }
  }

  const replacementCounts = new Map<string, number>();
  const regularNames = new Set<string>();
  for (const variable of variables) {
    if (variable.secret === true) {
      replacementCounts.set(
        variable.name,
        (replacementCounts.get(variable.name) ?? 0) + 1,
      );
    } else {
      regularNames.add(variable.name);
    }
  }

  // Bruno associates stored secret values with their exact variable names.
  for (const [name, count] of existingCounts) {
    if ((replacementCounts.get(name) ?? 0) < count || regularNames.has(name)) {
      throw new BrunoMcpError(
        "INVALID_MUTATION_TARGET",
        `Existing secret ${JSON.stringify(name)} must keep its exact name and secret: true. Rename or remove secrets in Bruno's application so its secret store stays synchronized.`,
      );
    }
  }
}

function setVariables(
  document: ReturnType<typeof parseYamlDocument>,
  variables: StoredEnvironmentVariable[],
): void {
  const current = document.get("variables", true);
  const replacement = document.createNode(variables);
  if (isCollection(current) && isCollection(replacement)) {
    if (current.anchor !== undefined) replacement.anchor = current.anchor;
    if (current.flow !== undefined) replacement.flow = current.flow;
    if (current.comment !== undefined) replacement.comment = current.comment;
    if (current.commentBefore !== undefined) {
      replacement.commentBefore = current.commentBefore;
    }
    if (current.spaceBefore !== undefined) {
      replacement.spaceBefore = current.spaceBefore;
    }
  }
  document.setIn(["variables"], replacement);
}

function readVerifiedEnvironment(
  filePath: string,
  input: Pick<UpdateEnvironmentInput, "collection" | "name">,
): ReadEnvironmentResult {
  let descriptor: number;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
      throw environmentNotFound(input);
    }
    if (hasErrorCode(error, "ELOOP")) {
      throw invalidEnvironmentTarget(input);
    }
    throw error;
  }

  try {
    const descriptorStats = fstatSync(descriptor, { bigint: true });
    const pathStats = lstatSync(filePath, { bigint: true });
    if (
      realpathSync(filePath) !== filePath ||
      !descriptorStats.isFile() ||
      !pathStats.isFile() ||
      !sameFile(descriptorStats, pathStats)
    ) {
      throw invalidEnvironmentTarget(input);
    }

    return {
      source: readFileSync(descriptor, { encoding: "utf8" }),
      mode: Number(descriptorStats.mode),
      identity: fileIdentity(descriptorStats),
    };
  } finally {
    closeSync(descriptor);
  }
}

function atomicReplaceEnvironment(
  config: Config,
  input: UpdateEnvironmentInput,
  target: EnvironmentTarget,
  source: string,
  original: ReadEnvironmentResult,
): void {
  const temporaryPath = join(
    dirname(target.filePath),
    `.bruno-mcp-${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  let temporaryIdentity: FileIdentity | undefined;

  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    const descriptorStats = fstatSync(descriptor, { bigint: true });
    temporaryIdentity = fileIdentity(descriptorStats);
    const pathStats = lstatSync(temporaryPath, { bigint: true });
    if (
      resolveOpenedFile(descriptor, temporaryPath) !== temporaryPath ||
      !descriptorStats.isFile() ||
      !pathStats.isFile() ||
      !sameFile(descriptorStats, pathStats)
    ) {
      throw mutationConflict(input);
    }

    writeFileSync(descriptor, source, { encoding: "utf8" });

    const verifiedTarget = resolveEnvironmentTarget(
      config,
      input.collection,
      input.name,
    );
    const current = readVerifiedEnvironment(verifiedTarget.filePath, input);
    const temporaryStats = lstatSync(temporaryPath, { bigint: true });
    if (
      verifiedTarget.filePath !== target.filePath ||
      current.source !== original.source ||
      !sameIdentity(current.identity, original.identity) ||
      temporaryIdentity === undefined ||
      realpathSync(temporaryPath) !== temporaryPath ||
      !temporaryStats.isFile() ||
      !sameIdentity(fileIdentity(temporaryStats), temporaryIdentity)
    ) {
      throw mutationConflict(input);
    }

    fchmodSync(descriptor, current.mode & 0o7777);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    renameSync(temporaryPath, target.filePath);
    temporaryIdentity = undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    removeOwnedPath(temporaryPath, temporaryIdentity);
  }
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
      "The environment update would leave invalid YAML references.",
      { cause: error instanceof Error ? error : new Error(String(error)) },
    );
  }
  if (originalSource.startsWith("\uFEFF")) source = `\uFEFF${source}`;

  const firstLineFeed = originalSource.indexOf("\n");
  if (firstLineFeed > 0 && originalSource[firstLineFeed - 1] === "\r") {
    source = source.replaceAll("\n", "\r\n");
  }
  if (!originalSource.endsWith("\n")) {
    source = source.replace(/\r?\n$/, "");
  }
  return source;
}

function environmentNotFound(
  input: Pick<UpdateEnvironmentInput, "collection" | "name">,
): BrunoMcpError {
  return new BrunoMcpError(
    "ENVIRONMENT_NOT_FOUND",
    `Environment "${input.name}" does not exist in collection "${input.collection}".`,
  );
}

function invalidEnvironmentTarget(
  input: Pick<UpdateEnvironmentInput, "name">,
): BrunoMcpError {
  return new BrunoMcpError(
    "INVALID_ENVIRONMENT_NAME",
    `Environment ${JSON.stringify(input.name)} must identify a direct, regular environment file.`,
  );
}

function mutationConflict(input: UpdateEnvironmentInput): BrunoMcpError {
  return new BrunoMcpError(
    "MUTATION_CONFLICT",
    `Environment "${input.name}" in collection "${input.collection}" changed while it was being updated.`,
  );
}

interface FileIdentity {
  device: bigint;
  inode: bigint;
}

function fileIdentity(stats: { dev: bigint; ino: bigint }): FileIdentity {
  return { device: stats.dev, inode: stats.ino };
}

function sameIdentity(
  left: FileIdentity,
  right: FileIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function removeOwnedPath(
  path: string,
  expectedIdentity: FileIdentity | undefined,
): void {
  if (expectedIdentity === undefined) return;
  try {
    const identity = fileIdentity(lstatSync(path, { bigint: true }));
    if (sameIdentity(identity, expectedIdentity)) unlinkSync(path);
  } catch {
    // Preserve the original update error if cleanup fails.
  }
}

function resolveOpenedFile(descriptor: number, target: string): string {
  if (process.platform === "linux") {
    return realpathSync(`/proc/self/fd/${descriptor}`);
  }
  return realpathSync(target);
}

function sameFile(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
