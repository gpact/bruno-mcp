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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { parseEnvironment as parseBrunoEnvironment } from "@usebruno/filestore";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BrunoMcpError } from "../../src/bruno/errors.js";
import { type Config, loadConfig } from "../../src/config/config.js";
import { getEnvironment } from "../../src/opencollection/environment.js";
import { parseYaml } from "../../src/opencollection/parser.js";
import {
  CREATE_ENVIRONMENT_TOOL_NAME,
  type CreateEnvironmentInput,
  createEnvironment,
  environmentVariableSchema,
  registerCreateEnvironment,
} from "../../src/tools/create-environment.js";
import {
  UPDATE_ENVIRONMENT_TOOL_NAME,
  type UpdateEnvironmentInput,
  registerUpdateEnvironment,
  updateEnvironment,
} from "../../src/tools/update-environment.js";

let root: string;
let config: Config;

beforeEach(() => {
  root = realpathSync(
    mkdtempSync(join(tmpdir(), "bruno-mcp-environment-mutations-")),
  );
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
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function createInput(
  overrides: Partial<CreateEnvironmentInput> = {},
): CreateEnvironmentInput {
  return {
    collection: "api",
    name: "Local",
    variables: [],
    ...overrides,
  };
}

function updateInput(
  overrides: Partial<UpdateEnvironmentInput> = {},
): UpdateEnvironmentInput {
  return {
    collection: "api",
    name: "Local",
    variables: [],
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

describe("createEnvironment", () => {
  it("creates a normalized environment with the full variable shape", () => {
    const variables: CreateEnvironmentInput["variables"] = [
      {
        name: "port",
        value: { type: "number", data: "3000" },
        description: { content: "Server port", type: "text/markdown" },
        disabled: true,
        secret: false,
      },
      {
        name: "token",
        secret: true,
        type: "string",
        disabled: true,
      },
    ];

    const result = createEnvironment(
      config,
      createInput({ name: "environments/Local.yml", variables }),
    );

    expect(result).toEqual({
      collection: "api",
      path: "environments/Local.yml",
      name: "Local",
    });
    expect(
      parseYaml(readFileSync(join(root, "api/environments/Local.yml"), "utf8")),
    ).toEqual({
      name: "Local",
      variables: [
        {
          name: "port",
          value: { type: "number", data: "3000" },
          description: { content: "Server port", type: "text/markdown" },
          disabled: true,
        },
        {
          name: "token",
          secret: true,
          type: "string",
          disabled: true,
        },
      ],
    });
    expect(
      environmentVariableSchema.parse({
        name: "port",
        value: { type: "number", data: "3000" },
        disabled: true,
      }),
    ).toEqual({
      name: "port",
      value: { type: "number", data: "3000" },
      disabled: true,
    });
  });

  it("does not persist the redaction marker for a secret", () => {
    createEnvironment(
      config,
      createInput({
        variables: [{ name: "token", value: "[REDACTED]", secret: true }],
      }),
    );

    expect(
      parseYaml(readFileSync(join(root, "api/environments/Local.yml"), "utf8")),
    ).toEqual({
      name: "Local",
      variables: [{ name: "token", secret: true }],
    });
  });

  it("never overwrites an existing environment", () => {
    const original = "name: Local\nvariables: []\n";
    write("api/environments/Local.yml", original);

    expectErrorCode(
      () => createEnvironment(config, createInput()),
      "ENVIRONMENT_ALREADY_EXISTS",
    );
    expect(readFileSync(join(root, "api/environments/Local.yml"), "utf8")).toBe(
      original,
    );
  });

  it.each([
    "../Request",
    "environments/../Request.yml",
    "Nested/Local",
    "Nested\\Local",
    " ",
    "Local\nOther",
  ])("rejects invalid environment reference %j", (name) => {
    expectErrorCode(
      () => createEnvironment(config, createInput({ name })),
      "INVALID_ENVIRONMENT_NAME",
    );
    expect(() => readFileSync(join(root, "api/Request.yml"))).toThrow();
  });

  it("rejects an in-collection environments directory symlink", () => {
    mkdirSync(join(root, "api/actual-environments"));
    symlinkSync(
      "actual-environments",
      join(root, "api/environments"),
      "dir",
    );

    expectErrorCode(
      () => createEnvironment(config, createInput()),
      "INVALID_ENVIRONMENT_NAME",
    );
    expect(() =>
      readFileSync(join(root, "api/actual-environments/Local.yml")),
    ).toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "creates environment files with restrictive permissions",
    () => {
      createEnvironment(config, createInput());

      expect(statSync(join(root, "api/environments/Local.yml")).mode & 0o777).toBe(
        0o600,
      );
    },
  );
});

describe("updateEnvironment", () => {
  it("round-trips typed metadata and removes stored secret values", () => {
    write(
      "api/environments/Local.yml",
      `name: Local
color: "#123456"
variables:
  - name: port
    value:
      type: number
      data: "3000"
    description:
      content: Server port
      type: text/markdown
    disabled: true
  - name: storedToken
    value: actual-secret
    secret: true
    description: Stored locally
  - name: externalToken
    secret: true
    type: string
    disabled: true
`,
    );
    const inspected = getEnvironment(config.root, "api", "Local");

    expect(inspected.variables).toEqual([
      {
        name: "port",
        value: { type: "number", data: "3000" },
        secret: false,
        description: { content: "Server port", type: "text/markdown" },
        disabled: true,
      },
      {
        name: "storedToken",
        value: "[REDACTED]",
        secret: true,
        description: "Stored locally",
      },
      {
        name: "externalToken",
        value: "[REDACTED]",
        secret: true,
        type: "string",
        disabled: true,
      },
    ]);

    updateEnvironment(
      config,
      updateInput({
        variables: inspected.variables.map((variable) =>
          environmentVariableSchema.parse(variable),
        ),
      }),
    );

    expect(
      parseYaml(readFileSync(join(root, "api/environments/Local.yml"), "utf8")),
    ).toEqual({
      name: "Local",
      color: "#123456",
      variables: [
        {
          name: "port",
          value: { type: "number", data: "3000" },
          description: { content: "Server port", type: "text/markdown" },
          disabled: true,
        },
        {
          name: "storedToken",
          secret: true,
          description: "Stored locally",
        },
        {
          name: "externalToken",
          secret: true,
          type: "string",
          disabled: true,
        },
      ],
    });
  });

  it("does not persist the redaction marker for a new secret", () => {
    write("api/environments/Local.yml", "name: Local\nvariables: []\n");

    updateEnvironment(
      config,
      updateInput({
        variables: [
          { name: "newToken", value: "[REDACTED]", secret: true },
        ],
      }),
    );

    expect(
      parseYaml(readFileSync(join(root, "api/environments/Local.yml"), "utf8")),
    ).toEqual({
      name: "Local",
      variables: [{ name: "newToken", secret: true }],
    });
  });

  it("preserves a literal regular value equal to the redaction marker", () => {
    write("api/environments/Local.yml", "name: Local\nvariables: []\n");

    updateEnvironment(
      config,
      updateInput({ variables: [{ name: "literal", value: "[REDACTED]" }] }),
    );

    expect(
      parseYaml(readFileSync(join(root, "api/environments/Local.yml"), "utf8")),
    ).toEqual({
      name: "Local",
      variables: [{ name: "literal", value: "[REDACTED]" }],
    });
  });

  it("removes duplicate stored secrets without restoring either value", () => {
    const source = `name: Local
variables:
  - name: token
    value: first-secret
    secret: true
  - name: token
    value: second-secret
    secret: true
`;
    write(
      "api/environments/Local.yml",
      source,
    );

    updateEnvironment(
      config,
      updateInput({
        variables: [
          { name: "token", value: "[REDACTED]", secret: true },
          { name: "token", secret: true },
        ],
      }),
    );
    const updated = readFileSync(join(root, "api/environments/Local.yml"), "utf8");
    expect(updated).not.toContain("first-secret");
    expect(updated).not.toContain("second-secret");
    expect(parseYaml(updated)).toEqual({
      name: "Local",
      variables: [
        { name: "token", secret: true },
        { name: "token", secret: true },
      ],
    });
  });

  it("rejects traversal to another collection document", () => {
    const request = "info:\n  name: Request\n  type: http\n";
    write("api/Request.yml", request);

    expectErrorCode(
      () => updateEnvironment(config, updateInput({ name: "../Request" })),
      "INVALID_ENVIRONMENT_NAME",
    );
    expect(readFileSync(join(root, "api/Request.yml"), "utf8")).toBe(request);
  });

  it("rejects environment files that are symbolic links", () => {
    const request = "info:\n  name: Request\n  type: http\n";
    write("api/Request.yml", request);
    mkdirSync(join(root, "api/environments"));
    symlinkSync("../Request.yml", join(root, "api/environments/Local.yml"));

    expectErrorCode(
      () => updateEnvironment(config, updateInput()),
      "INVALID_ENVIRONMENT_NAME",
    );
    expect(readFileSync(join(root, "api/Request.yml"), "utf8")).toBe(request);
  });

  it.skipIf(process.platform === "win32")(
    "preserves the environment mode during atomic replacement",
    () => {
      const target = join(root, "api/environments/Local.yml");
      write("api/environments/Local.yml", "name: Local\nvariables: []\n");
      chmodSync(target, 0o640);

      updateEnvironment(
        config,
        updateInput({ variables: [{ name: "baseUrl", value: "/new" }] }),
      );

      expect(statSync(target).mode & 0o777).toBe(0o640);
      expect(
        readdirSync(join(root, "api/environments")).filter((name) =>
          name.endsWith(".tmp"),
        ),
      ).toEqual([]);
    },
  );

  it("reports a missing environment", () => {
    expectErrorCode(
      () => updateEnvironment(config, updateInput()),
      "ENVIRONMENT_NOT_FOUND",
    );
  });

  it("rejects an environment whose YAML root is not a mapping", () => {
    write("api/environments/Local.yml", "- not\n- an\n- environment\n");

    expectErrorCode(
      () => updateEnvironment(config, updateInput()),
      "INVALID_MUTATION_TARGET",
    );
    expect(readFileSync(join(root, "api/environments/Local.yml"), "utf8")).toBe(
      "- not\n- an\n- environment\n",
    );
  });

  it("preserves the BOM, line endings, and missing final newline", () => {
    const target = join(root, "api/environments/Local.yml");
    const source = "\uFEFFname: Local\r\nvariables: []";
    write("api/environments/Local.yml", source);

    updateEnvironment(
      config,
      updateInput({ variables: [{ name: "baseUrl", value: "/new" }] }),
    );

    const updated = readFileSync(target, "utf8");
    expect(updated.startsWith("\uFEFF")).toBe(true);
    expect(updated).toContain("\r\n");
    expect(updated.replaceAll("\r\n", "")).not.toContain("\n");
    expect(updated.endsWith("\n")).toBe(false);
  });

  it("preserves an anchor on the variables sequence", () => {
    write(
      "api/environments/Local.yml",
      "name: Local\nvariables: &shared []\nmirror: *shared\n",
    );

    updateEnvironment(
      config,
      updateInput({ variables: [{ name: "baseUrl", value: "/new" }] }),
    );

    const updated = readFileSync(
      join(root, "api/environments/Local.yml"),
      "utf8",
    );
    expect(updated).toContain("variables: &shared");
    expect(updated).toContain("mirror: *shared");
    expect(parseYaml(updated)).toEqual({
      name: "Local",
      variables: [{ name: "baseUrl", value: "/new" }],
      mirror: [{ name: "baseUrl", value: "/new" }],
    });
  });
});

describe.each(["create", "update"] as const)(
  "%s environment compatibility",
  (operation) => {
    const original = "name: Local\nvariables: []\n";

    function mutate(
      variables: NonNullable<CreateEnvironmentInput["variables"]>,
    ): void {
      if (operation === "create") {
        createEnvironment(config, createInput({ variables }));
      } else {
        updateEnvironment(config, updateInput({ variables }));
      }
    }

    beforeEach(() => {
      if (operation === "update") write("api/environments/Local.yml", original);
    });

    it.each([
      { name: "token", secret: true, value: "example-secret" },
      { name: "token", secret: true, value: "" },
      {
        name: "endpoint",
        value: [
          { title: "Local", selected: true, value: "http://localhost" },
        ],
      },
      { name: "endpoint", value: [] },
      { name: "empty", value: { type: "null", data: "" } },
      { name: "token", secret: true, type: "null" },
    ])("rejects unsupported input without writing: %j", (variable) => {
      expect(environmentVariableSchema.safeParse(variable).success).toBe(false);
      expectErrorCode(
        () => mutate(
          [variable] as unknown as NonNullable<CreateEnvironmentInput["variables"]>,
        ),
        "INVALID_MUTATION_TARGET",
      );
      if (operation === "create") {
        expect(readdirSync(join(root, "api"))).toEqual(["opencollection.yml"]);
      } else {
        expect(
          readFileSync(join(root, "api/environments/Local.yml"), "utf8"),
        ).toBe(original);
      }
    });

    it("writes values that Bruno loads with their intended runtime types", () => {
      mutate([
        { name: "endpoint", value: "http://localhost" },
        { name: "port", value: { type: "number", data: "3000" } },
        { name: "active", value: { type: "boolean", data: "true" } },
        { name: "options", value: { type: "object", data: '{"retries":2}' } },
        { name: "token", secret: true, value: "[REDACTED]" },
        { name: "externalToken", secret: true },
      ]);

      const source = readFileSync(join(root, "api/environments/Local.yml"), "utf8");
      const parsed = parseBrunoEnvironment(source, { format: "yml" });
      expect(parsed.variables).toMatchObject([
        { name: "endpoint", value: "http://localhost", secret: false },
        { name: "port", value: 3000, secret: false },
        { name: "active", value: true, secret: false },
        { name: "options", value: { retries: 2 }, secret: false },
        { name: "token", value: "", secret: true },
        { name: "externalToken", value: "", secret: true },
      ]);
      expect(source).not.toContain("[REDACTED]");
    });
  },
);

it("keeps existing variants inspectable but rejects writing them back", () => {
  const source = `name: Local
variables:
  - name: endpoint
    value:
      - title: Local
        selected: true
        value: http://localhost
      - title: Remote
        value:
          type: string
          data: https://example.com
  - name: emptyChoices
    value: []
`;
  write("api/environments/Local.yml", source);
  const inspected = getEnvironment(config.root, "api", "Local");
  expect(inspected.variables).toEqual([
    {
      name: "endpoint",
      value: [
        { title: "Local", selected: true, value: "http://localhost" },
        {
          title: "Remote",
          value: { type: "string", data: "https://example.com" },
        },
      ],
      secret: false,
    },
    { name: "emptyChoices", value: [], secret: false },
  ]);
  expectErrorCode(
    () => updateEnvironment(
      config,
      updateInput({
        variables: inspected.variables as UpdateEnvironmentInput["variables"],
      }),
    ),
    "INVALID_MUTATION_TARGET",
  );
  expect(readFileSync(join(root, "api/environments/Local.yml"), "utf8")).toBe(
    source,
  );
});

describe("tool registration", () => {
  interface ToolConfig {
    title?: string;
    description?: string;
    inputSchema?: unknown;
  }

  type ToolHandler = (
    input: Record<string, unknown>,
  ) => Promise<CallToolResult> | CallToolResult;

  interface CapturedTool {
    config: ToolConfig;
    handler: ToolHandler;
  }

  function captureTools(): Map<string, CapturedTool> {
    const tools = new Map<string, CapturedTool>();
    const server = {
      registerTool(name: string, toolConfig: ToolConfig, handler: ToolHandler) {
        tools.set(name, { config: toolConfig, handler });
      },
    } as unknown as McpServer;

    registerCreateEnvironment(server, config);
    registerUpdateEnvironment(server, config);
    return tools;
  }

  it("registers bruno_create_environment with expected metadata and handler", async () => {
    const tools = captureTools();
    const tool = tools.get(CREATE_ENVIRONMENT_TOOL_NAME);
    expect(tool).toBeDefined();
    expect(tool?.config.title).toBe("Create Bruno environment");

    const result = await tool?.handler(createInput());
    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent).toEqual({
      collection: "api",
      path: "environments/Local.yml",
      name: "Local",
    });

    const conflict = await tool?.handler(createInput());
    expect(conflict?.isError).toBe(true);
    expect(conflict?.structuredContent).toMatchObject({
      code: "ENVIRONMENT_ALREADY_EXISTS",
    });
  });

  it("registers bruno_update_environment with expected metadata and handler", async () => {
    write("api/environments/Local.yml", "name: Local\nvariables: []\n");

    const tools = captureTools();
    const tool = tools.get(UPDATE_ENVIRONMENT_TOOL_NAME);
    expect(tool).toBeDefined();
    expect(tool?.config.title).toBe("Update Bruno environment");

    const result = await tool?.handler(
      updateInput({ variables: [{ name: "baseUrl", value: "/new" }] }),
    );
    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent).toEqual({
      collection: "api",
      path: "environments/Local.yml",
      name: "Local",
    });

    const missing = await tool?.handler(updateInput({ name: "NonExistent" }));
    expect(missing?.isError).toBe(true);
    expect(missing?.structuredContent).toMatchObject({
      code: "ENVIRONMENT_NOT_FOUND",
    });
  });
});
