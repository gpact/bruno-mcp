import { describe, expect, it } from "vitest";

import { runBruCommand } from "../../src/bruno/cli.js";

describe("runBruCommand", () => {
  it("executes a real binary and captures its stdout", async () => {
    // Use the running Node binary as a stand-in executable to prove the seam
    // spawns a process directly and returns its output.
    const result = await runBruCommand(process.execPath, ["--version"]);

    expect(result.stdout.trim()).toBe(process.version);
    expect(result.exitCode).toBe(0);
  });

  it("does not interpret arguments through a shell", async () => {
    // If a shell were involved, `$(...)` would be expanded. With shell:false the
    // literal string is passed through and echoed back verbatim.
    const payload = "$(echo pwned) `whoami` && ls";
    const result = await runBruCommand(process.execPath, [
      "-e",
      "process.stdout.write(process.argv[1])",
      payload,
    ]);

    expect(result.stdout).toBe(payload);
  });

  it("captures non-zero exit status without treating it as a spawn failure", async () => {
    const result = await runBruCommand(process.execPath, [
      "-e",
      "process.stderr.write('failed'); process.exit(7)",
    ]);

    expect(result).toEqual({ stdout: "", stderr: "failed", exitCode: 7 });
  });

  it("rejects when the executable cannot be found", async () => {
    await expect(
      runBruCommand("definitely-not-a-real-bru-binary-xyz", ["--version"]),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
