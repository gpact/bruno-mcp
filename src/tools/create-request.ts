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
    z.strictObject({ content: z.string(), type: nonBlankString }),
  ])
  .nullable();
const describedValueSchema = {
  description: descriptionSchema.optional(),
  disabled: z.boolean().optional(),
};

const headerSchema = z.strictObject({
  name: z.string(),
  value: z.string(),
  ...describedValueSchema,
});
const responseHeaderSchema = z.strictObject({
  name: z.string(),
  value: z.string(),
});
const parameterSchema = z.strictObject({
  name: z.string(),
  value: z.string(),
  type: z.enum(["query", "path"]),
  ...describedValueSchema,
});
const formEntrySchema = z.strictObject({
  name: z.string(),
  value: z.string(),
  ...describedValueSchema,
});
const multipartTextEntrySchema = z.strictObject({
  name: z.string(),
  type: z.literal("text"),
  value: z.string(),
  contentType: z.string().optional(),
  ...describedValueSchema,
});
const multipartFileEntrySchema = z.strictObject({
  name: z.string(),
  type: z.literal("file"),
  value: z.array(z.string()),
  contentType: z.string().optional(),
  ...describedValueSchema,
});
const bodySchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.enum(["json", "text", "xml", "sparql"]),
    data: z.string(),
  }),
  z.strictObject({
    type: z.literal("form-urlencoded"),
    data: z.array(formEntrySchema),
  }),
  z.strictObject({
    type: z.literal("multipart-form"),
    data: z.array(
      z.discriminatedUnion("type", [
        multipartTextEntrySchema,
        multipartFileEntrySchema,
      ]),
    ),
  }),
  z.strictObject({
    type: z.literal("file"),
    data: z.array(
      z.strictObject({
        filePath: z.string(),
        contentType: z.string(),
        selected: z.boolean(),
        description: descriptionSchema.optional(),
      }),
    ),
  }),
]);
const requestBodySchema = z.union([
  bodySchema,
  z
    .array(
      z.strictObject({
        title: z.string(),
        selected: z.boolean().optional(),
        body: bodySchema,
      }),
    )
    .min(1),
]);
const oauth2CredentialsSchema = z.strictObject({
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  placement: z.enum(["basic_auth_header", "body"]).optional(),
});
const oauth2AdditionalParameterSchema = z.strictObject({
  name: z.string().optional(),
  value: z.string().optional(),
  placement: z.enum(["header", "query", "body"]).optional(),
});
const oauth2TokenConfigSchema = z.strictObject({
  id: z.string().optional(),
  placement: z
    .union([
      z.strictObject({ header: z.string() }),
      z.strictObject({ query: z.string() }),
    ])
    .optional(),
  source: z.enum(["access_token", "id_token"]).optional(),
});
const oauth2SettingsSchema = z.strictObject({
  autoFetchToken: z.boolean().optional(),
  autoRefreshToken: z.boolean().optional(),
});
const oauth2TokenParametersSchema = z.strictObject({
  accessTokenRequest: z.array(oauth2AdditionalParameterSchema).optional(),
  refreshTokenRequest: z.array(oauth2AdditionalParameterSchema).optional(),
});
const oauth2CommonShape = {
  type: z.literal("oauth2"),
  accessTokenUrl: z.string().optional(),
  refreshTokenUrl: z.string().optional(),
  credentials: oauth2CredentialsSchema.optional(),
  scope: z.string().optional(),
  tokenConfig: oauth2TokenConfigSchema.optional(),
  settings: oauth2SettingsSchema.optional(),
};
const oauth2Schema = z.discriminatedUnion("flow", [
  z.strictObject({
    ...oauth2CommonShape,
    flow: z.literal("client_credentials"),
    additionalParameters: oauth2TokenParametersSchema.optional(),
  }),
  z.strictObject({
    ...oauth2CommonShape,
    flow: z.literal("resource_owner_password_credentials"),
    resourceOwner: z
      .strictObject({
        username: z.string().optional(),
        password: z.string().optional(),
      })
      .optional(),
    additionalParameters: oauth2TokenParametersSchema.optional(),
  }),
  z.strictObject({
    ...oauth2CommonShape,
    flow: z.literal("authorization_code"),
    authorizationUrl: z.string().optional(),
    callbackUrl: z.string().optional(),
    state: z.string().optional(),
    pkce: z
      .strictObject({
        disabled: z.boolean().optional(),
        method: z.enum(["S256", "plain"]).optional(),
      })
      .optional(),
    additionalParameters: z
      .strictObject({
        authorizationRequest: z
          .array(oauth2AdditionalParameterSchema)
          .optional(),
        accessTokenRequest: z
          .array(oauth2AdditionalParameterSchema)
          .optional(),
        refreshTokenRequest: z
          .array(oauth2AdditionalParameterSchema)
          .optional(),
      })
      .optional(),
  }),
  z.strictObject({
    type: z.literal("oauth2"),
    flow: z.literal("implicit"),
    authorizationUrl: z.string().optional(),
    callbackUrl: z.string().optional(),
    credentials: z
      .strictObject({ clientId: z.string().optional() })
      .optional(),
    scope: z.string().optional(),
    state: z.string().optional(),
    additionalParameters: z
      .strictObject({
        authorizationRequest: z
          .array(oauth2AdditionalParameterSchema)
          .optional(),
      })
      .optional(),
    tokenConfig: oauth2TokenConfigSchema.optional(),
    settings: oauth2SettingsSchema.optional(),
  }),
]);

