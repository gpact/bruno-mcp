import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  startTestHttpServer,
  type TestHttpServer,
} from "./http-server.js";

const fixtureDirectory = fileURLToPath(
  new URL("../fixtures/workspace/example/", import.meta.url),
);

let server: TestHttpServer;

beforeAll(async () => {
  server = await startTestHttpServer({ slowDelayMs: 10 });
});

afterAll(async () => {
  await server.close();
});

describe("integration fixture", () => {
  it("contains the complete OpenCollection tree", async () => {
    const fixtureFiles = [
      "opencollection.yml",
      "environments/Local.yml",
      "Health.yml",
      "Failure.yml",
      "Slow.yml",
      "Users/folder.yml",
      "Users/Get User.yml",
    ];

    await expect(
      Promise.all(fixtureFiles.map((path) => access(`${fixtureDirectory}${path}`))),
    ).resolves.toBeDefined();
  });

  it("serves all local test endpoints", async () => {
    const health = await fetch(`${server.baseUrl}/health`);
    const failure = await fetch(`${server.baseUrl}/failure`);
    const authEcho = await fetch(`${server.baseUrl}/auth-echo`, {
      headers: { authorization: "Bearer integration-test-secret" },
    });
    const slow = await fetch(`${server.baseUrl}/slow`);

    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: "ok" });
    expect(failure.status).toBe(200);
    await expect(failure.json()).resolves.toEqual({ value: "actual" });
    expect(authEcho.status).toBe(200);
    await expect(authEcho.json()).resolves.toEqual({
      authorization: "Bearer integration-test-secret",
    });
    expect(slow.status).toBe(200);
    await expect(slow.json()).resolves.toEqual({ status: "delayed" });
  });
});
