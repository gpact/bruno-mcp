import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { BrunoMcpError } from "../bruno/errors.js";
import type { Config } from "../config/config.js";
import { resolveCollection } from "../opencollection/collection.js";
import { stringifyYaml } from "../opencollection/parser.js";
import {
  ENVIRONMENTS_DIR,
  YAML_EXTENSION,
} from "../opencollection/paths.js";
import { resolveWithinCollection } from "../security/paths.js";
import { REDACTED } from "../security/redact.js";
import { jsonResult, runTool } from "./result.js";

export const CREATE_ENVIRONMENT_TOOL_NAME = "bruno_create_environment";

const environmentValueTypeSchema = z.enum([
  "string",
  "number",
  "boolean",
  "object",
]);

const environmentTypedValueSchema = z.strictObject({
  type: environmentValueTypeSchema,
  data: z.string(),
});

const environmentVariableValueSchema = z.union(
  [z.string(), environmentTypedValueSchema],
  {
    error: "Use a string or a typed string, number, boolean, or object. Bruno v4 does not support null types or selectable environment variants.",
  },
);

const environmentDescriptionSchema = z.union([
  z.string(),
  z.strictObject({ content: z.string(), type: z.string().min(1) }),
]);

const nonBlankString = z.string().refine((value) => value.trim().length > 0, {
  message: "Must not be blank",
});

const environmentVariableCommonShape = {
  name: nonBlankString.describe("Variable name."),
  description: environmentDescriptionSchema.optional(),
  disabled: z.boolean().optional(),
};

export const environmentVariableSchema = z.union([
  z.strictObject({
    ...environmentVariableCommonShape,
    value: environmentVariableValueSchema
      .optional()
      .describe("Variable value."),
    secret: z
      .literal(false)
      .optional(),
  }),
  z.strictObject({
    ...environmentVariableCommonShape,
    value: z
      .literal(REDACTED, {
        error: "Omit secret values or use [REDACTED]. Bruno v4 does not load plaintext secrets from environment YAML.",
      })
      .optional()
      .describe("Omit or use [REDACTED] for secrets."),
    secret: z.literal(true).describe("Must be true for secret variables."),
    type: environmentValueTypeSchema
      .optional()
      .describe("Type metadata for secret values."),
  }),
]);

const createEnvironmentInput = z.strictObject({
  collection: z
    .string()
    .min(1)
    .describe(
      "Collection path relative to workspace root (as returned by bruno_list_collections).",
    ),
  name: nonBlankString.describe(
    "Environment name or path (e.g. Local or environments/Local.yml).",
  ),
  variables: z
    .array(environmentVariableSchema)
    .optional()
    .describe("Initial list of environment variables."),
});

export type CreateEnvironmentInput = z.infer<typeof createEnvironmentInput>;

type InputEnvironmentVariable = NonNullable<
  CreateEnvironmentInput["variables"]
>[number];

/** Environment YAML contains secret definitions without their values. */
export type StoredEnvironmentVariable =
  | Exclude<InputEnvironmentVariable, { secret: true }>
  | Omit<Extract<InputEnvironmentVariable, { secret: true }>, "value">;

export interface EnvironmentMutationOutput {
  collection: string;
  path: string;
  name: string;
}

export interface EnvironmentTarget extends EnvironmentMutationOutput {
  collectionRoot: string;
  environmentsDir: string;
  filePath: string;
}

export function createEnvironment(
  config: Config,
  input: CreateEnvironmentInput,
): EnvironmentMutationOutput {
  assertSupportedEnvironmentVariables(input.variables ?? []);
  const target = resolveEnvironmentTarget(
    config,
    input.collection,
    input.name,
    true,
  );
  const document = {
    name: target.name,
    variables: toStoredEnvironmentVariables(input.variables ?? []),
  };

  let descriptor: number;
  try {
    descriptor = openSync(
      target.filePath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      throw new BrunoMcpError(
        "ENVIRONMENT_ALREADY_EXISTS",
        `Environment "${target.name}" already exists in collection "${input.collection}".`,
      );
    }
    if (hasErrorCode(error, "ELOOP")) {
      throw invalidEnvironmentName(input.name);
    }
    throw error;
  }

  let createdIdentity: FileIdentity | undefined;
  let completed = false;
  try {
    const openedTarget = resolveOpenedFile(descriptor, target.filePath);
    const descriptorStats = fstatSync(descriptor, { bigint: true });
    createdIdentity = fileIdentity(descriptorStats);
    const pathStats = lstatSync(target.filePath, { bigint: true });
    if (
      openedTarget !== target.filePath ||
      !descriptorStats.isFile() ||
      !pathStats.isFile() ||
      !sameFile(descriptorStats, pathStats)
    ) {
      throw invalidEnvironmentName(input.name);
    }

    writeFileSync(descriptor, stringifyYaml(document), { encoding: "utf8" });
    const verifiedTarget = resolveEnvironmentTarget(
      config,
      input.collection,
      input.name,
    );
    const finalStats = lstatSync(target.filePath, { bigint: true });
    if (
      verifiedTarget.filePath !== target.filePath ||
      !finalStats.isFile() ||
      !sameFile(descriptorStats, finalStats)
    ) {
      throw invalidEnvironmentName(input.name);
    }
    completed = true;
  } finally {
    closeSync(descriptor);
    if (!completed) removeOwnedPath(target.filePath, createdIdentity);
  }

  return {
    collection: target.collection,
    path: target.path,
    name: target.name,
  };
}

