import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { BrunoMcpError } from "../bruno/errors.js";
import type { Config } from "../config/config.js";
import { resolveCollection } from "../opencollection/collection.js";
import { stringifyYaml } from "../opencollection/parser.js";
import {
  ENVIRONMENTS_DIR,
  OPENCOLLECTION_FILE,
  isCollectionMetadataFile,
  isYamlFile,
} from "../opencollection/paths.js";
import { extractRequestMetadata } from "../opencollection/request.js";
import type { RequestMetadata } from "../opencollection/types.js";
import {
  relativeToRoot,
  resolveWithinCollection,
} from "../security/paths.js";
import { jsonResult, runTool } from "./result.js";

/** MCP tool name. */
export const CREATE_REQUEST_TOOL_NAME = "bruno_create_request";

const nonBlankString = z.string().refine((value) => value.trim().length > 0, {
  message: "Must not be blank",
});
const descriptionSchema = z
  .union([
    z.string(),
    z.record(z.string(), z.unknown()),
  ])
  .nullable();

const headerSchema = z.strictObject({
  name: z.string(),
  value: z.string(),
  description: descriptionSchema.optional(),
  disabled: z.boolean().optional(),
});

const parameterSchema = z.strictObject({
  name: z.string(),
  value: z.string(),
  type: z.enum(["query", "path"]),
  description: descriptionSchema.optional(),
  disabled: z.boolean().optional(),
});

const requestBodySchema = z
  .union([
    z.record(z.string(), z.unknown()),
    z.array(z.record(z.string(), z.unknown())),
  ])
  .describe("Request body: { type, data } object or list of variants.");

const authSchema = z
  .union([
    z.literal("inherit"),
    z.record(z.string(), z.unknown()),
  ])
  .describe(
    "Authentication config object (e.g. { type: 'bearer', token: '...' }) or 'inherit'. Use Bruno variables for secrets.",
  );

const assertionSchema = z.strictObject({
  expression: z
    .string()
    .describe("Target expression to evaluate (e.g. res.status, res.body.id)."),
  operator: z
    .string()
    .describe("Comparison operator (e.g. eq, neq, contains)."),
  value: z.string().optional().describe("Expected value to compare against."),
  disabled: z.boolean().optional(),
  description: descriptionSchema.optional(),
});

const scriptSchema = z.strictObject({
  type: z
    .enum(["before-request", "after-response", "tests", "hooks"])
    .describe("Script execution phase."),
  code: z.string().describe("JavaScript code to execute."),
});

const runtimeVariableSchema = z.strictObject({
  name: z.string().describe("Variable name."),
  value: z.unknown().optional().describe("Variable value."),
  disabled: z.boolean().optional(),
  description: descriptionSchema.optional(),
});

const runtimeSchema = z.strictObject({
  variables: z
    .array(runtimeVariableSchema)
    .optional()
    .describe("Runtime variables array."),
  scripts: z
    .array(scriptSchema)
    .optional()
    .describe("Scripts (before-request, after-response, tests, hooks)."),
  assertions: z
    .array(assertionSchema)
    .optional()
    .describe("Response assertions."),
  actions: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe("Post-response actions."),
});

const inheritedBooleanSchema = z.union([z.boolean(), z.literal("inherit")]);
const settingsSchema = z.strictObject({
  encodeUrl: inheritedBooleanSchema.optional(),
  timeout: z.union([z.number().nonnegative(), z.literal("inherit")]).optional(),
  followRedirects: inheritedBooleanSchema.optional(),
  forwardAuthorizationHeader: inheritedBooleanSchema.optional(),
  maxRedirects: z
    .union([z.number().int().nonnegative(), z.literal("inherit")])
    .optional(),
});

const exampleSchema = z
  .record(z.string(), z.unknown())
  .describe("Example request and response definition.");

const appSchema = z.strictObject({
  enabled: z.boolean().optional(),
  code: z.string().optional(),
});

/** Structured HTTP request fields shared by create and update tools. */
export const REQUEST_FIELD_SCHEMAS = {
  name: nonBlankString.describe("Request display name."),
  method: nonBlankString.describe("HTTP method, for example GET or POST."),
  url: nonBlankString.describe(
    "Request URL, optionally with Bruno {{variables}}.",
  ),
  sequence: z.number().int().positive().describe("Execution sequence order."),
  tags: z.array(nonBlankString).describe("Request tags."),
  description: descriptionSchema.describe("Request description."),
  headers: z.array(headerSchema).describe("Request headers."),
  params: z.array(parameterSchema).describe("Query and path parameters."),
  body: requestBodySchema,
  auth: authSchema,
  runtime: runtimeSchema,
  settings: settingsSchema,
  examples: z.array(exampleSchema).describe("Request and response examples."),
  docs: z.string().describe("Documentation text."),
  app: appSchema.describe("App extension settings."),
} as const;

