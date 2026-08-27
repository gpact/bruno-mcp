import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BrunoMcpError } from "../../src/bruno/errors.js";
import {
  getEnvironment,
  listEnvironments,
} from "../../src/opencollection/environment.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bruno-mcp-env-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function createCollection(relativePath: string, name = "Hotel API"): string {
  const directory = join(root, relativePath);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "opencollection.yml"),
    `opencollection: 1.0.0\ninfo:\n  name: ${name}\n`,
  );
  return directory;
}

function writeEnvironment(
  collectionPath: string,
  fileName: string,
  contents: string,
): void {
  const environmentsDir = join(root, collectionPath, "environments");
  mkdirSync(environmentsDir, { recursive: true });
  writeFileSync(join(environmentsDir, fileName), contents);
}

const LOCAL_ENV = `variables:
  - name: baseUrl
    value: http://localhost:4080
    secret: false

  - name: apiKey
    value: plaintext-should-be-hidden
    secret: true

  - name: clientSecret
    value: another-secret
    secret: true
`;

function expectErrorCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`expected ${code} to be thrown`);
  } catch (error) {
    expect(error).toBeInstanceOf(BrunoMcpError);
    expect((error as BrunoMcpError).code).toBe(code);
  }
}

describe("listEnvironments", () => {
  it("lists environment names sorted lexicographically", () => {
    createCollection("hotel");
    writeEnvironment("hotel", "Production.yml", "variables: []\n");
    writeEnvironment("hotel", "Local.yml", LOCAL_ENV);

    expect(listEnvironments(root, "hotel").map((env) => env.name)).toEqual([
      "Local",
      "Production",
    ]);
  });

  it("counts variables and secrets and reports a relative path", () => {
    createCollection("hotel");
    writeEnvironment("hotel", "Local.yml", LOCAL_ENV);

    expect(listEnvironments(root, "hotel")).toEqual([
      {
        name: "Local",
        path: "environments/Local.yml",
        variableCount: 3,
        secretCount: 2,
      },
    ]);
  });

  it("never exposes variable values through the list path", () => {
    createCollection("hotel");
    writeEnvironment("hotel", "Local.yml", LOCAL_ENV);

    const serialized = JSON.stringify(listEnvironments(root, "hotel"));
    expect(serialized).not.toContain("http://localhost:4080");
    expect(serialized).not.toContain("plaintext-should-be-hidden");
    expect(serialized).not.toContain("another-secret");
  });

  it("returns an empty list when the collection has no environments directory", () => {
    createCollection("hotel");

    expect(listEnvironments(root, "hotel")).toEqual([]);
  });

  it("ignores non-yaml files and nested directories", () => {
    createCollection("hotel");
    writeEnvironment("hotel", "Local.yml", LOCAL_ENV);
    writeEnvironment("hotel", "README.md", "not an environment\n");
    mkdirSync(join(root, "hotel", "environments", "nested"));

    expect(listEnvironments(root, "hotel").map((env) => env.name)).toEqual([
      "Local",
    ]);
  });

  it("treats a document without a variables array as empty", () => {
    createCollection("hotel");
    writeEnvironment("hotel", "Empty.yml", "info:\n  name: Empty\n");

    expect(listEnvironments(root, "hotel")).toEqual([
      {
        name: "Empty",
        path: "environments/Empty.yml",
        variableCount: 0,
        secretCount: 0,
      },
    ]);
  });

  it("throws COLLECTION_NOT_FOUND for an unknown collection", () => {
    expectErrorCode(() => listEnvironments(root, "missing"), "COLLECTION_NOT_FOUND");
  });

  it("skips environment files whose YAML cannot be parsed", () => {
    createCollection("hotel");
    writeEnvironment("hotel", "Local.yml", LOCAL_ENV);
    writeEnvironment("hotel", "Broken.yml", "variables: [oops\n");

    expect(listEnvironments(root, "hotel").map((env) => env.name)).toEqual([
      "Local",
    ]);
  });

  it("skips environment files that symlink outside the collection", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "bruno-mcp-out-")));
    try {
      writeFileSync(
        join(outside, "External.yml"),
        "variables:\n  - name: leaked\n    value: nope\n",
      );
      createCollection("hotel");
      writeEnvironment("hotel", "Local.yml", LOCAL_ENV);
      symlinkSync(
        join(outside, "External.yml"),
        join(root, "hotel", "environments", "External.yml"),
      );

      expect(listEnvironments(root, "hotel").map((env) => env.name)).toEqual([
        "Local",
      ]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("getEnvironment", () => {
  it("returns variables with non-secret values and redacts secrets", () => {
    createCollection("hotel");
    writeEnvironment("hotel", "Local.yml", LOCAL_ENV);

    expect(getEnvironment(root, "hotel", "Local")).toEqual({
      name: "Local",
      variables: [
        { name: "baseUrl", value: "http://localhost:4080", secret: false },
        { name: "apiKey", value: "[REDACTED]", secret: true },
        { name: "clientSecret", value: "[REDACTED]", secret: true },
      ],
    });
  });

  it("never returns a secret value even when stored as plaintext", () => {
    createCollection("hotel");
    writeEnvironment("hotel", "Local.yml", LOCAL_ENV);

    const serialized = JSON.stringify(getEnvironment(root, "hotel", "Local"));
    expect(serialized).not.toContain("plaintext-should-be-hidden");
    expect(serialized).not.toContain("another-secret");
  });

  it("resolves by bare name, name with extension, and relative path", () => {
    createCollection("hotel");
    writeEnvironment("hotel", "Local.yml", LOCAL_ENV);

    const byName = getEnvironment(root, "hotel", "Local");
    expect(getEnvironment(root, "hotel", "Local.yml")).toEqual(byName);
    expect(getEnvironment(root, "hotel", "environments/Local.yml")).toEqual(
      byName,
    );
  });

  it("throws ENVIRONMENT_NOT_FOUND when the environment is absent", () => {
    createCollection("hotel");
    writeEnvironment("hotel", "Local.yml", LOCAL_ENV);

    expectErrorCode(
      () => getEnvironment(root, "hotel", "Nope"),
      "ENVIRONMENT_NOT_FOUND",
    );
  });

  it("fails loud with INVALID_YAML when the requested environment is malformed", () => {
    createCollection("hotel");
    writeEnvironment("hotel", "Broken.yml", "variables: [oops\n");

    expectErrorCode(
      () => getEnvironment(root, "hotel", "Broken"),
      "INVALID_YAML",
    );
  });

  it("rejects references that escape the collection root", () => {
    createCollection("hotel");
    writeFileSync(join(root, "secret.yml"), "variables: []\n");

    expectErrorCode(
      () => getEnvironment(root, "hotel", "environments/../../secret.yml"),
      "ENVIRONMENT_NOT_FOUND",
    );
  });

  it("does not follow symlinked environment files out of the collection", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "bruno-mcp-out-")));
    try {
      writeFileSync(
        join(outside, "External.yml"),
        "variables:\n  - name: leaked\n    value: nope\n",
      );
      createCollection("hotel");
      mkdirSync(join(root, "hotel", "environments"), { recursive: true });
      symlinkSync(
        join(outside, "External.yml"),
        join(root, "hotel", "environments", "External.yml"),
      );

      expectErrorCode(
        () => getEnvironment(root, "hotel", "External"),
        "ENVIRONMENT_NOT_FOUND",
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
