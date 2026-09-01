import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BrunoMcpError } from "../../src/bruno/errors.js";
import { type Config, loadConfig } from "../../src/config/config.js";
import { parseYaml } from "../../src/opencollection/parser.js";
import { getRequest } from "../../src/tools/get-request.js";
import { listRequests } from "../../src/tools/list-requests.js";
import {
  CREATE_REQUEST_TOOL_NAME,
  type CreateRequestInput,
  createRequest,
  registerCreateRequest,
} from "../../src/tools/create-request.js";

let root: string;
let config: Config;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bruno-mcp-create-request-")));
  write(
    "api/opencollection.yml",
    "opencollection: 1.0.0\ninfo:\n  name: API\n",
  );
  config = loadConfig({ BRUNO_MCP_ROOT: root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relativePath: string, content: string): void {
  const absolute = join(root, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function requestInput(
  overrides: Partial<CreateRequestInput> = {},
): CreateRequestInput {
  return {
    collection: "api",
    request: "Users/Create User.yml",
    name: "Create User",
    method: "POST",
    url: "{{baseUrl}}/users",
    ...overrides,
  };
}

function expectErrorCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`expected ${code} to be thrown`);
  } catch (error) {
    expect(error).toBeInstanceOf(BrunoMcpError);
    expect((error as BrunoMcpError).code).toBe(code);
  }
}

interface CapturedTool {
  name: string;
  handler: (input: any) => CallToolResult | Promise<CallToolResult>;
}

function captureTool(): CapturedTool {
  let captured: CapturedTool | undefined;
  const fakeServer = {
    registerTool(
      name: string,
      _config: unknown,
      handler: CapturedTool["handler"],
    ) {
      captured = { name, handler };
    },
  } as unknown as McpServer;

  registerCreateRequest(fakeServer, config);
  if (captured === undefined) throw new Error("tool was not registered");
  return captured;
}