/** Input schema for the `bruno_create_request` tool. */
const inputSchema = z.strictObject({
  collection: z
    .string()
    .describe(
      "Collection path relative to workspace root (as returned by bruno_list_collections).",
    ),
  request: z
    .string()
    .describe(
      "New request path relative to collection root, including .yml extension (e.g. Users/Create.yml).",
    ),
  name: REQUEST_FIELD_SCHEMAS.name,
  method: REQUEST_FIELD_SCHEMAS.method,
  url: REQUEST_FIELD_SCHEMAS.url,
  sequence: REQUEST_FIELD_SCHEMAS.sequence.optional(),
  tags: REQUEST_FIELD_SCHEMAS.tags.optional(),
  description: REQUEST_FIELD_SCHEMAS.description.optional(),
  headers: REQUEST_FIELD_SCHEMAS.headers.optional(),
  params: REQUEST_FIELD_SCHEMAS.params.optional(),
  body: REQUEST_FIELD_SCHEMAS.body.optional(),
  auth: REQUEST_FIELD_SCHEMAS.auth.optional(),
  runtime: REQUEST_FIELD_SCHEMAS.runtime.optional(),
  settings: REQUEST_FIELD_SCHEMAS.settings.optional(),
  examples: REQUEST_FIELD_SCHEMAS.examples.optional(),
  docs: REQUEST_FIELD_SCHEMAS.docs.optional(),
  app: REQUEST_FIELD_SCHEMAS.app.optional(),
});

/** Validated input for {@link createRequest}. */
export type CreateRequestInput = z.infer<typeof inputSchema>;

/** Output payload of the `bruno_create_request` tool. */
export interface CreateRequestOutput {
  collection: string;
  path: string;
  metadata: RequestMetadata;
}

/** Create a new Bruno v4 OpenCollection HTTP request without overwriting files. */
export function createRequest(
  config: Config,
  input: CreateRequestInput,
): CreateRequestOutput {
  const collectionRoot = resolveCollection(config.root, input.collection);
  assertValidRequestPath(input.request);
  const lexicalTarget = resolve(collectionRoot, input.request);
  assertNoSymlinks(collectionRoot, input.request);
  const target = resolveWithinCollection(
    config.root,
    collectionRoot,
    input.request,
  );
  if (target !== lexicalTarget) {
    throw invalidSymlinkPath(input.request);
  }
  assertOutsideNestedCollection(collectionRoot, target, input.request);

  const document = buildRequestDocument(input);
  const source = stringifyYaml(document);
  createParentDirectories(collectionRoot, input.request);
  assertNoSymlinks(collectionRoot, input.request);
  const verifiedTarget = resolveWithinCollection(
    config.root,
    collectionRoot,
    input.request,
  );
  if (verifiedTarget !== lexicalTarget) {
    throw invalidSymlinkPath(input.request);
  }
  assertOutsideNestedCollection(collectionRoot, verifiedTarget, input.request);

  let fileDescriptor: number;
  try {
    fileDescriptor = openSync(
      lexicalTarget,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      throw new BrunoMcpError(
        "REQUEST_ALREADY_EXISTS",
        `Request "${input.request}" already exists in collection "${input.collection}".`,
      );
    }
    if (hasErrorCode(error, "ELOOP")) {
      throw invalidSymlinkPath(input.request);
    }
    throw error;
  }

  try {
    const openedTarget = resolveOpenedFile(fileDescriptor, lexicalTarget);
    relativeToRoot(collectionRoot, openedTarget);
    if (openedTarget !== lexicalTarget) {
      throw invalidSymlinkPath(input.request);
    }
    assertNoSymlinks(collectionRoot, input.request);
    assertOutsideNestedCollection(collectionRoot, openedTarget, input.request);
    writeFileSync(fileDescriptor, source, { encoding: "utf8" });
  } finally {
    closeSync(fileDescriptor);
  }

  const metadata = extractRequestMetadata(document);
  if (metadata === undefined) {
    throw new Error("Generated request document has no metadata");
  }

  return {
    collection: input.collection,
    path: relativeToRoot(collectionRoot, lexicalTarget),
    metadata,
  };
}