const authSchema = z
  .union([
    z.literal("inherit"),
    z.strictObject({
      type: z.literal("awsv4"),
      accessKeyId: z.string().optional(),
      secretAccessKey: z.string().optional(),
      sessionToken: z.string().optional(),
      service: z.string().optional(),
      region: z.string().optional(),
      profileName: z.string().optional(),
    }),
    z.strictObject({
      type: z.literal("basic"),
      username: z.string().optional(),
      password: z.string().optional(),
    }),
    z.strictObject({
      type: z.literal("bearer"),
      token: z.string().optional(),
    }),
    z.strictObject({
      type: z.literal("digest"),
      username: z.string().optional(),
      password: z.string().optional(),
    }),
    z.strictObject({
      type: z.literal("ntlm"),
      username: z.string().optional(),
      password: z.string().optional(),
      domain: z.string().optional(),
    }),
    z.strictObject({
      type: z.literal("wsse"),
      username: z.string().optional(),
      password: z.string().optional(),
    }),
    z.strictObject({
      type: z.literal("apikey"),
      key: z.string().optional(),
      value: z.string().optional(),
      placement: z.enum(["header", "query"]).optional(),
    }),
    z.strictObject({
      type: z.literal("oauth1"),
      consumerKey: z.string().optional(),
      consumerSecret: z.string().optional(),
      accessToken: z.string().optional(),
      accessTokenSecret: z.string().optional(),
      callbackUrl: z.string().optional(),
      verifier: z.string().optional(),
      signatureMethod: z
        .enum([
          "HMAC-SHA1",
          "HMAC-SHA256",
          "HMAC-SHA512",
          "RSA-SHA1",
          "RSA-SHA256",
          "RSA-SHA512",
          "PLAINTEXT",
        ])
        .optional(),
      privateKey: z
        .strictObject({
          type: z.enum(["file", "text"]),
          value: z.string(),
        })
        .optional(),
      timestamp: z.string().optional(),
      nonce: z.string().optional(),
      version: z.string().optional(),
      realm: z.string().optional(),
      placement: z.enum(["header", "query", "body"]).optional(),
      includeBodyHash: z.boolean().optional(),
    }),
    oauth2Schema,
    z.strictObject({
      type: z.literal("akamai-edgegrid"),
      accessToken: z.string().optional(),
      clientToken: z.string().optional(),
      clientSecret: z.string().optional(),
      baseURL: z.string().optional(),
      nonce: z.string().optional(),
      timestamp: z.string().optional(),
      headersToSign: z.string().optional(),
      maxBodySize: z.number().nonnegative().optional(),
    }),
  ])
  .describe(
    "OpenCollection authentication. Do not pass credentials or other secrets directly through MCP arguments; prefer Bruno variables and environments.",
  );