describe("createRequest", () => {
  it("creates missing folders and makes the request immediately discoverable", () => {
    const result = createRequest(config, requestInput());

    expect(result).toEqual({
      collection: "api",
      path: "Users/Create User.yml",
      metadata: {
        name: "Create User",
        type: "http",
        method: "POST",
        url: "{{baseUrl}}/users",
      },
    });
    expect(
      parseYaml(readFileSync(join(root, "api/Users/Create User.yml"), "utf8")),
    ).toEqual({
      info: { name: "Create User", type: "http" },
      http: { method: "POST", url: "{{baseUrl}}/users" },
    });
    expect(listRequests(config, { collection: "api" }).requests).toEqual([
      { path: "Users/Create User.yml", ...result.metadata },
    ]);
    expect(
      getRequest(config, {
        collection: "api",
        request: "Users/Create User.yml",
      }).metadata,
    ).toEqual(result.metadata);
  });

  it("serializes the full Bruno v4 HTTP request field set", () => {
    const input = requestInput({
      request: "Full.yml",
      sequence: 3,
      tags: ["users", "write"],
      description: { type: "text/markdown", content: "Creates a user." },
      headers: [
        {
          name: "Content-Type",
          value: "application/json",
          description: "Payload type",
        },
        { name: "X-Debug", value: "1", disabled: true },
      ],
      params: [
        { name: "dryRun", value: "false", type: "query" },
        { name: "tenant", value: "{{tenant}}", type: "path" },
      ],
      body: [
        {
          title: "JSON payload",
          selected: true,
          body: { type: "json", data: '{\n  "name": "Ada"\n}' },
        },
        {
          title: "Form payload",
          body: {
            type: "form-urlencoded",
            data: [{ name: "name", value: "Ada" }],
          },
        },
      ],
      auth: {
        type: "oauth2",
        flow: "authorization_code",
        authorizationUrl: "{{authorizationUrl}}",
        accessTokenUrl: "{{accessTokenUrl}}",
        callbackUrl: "{{callbackUrl}}",
        credentials: {
          clientId: "{{clientId}}",
          clientSecret: "{{clientSecret}}",
          placement: "body",
        },
        scope: "users:write",
        state: "{{state}}",
        pkce: { method: "S256" },
        additionalParameters: {
          authorizationRequest: [
            { name: "audience", value: "api", placement: "query" },
          ],
        },
        tokenConfig: {
          id: "users-token",
          placement: { header: "Bearer" },
          source: "access_token",
        },
        settings: { autoFetchToken: true, autoRefreshToken: true },
      },
      runtime: {
        variables: [
          { name: "attempt", value: { type: "number", data: "1" } },
        ],
        scripts: [
          { type: "before-request", code: 'bru.setVar("started", true);' },
          {
            type: "tests",
            code: 'test("created", () => expect(res.status).to.equal(201));',
          },
        ],
        assertions: [
          { expression: "res.status", operator: "eq", value: "201" },
        ],
        actions: [
          {
            type: "set-variable",
            phase: "after-response",
            selector: { expression: "body.id", method: "jsonq" },
            variable: { name: "userId", scope: "runtime" },
          },
        ],
      },
      settings: {
        encodeUrl: true,
        timeout: 5_000,
        followRedirects: "inherit",
        forwardAuthorizationHeader: false,
        maxRedirects: 3,
      },
      examples: [
        {
          name: "Success",
          request: {
            url: "https://example.com/users",
            method: "POST",
            body: { type: "json", data: '{"name":"Ada"}' },
          },
          response: {
            status: 201,
            statusText: "Created",
            headers: [{ name: "Location", value: "/users/1" }],
            body: { type: "json", data: '{"id":1}' },
          },
        },
      ],
      docs: "Use an environment for real credentials.",
      app: { enabled: true, code: "export default {};" },
    });

    createRequest(config, input);

    expect(
      parseYaml(readFileSync(join(root, "api/Full.yml"), "utf8")),
    ).toEqual({
      info: {
        name: input.name,
        type: "http",
        seq: input.sequence,
        tags: input.tags,
        description: input.description,
      },
      http: {
        method: input.method,
        url: input.url,
        headers: input.headers,
        params: input.params,
        body: input.body,
        auth: input.auth,
      },
      runtime: input.runtime,
      settings: input.settings,
      examples: input.examples,
      docs: input.docs,
      app: input.app,
    });
  });

  it("never overwrites an existing request", () => {
    const original = "info:\n  name: Existing\n  type: http\n";
    write("api/Users/Create User.yml", original);

    expectErrorCode(
      () => createRequest(config, requestInput()),
      "REQUEST_ALREADY_EXISTS",
    );
    expect(readFileSync(join(root, "api/Users/Create User.yml"), "utf8")).toBe(
      original,
    );
  });

  it.each([
    "Request.yaml",
    "folder.yml",
    "Group/collection.yml",
    "environments/Request.yml",
    "Group//Request.yml",
    "Group/../Request.yml",
    "Group\\Request.yml",
  ])("rejects invalid or reserved request path %s", (request) => {
    expectErrorCode(
      () => createRequest(config, requestInput({ request })),
      "INVALID_REQUEST_PATH",
    );
  });

  it("rejects traversal outside the collection", () => {
    expectErrorCode(
      () => createRequest(config, requestInput({ request: "../../Escape.yml" })),
      "INVALID_REQUEST_PATH",
    );
  });

  it("rejects paths through a symlink outside the collection", () => {
    const outside = realpathSync(
      mkdtempSync(join(tmpdir(), "bruno-mcp-create-outside-")),
    );
    try {
      symlinkSync(outside, join(root, "api/escape"), "dir");
      expectErrorCode(
        () =>
          createRequest(
            config,
            requestInput({ request: "escape/Request.yml" }),
          ),
        "INVALID_REQUEST_PATH",
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects paths through an in-collection directory symlink", () => {
    mkdirSync(join(root, "api/environments"));
    symlinkSync("environments", join(root, "api/alias"), "dir");

    expectErrorCode(
      () => createRequest(config, requestInput({ request: "alias/Request.yml" })),
      "INVALID_REQUEST_PATH",
    );
    expect(() => readFileSync(join(root, "api/environments/Request.yml"))).toThrow();
  });

  it("rejects a dangling final symlink without creating its target", () => {
    symlinkSync("Actual.yml", join(root, "api/Alias.yml"), "file");

    expectErrorCode(
      () => createRequest(config, requestInput({ request: "Alias.yml" })),
      "INVALID_REQUEST_PATH",
    );
    expect(() => readFileSync(join(root, "api/Actual.yml"))).toThrow();
  });

  it("rejects a path owned by a nested collection", () => {
    write(
      "api/nested/opencollection.yml",
      "opencollection: 1.0.0\ninfo:\n  name: Nested\n",
    );

    expectErrorCode(
      () => createRequest(config, requestInput({ request: "nested/New.yml" })),
      "INVALID_REQUEST_PATH",
    );
  });

  it("fails when the collection does not exist", () => {
    expectErrorCode(
      () => createRequest(config, requestInput({ collection: "missing" })),
      "COLLECTION_NOT_FOUND",
    );
  });
});

describe("tool registration", () => {
  it("returns structured content for a successful creation", async () => {
    const tool = captureTool();
    expect(tool.name).toBe(CREATE_REQUEST_TOOL_NAME);

    const result = await tool.handler(requestInput());

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      collection: "api",
      path: "Users/Create User.yml",
    });
  });

  it("returns a structured conflict error", async () => {
    const tool = captureTool();
    await tool.handler(requestInput());

    const result = await tool.handler(requestInput());

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: "REQUEST_ALREADY_EXISTS",
    });
  });
});