export function toStoredEnvironmentVariables(
  variables: InputEnvironmentVariable[],
): StoredEnvironmentVariable[] {
  return variables.map((variable) => {
    if (variable.secret === true) {
      const { value: _value, ...withoutValue } = variable;
      return withoutValue;
    }
    if (variable.secret !== false) return variable;
    const stored = { ...variable };
    delete stored.secret;
    return stored;
  });
}

export function assertSupportedEnvironmentVariables(variables: unknown): void {
  if (!z.array(environmentVariableSchema).safeParse(variables).success) {
    throw new BrunoMcpError(
      "INVALID_MUTATION_TARGET",
      "Environment variables must use strings or typed string, number, boolean, or object values, not null types or selectable variants. Secret values must be omitted or [REDACTED]; Bruno v4 does not load plaintext secrets from environment YAML.",
    );
  }
}

export function registerCreateEnvironment(
  server: McpServer,
  config: Config,
): void {
  server.registerTool(
    CREATE_ENVIRONMENT_TOOL_NAME,
    {
      title: "Create Bruno environment",
      description:
        "Create a new Bruno environment file. Secret values must be omitted or [REDACTED].",
      inputSchema: createEnvironmentInput,
    },
    (input) => runTool(() => jsonResult({ ...createEnvironment(config, input) })),
  );
}

export function resolveEnvironmentTarget(
  config: Config,
  collection: string,
  reference: string,
  createDirectory = false,
): EnvironmentTarget {
  const collectionRoot = resolveCollection(config.root, collection);
  const name = normalizeEnvironmentReference(reference);
  const environmentsDir = join(collectionRoot, ENVIRONMENTS_DIR);
  let directoryStats = lstatIfPresent(environmentsDir);

  if (directoryStats === undefined && createDirectory) {
    try {
      mkdirSync(environmentsDir);
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
    }
    directoryStats = lstatIfPresent(environmentsDir);
  }

  if (
    directoryStats !== undefined &&
    (directoryStats.isSymbolicLink() || !directoryStats.isDirectory())
  ) {
    throw invalidEnvironmentName(reference);
  }

  if (
    directoryStats !== undefined &&
    resolveWithinCollection(config.root, collectionRoot, ENVIRONMENTS_DIR) !==
      environmentsDir
  ) {
    throw invalidEnvironmentName(reference);
  }

  const fileName = `${name}${YAML_EXTENSION}`;
  const relativePath = `${ENVIRONMENTS_DIR}/${fileName}`;
  const filePath = join(environmentsDir, fileName);
  const fileStats = lstatIfPresent(filePath);
  if (fileStats?.isSymbolicLink()) {
    throw invalidEnvironmentName(reference);
  }

  const resolvedPath = resolveWithinCollection(
    config.root,
    collectionRoot,
    relativePath,
  );
  if (resolvedPath !== filePath) {
    throw invalidEnvironmentName(reference);
  }

  return {
    collection,
    collectionRoot,
    environmentsDir,
    filePath,
    path: relativePath,
    name,
  };
}

function normalizeEnvironmentReference(reference: string): string {
  if (hasControlCharacter(reference)) {
    throw invalidEnvironmentName(reference);
  }

  let name = reference.trim();
  const prefix = `${ENVIRONMENTS_DIR}/`;
  if (name.startsWith(prefix)) {
    name = name.slice(prefix.length);
  }
  if (name.toLowerCase().endsWith(YAML_EXTENSION)) {
    name = name.slice(0, -YAML_EXTENSION.length);
  }

  if (
    name.length === 0 ||
    name.includes("/") ||
    name.includes("\\") ||
    name === "." ||
    name === ".."
  ) {
    throw invalidEnvironmentName(reference);
  }

  return name;
}

function invalidEnvironmentName(reference: string): BrunoMcpError {
  return new BrunoMcpError(
    "INVALID_ENVIRONMENT_NAME",
    `Environment ${JSON.stringify(reference)} must identify a direct environment file without control characters, path separators, dot segments, or symbolic links.`,
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
      return undefined;
    }
    throw error;
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

interface FileIdentity {
  device: bigint;
  inode: bigint;
}

function fileIdentity(stats: { dev: bigint; ino: bigint }): FileIdentity {
  return { device: stats.dev, inode: stats.ino };
}

function removeOwnedPath(
  path: string,
  expectedIdentity: FileIdentity | undefined,
): void {
  if (expectedIdentity === undefined) return;
  try {
    const identity = fileIdentity(lstatSync(path, { bigint: true }));
    if (
      identity.device === expectedIdentity.device &&
      identity.inode === expectedIdentity.inode
    ) {
      unlinkSync(path);
    }
  } catch {
    // Preserve the original create error if cleanup fails.
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
