import { describe, expect, it } from "vitest";

import {
  REQUEST_REVISION_PATTERN,
  requestRevision,
} from "../../src/opencollection/revision.js";

describe("requestRevision", () => {
  it("returns a stable canonical 128-bit base64url revision", () => {
    const revision = requestRevision("hello");

    expect(revision).toBe("LPJNul-wow4m6Dsqxbning");
    expect(revision).toMatch(REQUEST_REVISION_PATTERN);
    expect("AAAAAAAAAAAAAAAAAAAAAB").not.toMatch(REQUEST_REVISION_PATTERN);
  });

  it("changes when the exact source changes", () => {
    expect(requestRevision("hello\n")).not.toBe(requestRevision("hello"));
  });
});