const variableTypedValueSchema = z.strictObject({
  type: z.enum(["string", "number", "boolean", "null", "object"]),
  data: z.string(),
});
const variableValueSchema = z.union([
  z.string(),
  variableTypedValueSchema,
  z.array(
    z.strictObject({
      title: z.string(),
      selected: z.boolean().optional(),
      value: z.union([z.string(), variableTypedValueSchema]),
    }),
  ),
]);
const runtimeSchema = z.strictObject({
  variables: z
    .array(
      z.strictObject({
        name: z.string(),
        value: variableValueSchema.optional(),
        ...describedValueSchema,
      }),
    )
    .optional(),
  scripts: z
    .array(
      z.strictObject({
        type: z.enum(["before-request", "after-response", "tests", "hooks"]),
        code: z.string(),
      }),
    )
    .optional(),
  assertions: z
    .array(
      z.strictObject({
        expression: z.string(),
        operator: z.string(),
        value: z.string().optional(),
        ...describedValueSchema,
      }),
    )
    .optional(),
  actions: z
    .array(
      z.strictObject({
        type: z.literal("set-variable"),
        phase: z.enum(["before-request", "after-response"]).optional(),
        selector: z.strictObject({
          expression: z.string(),
          method: z.literal("jsonq"),
        }),
        variable: z.strictObject({
          name: z.string(),
          scope: z.enum([
            "runtime",
            "request",
            "folder",
            "collection",
            "environment",
          ]),
        }),
        ...describedValueSchema,
      }),
    )
    .optional(),
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
const exampleSchema = z.strictObject({
  name: z.string().optional(),
  description: descriptionSchema.optional(),
  request: z
    .strictObject({
      url: z.string().optional(),
      method: z.string().optional(),
      headers: z.array(headerSchema).optional(),
      params: z.array(parameterSchema).optional(),
      body: bodySchema.optional(),
    })
    .optional(),
  response: z
    .strictObject({
      status: z.number().int().positive().optional(),
      statusText: z.string().optional(),
      headers: z.array(responseHeaderSchema).optional(),
      body: z
        .strictObject({
          type: z.enum(["json", "text", "xml", "html", "binary"]),
          data: z.string(),
        })
        .optional(),
    })
    .optional(),
});

/** Input schema for the `bruno_create_request` tool. */
const inputSchema = z.strictObject({
  collection: z
    .string()
    .describe(
      "Collection identifier: the collection's path relative to the workspace root (as returned by bruno_list_collections), not its display name.",
    ),
  request: z
    .string()
    .describe(
      "New request path relative to the collection root, including the .yml extension, for example Users/Create User.yml.",
    ),
  name: nonBlankString.describe("Request display name."),
  method: nonBlankString.describe("HTTP method, for example GET or POST."),
  url: nonBlankString.describe(
    "Request URL. Bruno variable references such as {{baseUrl}} are stored verbatim.",
  ),
  sequence: z.number().int().positive().optional(),
  tags: z.array(nonBlankString).optional(),
  description: descriptionSchema.optional(),
  headers: z.array(headerSchema).optional(),
  params: z.array(parameterSchema).optional(),
  body: requestBodySchema.optional(),
  auth: authSchema.optional(),
  runtime: runtimeSchema.optional(),
  settings: settingsSchema.optional(),
  examples: z.array(exampleSchema).optional(),
  docs: z.string().optional(),
  app: z
    .strictObject({
      enabled: z.boolean().optional(),
      code: z.string().optional(),
    })
    .optional(),
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
        "Create a Bruno v4 OpenCollection HTTP request from structured fields. Missing parent folders are created and existing files are never overwritten.",
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

function assertValidRequestPath(requestPath: string): void {
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

function assertOutsideNestedCollection(
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

function assertNoSymlinks(collectionRoot: string, requestPath: string): void {
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
