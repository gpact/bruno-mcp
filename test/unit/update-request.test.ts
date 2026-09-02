import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BrunoMcpError } from "../../src/bruno/errors.js";
import { type Config, loadConfig } from "../../src/config/config.js";
import { parseYaml } from "../../src/opencollection/parser.js";
import { requestRevision } from "../../src/opencollection/revision.js";
import { getRequest } from "../../src/tools/get-request.js";
import {
  UPDATE_REQUEST_TOOL_NAME,
  type UpdateRequestInput,
  registerUpdateRequest,
  updateRequest,
} from "../../src/tools/update-request.js";

const REQUEST_SOURCE = [
  "# request comment",
  "info:",
  "  name: \"Original\" # display name",
  "  type: http",
  "  legacy: keep",
  "http:",
  "  method: GET",
  '  url: "/old"',
  "  extension:",
  "    enabled: true",
  "unknownTop:",
  "  value: keep",
  "",
].join("\n");

let root: string;
let config: Config;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bruno-mcp-update-request-")));
  write(
    "api/opencollection.yml",
    "opencollection: 1.0.0\ninfo:\n  name: API\n",
  );
  write("api/Request.yml", REQUEST_SOURCE);
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
  overrides: Partial<UpdateRequestInput> = {},
): UpdateRequestInput {
  return {
    collection: "api",
    request: "Request.yml",
    expectedRevision: requestRevision(
      readFileSync(join(root, "api/Request.yml"), "utf8"),
    ),
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

  registerUpdateRequest(fakeServer, config);
  if (captured === undefined) throw new Error("tool was not registered");
  return captured;
}

describe("updateRequest", () => {
  it("patches every supported request field and preserves untouched content", () => {
    const result = updateRequest(
      config,
      requestInput({
        name: "Updated",
        sequence: 4,
        tags: ["users", "write"],
        description: { content: "Updated request.", type: "text/markdown" },
        method: "POST",
        url: "{{baseUrl}}/users",
        headers: [{ name: "Accept", value: "application/json" }],
        params: [{ name: "dryRun", value: "false", type: "query" }],
        body: { type: "json", data: '{"name":"Ada"}' },
        auth: "inherit",
        runtime: {
          variables: [{ name: "attempt", value: { type: "number", data: "1" } }],
        },
        settings: { timeout: 5_000, followRedirects: "inherit" },
        examples: [
          {
            name: "Success",
            response: { status: 201, statusText: "Created" },
          },
        ],
        docs: "Updated docs.",
        app: { enabled: true, code: "export default {};" },
      }),
    );

    const updatedSource = readFileSync(join(root, "api/Request.yml"), "utf8");
    expect(result).toEqual({
      collection: "api",
      path: "Request.yml",
      changed: true,
      revision: requestRevision(updatedSource),
    });
    expect(parseYaml(updatedSource)).toEqual({
      info: {
        name: "Updated",
        type: "http",
        legacy: "keep",
        seq: 4,
        tags: ["users", "write"],
        description: { content: "Updated request.", type: "text/markdown" },
      },
      http: {
        method: "POST",
        url: "{{baseUrl}}/users",
        extension: { enabled: true },
        headers: [{ name: "Accept", value: "application/json" }],
        params: [{ name: "dryRun", value: "false", type: "query" }],
        body: { type: "json", data: '{"name":"Ada"}' },
        auth: "inherit",
      },
      unknownTop: { value: "keep" },
      runtime: {
        variables: [{ name: "attempt", value: { type: "number", data: "1" } }],
      },
      settings: { timeout: 5_000, followRedirects: "inherit" },
      examples: [
        {
          name: "Success",
          response: { status: 201, statusText: "Created" },
        },
      ],
      docs: "Updated docs.",
      app: { enabled: true, code: "export default {};" },
    });
    expect(updatedSource).toContain("# request comment");
    expect(updatedSource).toContain('name: "Updated" # display name');
    expect(getRequest(config, requestInput()).revision).toBe(result.revision);
  });

  it("removes optional fields when their patches are null", () => {
    write(
      "api/Request.yml",
      [
        "info:",
        "  name: Existing",
        "  type: http",
        "  seq: 2",
        "  tags: [old]",
        "  description: Old",
        "http:",
        "  method: POST",
        "  url: /old",
        "  headers: []",
        "  params: []",
        "  body: { type: text, data: old }",
        "  auth: inherit",
        "runtime: {}",
        "settings: {}",
        "examples: []",
        "docs: Old docs",
        "app: {}",
        "extension: keep",
        "",
      ].join("\n"),
    );

    updateRequest(
      config,
      requestInput({
        sequence: null,
        tags: null,
        description: null,
        headers: null,
        params: null,
        body: null,
        auth: null,
        runtime: null,
        settings: null,
        examples: null,
        docs: null,
        app: null,
      }),
    );

    expect(parseYaml(readFileSync(join(root, "api/Request.yml"), "utf8"))).toEqual(
      {
        info: { name: "Existing", type: "http" },
        http: { method: "POST", url: "/old" },
        extension: "keep",
      },
    );
  });

  it("preserves CRLF line endings, quote style, comments, and no final newline", () => {
    const source = `\uFEFF${[
      "info:",
      '  name: "Original" # display',
      "  type: http",
      "http:",
      "  method: GET",
      "  url: /old",
    ].join("\r\n")}`;
    write("api/Request.yml", source);

    updateRequest(config, requestInput({ name: "Changed", url: "/new" }));

    const updated = readFileSync(join(root, "api/Request.yml"), "utf8");
    expect(updated.startsWith("\uFEFF")).toBe(true);
    expect(updated).toContain('name: "Changed" # display');
    expect(updated).not.toMatch(/(?<!\r)\n/);
    expect(updated.endsWith("\n")).toBe(false);
  });

  it("preserves an anchor attached to a replaced field", () => {
    write(
      "api/Request.yml",
      [
        "info:",
        "  name: Anchored",
        "  type: http",
        "http:",
        "  method: GET",
        "  url: /old",
        "  headers: &shared [{ name: Old, value: old }]",
        "savedHeaders: *shared",
        "",
      ].join("\n"),
    );

    updateRequest(
      config,
      requestInput({ headers: [{ name: "New", value: "new" }] }),
    );

    const source = readFileSync(join(root, "api/Request.yml"), "utf8");
    expect(source).toContain("headers: &shared");
    expect(source).toContain("savedHeaders: *shared");
  });

  it("rejects removing a field whose anchor is still referenced", () => {
    const source = [
      "info:",
      "  name: Anchored",
      "  type: http",
      "http:",
      "  method: GET",
      "  url: /old",
      "  headers: &shared []",
      "savedHeaders: *shared",
      "",
    ].join("\n");
    write("api/Request.yml", source);

    expectErrorCode(
      () => updateRequest(config, requestInput({ headers: null })),
      "INVALID_MUTATION_TARGET",
    );
    expect(readFileSync(join(root, "api/Request.yml"), "utf8")).toBe(source);
  });

  it("does not preserve a scalar tag that changes the patch value's type", () => {
    write(
      "api/Request.yml",
      [
        "info:",
        "  name: Tagged",
        "  type: http",
        '  seq: !!str "2"',
        "http:",
        "  method: GET",
        "  url: /old",
        "",
      ].join("\n"),
    );

    updateRequest(config, requestInput({ sequence: 4 }));

    const source = readFileSync(join(root, "api/Request.yml"), "utf8");
    expect(parseYaml(source)).toMatchObject({ info: { seq: 4 } });
    expect(source).not.toContain("!!str");
  });

  it("preserves a compatible numeric scalar format", () => {
    write(
      "api/Request.yml",
      "info:\n  name: Hex\n  type: http\n  seq: 0x2\nhttp:\n  method: GET\n  url: /old\n",
    );

    updateRequest(config, requestInput({ sequence: 4 }));

    expect(readFileSync(join(root, "api/Request.yml"), "utf8")).toContain(
      "seq: 0x4",
    );
  });

  it("does not rewrite a semantic no-op", () => {
    const before = readFileSync(join(root, "api/Request.yml"), "utf8");

    const result = updateRequest(
      config,
      requestInput({ name: "Original", docs: null }),
    );

    expect(result).toEqual({
      collection: "api",
      path: "Request.yml",
      changed: false,
      revision: requestRevision(before),
    });
    expect(readFileSync(join(root, "api/Request.yml"), "utf8")).toBe(before);
  });

  it("preserves unrelated legacy values and matches create collection eligibility", () => {
    write(
      "api/opencollection.yml",
      "opencollection: 2.0.0\ninfo:\n  name: API\n",
    );
    write(
      "api/Request.yml",
      [
        "info:",
        "  name: Legacy",
        "  type: http",
        '  tags: [""]',
        "http:",
        "  method: CUSTOM",
        "  url: /old",
        "  headers: legacy-shape",
        "",
      ].join("\n"),
    );

    updateRequest(config, requestInput({ url: "/new" }));

    expect(parseYaml(readFileSync(join(root, "api/Request.yml"), "utf8"))).toEqual(
      {
        info: { name: "Legacy", type: "http", tags: [""] },
        http: {
          method: "CUSTOM",
          url: "/new",
          headers: "legacy-shape",
        },
      },
    );
  });

  it("rejects stale revisions without changing the request", () => {
    const input = requestInput({ url: "/new" });
    const changed = REQUEST_SOURCE.replace("/old", "/external");
    write("api/Request.yml", changed);

    expectErrorCode(() => updateRequest(config, input), "REVISION_CONFLICT");
    expect(readFileSync(join(root, "api/Request.yml"), "utf8")).toBe(changed);
  });

  it("rejects an update while another server process owns its lock", () => {
    const lockPath = join(
      root,
      "api",
      `.bruno-mcp-update-${requestRevision("Request.yml")}.lock`,
    );
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid }));

    expectErrorCode(
      () => updateRequest(config, requestInput({ url: "/new" })),
      "MUTATION_CONFLICT",
    );
    expect(readFileSync(join(root, "api/Request.yml"), "utf8")).toBe(
      REQUEST_SOURCE,
    );
  });

  it("recovers a lock left by a terminated server process", () => {
    const lockName = `.bruno-mcp-update-${requestRevision("Request.yml")}.lock`;
    writeFileSync(
      join(root, "api", lockName),
      JSON.stringify({ pid: 2_147_483_647 }),
    );
    const staleTime = new Date(Date.now() - 10 * 60 * 1_000);
    utimesSync(join(root, "api", lockName), staleTime, staleTime);

    const result = updateRequest(config, requestInput({ url: "/new" }));

    expect(result.changed).toBe(true);
    expect(readdirSync(join(root, "api"))).not.toContain(lockName);
  });

  it.each([
    [
      "a websocket request",
      "info:\n  name: Feed\n  type: websocket\nwebsocket:\n  url: wss://example.com\n",
    ],
    [
      "an HTTP request without a URL",
      "info:\n  name: Invalid\n  type: http\nhttp:\n  method: GET\n",
    ],
    ["a document without info", "http:\n  method: GET\n  url: /ping\n"],
  ])("rejects %s as a mutation target", (_label, source) => {
    write("api/Request.yml", source);

    expectErrorCode(
      () => updateRequest(config, requestInput({ name: "Changed" })),
      "INVALID_MUTATION_TARGET",
    );
  });

  it("surfaces malformed request YAML without rewriting it", () => {
    const source = "info: [\n";
    write("api/Request.yml", source);

    expectErrorCode(
      () => updateRequest(config, requestInput({ name: "Changed" })),
      "INVALID_YAML",
    );
    expect(readFileSync(join(root, "api/Request.yml"), "utf8")).toBe(source);
  });

  it("applies the create path policy to update targets", () => {
    write("api/folder.yml", REQUEST_SOURCE);

    expectErrorCode(
      () =>
        updateRequest(
          config,
          requestInput({ request: "folder.yml", name: "Changed" }),
        ),
      "INVALID_REQUEST_PATH",
    );
  });

  it("rejects request paths through symlinks", () => {
    symlinkSync("Request.yml", join(root, "api/Alias.yml"), "file");

    expectErrorCode(
      () =>
        updateRequest(
          config,
          requestInput({ request: "Alias.yml", name: "Changed" }),
        ),
      "INVALID_REQUEST_PATH",
    );
  });

  it("rejects requests owned by nested collections", () => {
    write(
      "api/nested/opencollection.yml",
      "opencollection: 1.0.0\ninfo:\n  name: Nested\n",
    );
    write("api/nested/Request.yml", REQUEST_SOURCE);

    expectErrorCode(
      () =>
        updateRequest(
          config,
          requestInput({ request: "nested/Request.yml", name: "Changed" }),
        ),
      "INVALID_REQUEST_PATH",
    );
  });

  it("atomically replaces the request while preserving its mode", () => {
    const target = join(root, "api/Request.yml");
    chmodSync(target, 0o640);

    updateRequest(config, requestInput({ url: "/new" }));

    expect(statSync(target).mode & 0o777).toBe(0o640);
    expect(readdirSync(join(root, "api")).filter((name) => name.endsWith(".tmp")))
      .toEqual([]);
  });

  it("fails when the request does not exist", () => {
    expectErrorCode(
      () =>
        updateRequest(
          config,
          requestInput({ request: "Missing.yml", name: "Changed" }),
        ),
      "REQUEST_NOT_FOUND",
    );
  });
});

describe("tool registration", () => {
  it("returns minimal structured content for a successful update", async () => {
    const tool = captureTool();
    expect(tool.name).toBe(UPDATE_REQUEST_TOOL_NAME);

    const result = await tool.handler(requestInput({ url: "/new" }));

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      collection: "api",
      path: "Request.yml",
      changed: true,
    });
    expect(result.structuredContent).not.toHaveProperty("metadata");
  });

  it("returns a structured revision conflict", async () => {
    const tool = captureTool();
    const input = requestInput({ url: "/new" });
    write("api/Request.yml", REQUEST_SOURCE.replace("/old", "/external"));

    const result = await tool.handler(input);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "REVISION_CONFLICT" });
  });
});
