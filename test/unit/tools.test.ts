import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrunoMcpError } from "../../src/bruno/errors.js";
import { loadConfig } from "../../src/config/config.js";
import {
  TOOL_NAMES,
  notImplementedResult,
  registerTools,
  runTool,
  toToolErrorResult,
} from "../../src/tools/index.js";

const config = loadConfig({});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registerTools", () => {
  it("registers every declared tool name exactly once, in order", () => {
    const registered: string[] = [];
    const fakeServer = {
      registerTool(name: string) {
        registered.push(name);
      },
    } as unknown as McpServer;

    registerTools(fakeServer, config);

    expect(registered).toEqual([...TOOL_NAMES]);
  });

  it("exposes the seven required tool names", () => {
    expect([...TOOL_NAMES].sort()).toEqual(
      [
        "bruno_get_environment",
        "bruno_get_request",
        "bruno_list_collections",
        "bruno_list_environments",
        "bruno_list_requests",
        "bruno_run",
        "bruno_search_requests",
      ].sort(),
    );
  });
});

describe("toToolErrorResult", () => {
  it("maps a BrunoMcpError to stable structured error content", () => {
    const result = toToolErrorResult(
      new BrunoMcpError("COLLECTION_NOT_FOUND", "no such collection"),
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      code: "COLLECTION_NOT_FOUND",
      message: "no such collection",
    });
    expect(result.content).toEqual([
      { type: "text", text: "COLLECTION_NOT_FOUND: no such collection" },
    ]);
  });

  it("returns an opaque message for an unknown error and logs the cause", () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const result = toToolErrorResult(new Error("kaboom"));

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toEqual([
      { type: "text", text: "An unexpected error occurred." },
    ]);
    // The real cause is logged to stderr, never forwarded to the client.
    const logged = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(logged).toContain("kaboom");
  });

  it("logs stringified non-Error throwables without leaking them to the client", () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const result = toToolErrorResult("plain string");

    expect(result.content).toEqual([
      { type: "text", text: "An unexpected error occurred." },
    ]);
    const logged = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(logged).toContain("plain string");
  });
});

describe("runTool", () => {
  it("returns the handler result on success", async () => {
    const ok = { content: [{ type: "text" as const, text: "ok" }] };

    await expect(runTool(() => ok)).resolves.toEqual(ok);
  });

  it("awaits async handlers", async () => {
    const ok = { content: [{ type: "text" as const, text: "async" }] };

    await expect(runTool(async () => ok)).resolves.toEqual(ok);
  });

  it("converts a thrown BrunoMcpError into structured error content", async () => {
    const result = await runTool(() => {
      throw new BrunoMcpError("INVALID_YAML", "bad yaml");
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      code: "INVALID_YAML",
      message: "bad yaml",
    });
  });
});

describe("notImplementedResult", () => {
  it("returns an error result naming the tool", () => {
    const result = notImplementedResult("bruno_run");

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "The bruno_run tool is not implemented yet." },
    ]);
  });
});