/** Register the `bruno_create_request` tool. */
export function registerCreateRequest(server: McpServer, config: Config): void {
  server.registerTool(
    CREATE_REQUEST_TOOL_NAME,
    {
      title: "Create Bruno request",
      description:
        "Create a Bruno HTTP request YAML file. Missing parent folders are created and existing files are not overwritten.",
      inputSchema,
    },
    (input) => runTool(() => jsonResult({ ...createRequest(config, input) })),
  );
}

function buildRequestDocument(
  input: CreateRequestInput,
): Record<string, unknown> {
  const info: Record<string, unknown> = {
    name: input.name,
    type: "http",
  };
  if (input.sequence !== undefined) info.seq = input.sequence;
  if (input.tags !== undefined) info.tags = input.tags;
  if (input.description !== undefined) info.description = input.description;

  const http: Record<string, unknown> = {
    method: input.method,
    url: input.url,
  };
  if (input.headers !== undefined) http.headers = input.headers;
  if (input.params !== undefined) http.params = input.params;
  if (input.body !== undefined) http.body = input.body;
  if (input.auth !== undefined) http.auth = input.auth;

  const document: Record<string, unknown> = { info, http };
  if (input.runtime !== undefined) document.runtime = input.runtime;
  if (input.settings !== undefined) document.settings = input.settings;
  if (input.examples !== undefined) document.examples = input.examples;
  if (input.docs !== undefined) document.docs = input.docs;
  if (input.app !== undefined) document.app = input.app;
  return document;
}

export function assertValidRequestPath(requestPath: string): void {
  const segments = requestPath.split("/");
  const invalidSegment = segments.some(
    (segment) => segment === "" || segment === "." || segment === "..",
  );
  const fileName = basename(requestPath);
  const reservedFile = isCollectionMetadataFile(fileName.toLowerCase());
  const environmentPath =
    segments[0]?.toLowerCase() === ENVIRONMENTS_DIR.toLowerCase();

  if (
    requestPath.includes("\0") ||
    requestPath.includes("\\") ||
    isAbsolute(requestPath) ||
    invalidSegment ||
    !isYamlFile(fileName) ||
    reservedFile ||
    environmentPath
  ) {
    throw new BrunoMcpError(
      "INVALID_REQUEST_PATH",
      `Request path "${requestPath}" must be a normalized, collection-relative .yml path outside reserved metadata and environment locations.`,
    );
  }
}

export function assertOutsideNestedCollection(
  collectionRoot: string,
  target: string,
  requestPath: string,
): void {
  let current = dirname(target);
  while (current !== collectionRoot) {
    if (pathExists(join(current, OPENCOLLECTION_FILE))) {
      throw new BrunoMcpError(
        "INVALID_REQUEST_PATH",
        `Request path "${requestPath}" belongs to a nested collection.`,
      );
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function assertNoSymlinks(
  collectionRoot: string,
  requestPath: string,
): void {
  const segments = requestPath.split("/");
  let current = collectionRoot;

  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const stats = lstatIfPresent(current);
    if (stats === undefined) return;
    if (stats.isSymbolicLink()) throw invalidSymlinkPath(requestPath);
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new BrunoMcpError(
        "INVALID_REQUEST_PATH",
        `Request path "${requestPath}" has a parent that is not a directory.`,
      );
    }
  }
}

function createParentDirectories(
  collectionRoot: string,
  requestPath: string,
): void {
  const parentSegments = requestPath.split("/").slice(0, -1);
  let current = collectionRoot;

  for (const segment of parentSegments) {
    current = join(current, segment);
    let stats = lstatIfPresent(current);
    if (stats === undefined) {
      try {
        mkdirSync(current);
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) throw error;
      }
      stats = lstatIfPresent(current);
    }

    if (stats?.isSymbolicLink()) throw invalidSymlinkPath(requestPath);
    if (stats === undefined || !stats.isDirectory()) {
      throw new BrunoMcpError(
        "INVALID_REQUEST_PATH",
        `Request path "${requestPath}" has a parent that is not a directory.`,
      );
    }
  }
}

function resolveOpenedFile(fileDescriptor: number, target: string): string {
  if (process.platform === "linux") {
    return realpathSync(`/proc/self/fd/${fileDescriptor}`);
  }
  return realpathSync(target);
}

function invalidSymlinkPath(requestPath: string): BrunoMcpError {
  return new BrunoMcpError(
    "INVALID_REQUEST_PATH",
    `Request path "${requestPath}" must not contain symbolic links.`,
  );
}

function pathExists(path: string): boolean {
  return lstatIfPresent(path) !== undefined;
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

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
