import { describe, expect, it, vi } from "vitest";

import {
  BrunoMcpError,
  toMcpErrorContent,
} from "../../src/bruno/errors.js";
import {
  parseYaml,
  stringifyYaml,
} from "../../src/opencollection/parser.js";

describe("parseYaml", () => {
  it("parses a valid document into a plain object", () => {
    const result = parseYaml("opencollection: 1.0.0\ninfo:\n  name: Example API\n");

    expect(result).toEqual({
      opencollection: "1.0.0",
      info: { name: "Example API" },
    });
  });

  it("parses an empty document as null", () => {
    expect(parseYaml("")).toBeNull();
  });

  it("tolerates unknown OpenCollection fields (forward compatibility)", () => {
    const source = [
      "info:",
      "  name: Something New",
      "  type: some-future-type",
      "",
      "newFeature:",
      "  enabled: true",
      "  nested:",
      "    - 1",
      "    - 2",
      "",
    ].join("\n");

    expect(parseYaml(source)).toEqual({
      info: { name: "Something New", type: "some-future-type" },
      newFeature: { enabled: true, nested: [1, 2] },
    });
  });

  it("throws a structured INVALID_YAML error on malformed input", () => {
    let thrown: unknown;
    try {
      parseYaml("info:\n  name: [unterminated\n");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BrunoMcpError);
    const error = thrown as BrunoMcpError;
    expect(error.code).toBe("INVALID_YAML");
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("includes the provided source label in the error message", () => {
    expect(() =>
      parseYaml("foo: [bar", { source: "hotel/opencollection.yml" }),
    ).toThrowError(/hotel\/opencollection\.yml/);
  });

  it("does not expose source content through the structured error", () => {
    const secret = "super-secret-token";

    try {
      parseYaml(`value: [${secret}\n`, {
        source: "environments/Local.yml",
      });
      throw new Error("Expected parseYaml to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BrunoMcpError);
      const content = toMcpErrorContent(error as BrunoMcpError);

      expect(content).toEqual({
        code: "INVALID_YAML",
        message: "Failed to parse YAML (environments/Local.yml).",
      });
      expect(content.message).not.toContain(secret);
    }
  });

  it("suppresses source-bearing warnings from the YAML parser", () => {
    const emitWarning = vi
      .spyOn(process, "emitWarning")
      .mockImplementation(() => {});

    try {
      expect(
        parseYaml(
          "value: !future super-secret-token\nsecret: true\n",
        ),
      ).toEqual({ value: "super-secret-token", secret: true });
      expect(emitWarning).not.toHaveBeenCalled();
    } finally {
      emitWarning.mockRestore();
    }
  });
});

describe("stringifyYaml", () => {
  it("emits stable OpenCollection YAML without wrapping long values", () => {
    const value = {
      info: { name: "Create User", type: "http" },
      http: {
        method: "POST",
        url: "{{baseUrl}}/users/with/a/path/that/must/remain/on/one/line",
      },
      runtime: {
        scripts: [{ type: "tests", code: "test(\"created\", () => {\n  expect(res.status).to.equal(201);\n});" }],
      },
    };

    const source = stringifyYaml(value);

    expect(source).toContain(
      '  url: "{{baseUrl}}/users/with/a/path/that/must/remain/on/one/line"',
    );
    expect(source).toContain("    code: |-\n");
    expect(parseYaml(source)).toEqual(value);
  });
});
