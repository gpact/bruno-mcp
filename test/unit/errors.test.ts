import { describe, expect, it } from "vitest";

import {
  BRUNO_MCP_ERROR_CODES,
  BrunoMcpError,
  toMcpErrorContent,
} from "../../src/bruno/errors.js";

describe("BrunoMcpError", () => {
  it.each(BRUNO_MCP_ERROR_CODES)(
    "maps %s to stable MCP error content",
    (code) => {
      const error = new BrunoMcpError(code, `Message for ${code}`, {
        cause: new Error("internal detail"),
      });

      expect(toMcpErrorContent(error)).toEqual({
        code,
        message: `Message for ${code}`,
      });
      expect(Object.keys(toMcpErrorContent(error))).toEqual(["code", "message"]);
    },
  );

  it("retains standard Error behavior internally", () => {
    const error = new BrunoMcpError("INVALID_YAML", "Invalid document");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("BrunoMcpError");
    expect(error.code).toBe("INVALID_YAML");
    expect(error.stack).toContain("Invalid document");
  });
});
