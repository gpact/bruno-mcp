import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ProcessSpawner,
  runBruProcess,
} from "../../src/bruno/cli.js";
import { BrunoMcpError } from "../../src/bruno/errors.js";

/** Minimal structural stand-in for the child process the runner consumes. */
type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (signal?: NodeJS.Signals | number) => boolean;
};

interface FakeSpawnOptions {
  readonly cwd?: string;
  readonly shell?: boolean;
  readonly windowsHide?: boolean;
}

interface SpawnCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: FakeSpawnOptions;
}

function baseFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

/**
 * Build a fake spawn whose child closes with a fixed exit code, optionally
 * recording each invocation so a test can assert the spawn options.
 */
function fakeSpawnClose(exitCode: number, calls?: SpawnCall[]): ProcessSpawner {
  const fn = vi.fn(
    (file: string, args: readonly string[], options: FakeSpawnOptions) => {
      calls?.push({ file, args, options });
      const child = baseFakeChild();
      queueMicrotask(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit("close", exitCode, null);
      });
      return child;
    },
  );
  return fn as unknown as ProcessSpawner;
}

/**
 * Build a fake spawn whose child never exits on its own and only closes once it
 * is killed, recording the signals it received.
 */
function fakeSpawnHang(signals: (NodeJS.Signals | number | undefined)[]): ProcessSpawner {
  const fn = vi.fn(() => {
    const child = baseFakeChild();
    child.kill = (signal?: NodeJS.Signals | number) => {
      signals.push(signal);
      if (signals.length === 1) {
        queueMicrotask(() =>
          child.emit(
            "close",
            null,
            typeof signal === "string" ? signal : "SIGTERM",
          ),
        );
      }
      return true;
    };
    return child;
  });
  return fn as unknown as ProcessSpawner;
}

/** Build a fake spawn whose child fails to start by emitting an `error`. */
function fakeSpawnError(error: NodeJS.ErrnoException): ProcessSpawner {
  const fn = vi.fn(() => {
    const child = baseFakeChild();
    queueMicrotask(() => child.emit("error", error));
    return child;
  });
  return fn as unknown as ProcessSpawner;
}

/** A temp-dir factory that records every unique directory it hands out. */
function capturingTempDir(): {
  dirs: string[];
  makeTempDir: () => Promise<string>;
} {
  const dirs: string[] = [];
  const makeTempDir = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "bruno-mcp-run-"));
    dirs.push(dir);
    return dir;
  };
  return { dirs, makeTempDir };
}

// Fake bru implementations executed by the real Node binary so the tests
// exercise the actual spawn/pipe/timeout machinery rather than a stub.
const SCRIPT_WRITE_REPORT = [
  "const fs = require('node:fs');",
  "fs.writeFileSync(process.argv[1], JSON.stringify({ ok: true }));",
  "process.stdout.write(process.cwd());",
  "process.stderr.write('diag');",
].join("\n");

const SCRIPT_FAIL_NO_REPORT = [
  "process.stderr.write('boom');",
  "process.exit(4);",
].join("\n");

const SCRIPT_ECHO_ARGV = "process.stdout.write(JSON.stringify(process.argv.slice(2)));";

const SCRIPT_HANG = "setInterval(() => {}, 1000);";

let collectionRoot: string;

beforeEach(() => {
  collectionRoot = realpathSync(
    mkdtempSync(join(tmpdir(), "bruno-mcp-cwd-")),
  );
});

afterEach(() => {
  rmSync(collectionRoot, { recursive: true, force: true });
});

describe("runBruProcess process creation", () => {
  it("spawns without a shell, in the collection root, with the reporter path", async () => {
    const calls: SpawnCall[] = [];
    const reportPaths: string[] = [];
    const removeTempDir = vi.fn(async () => {});
    const tempDir = "/fake/unique/temp-dir";

    await runBruProcess({
      binary: "bru",
      collectionRoot,
      timeoutMs: 1_000,
      buildArgs: (reportPath) => {
        reportPaths.push(reportPath);
        return ["run", "--reporter-json", reportPath];
      },
      spawn: fakeSpawnClose(0, calls),
      makeTempDir: async () => tempDir,
      removeTempDir,
    });

    const expectedReportPath = join(tempDir, "report.json");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe("bru");
    expect(calls[0]!.options).toMatchObject({
      cwd: collectionRoot,
      shell: false,
      windowsHide: true,
    });
    expect(calls[0]!.args).toEqual([
      "run",
      "--reporter-json",
      expectedReportPath,
    ]);
    // The reporter path the builder is handed lives inside the runner's unique
    // temp dir and is always named report.json.
    expect(reportPaths[0]).toBe(expectedReportPath);
    expect(basename(reportPaths[0]!)).toBe("report.json");
    expect(removeTempDir).toHaveBeenCalledWith(tempDir);
  });

  it("creates a unique temp directory per run and removes each afterwards", async () => {
    const { dirs, makeTempDir } = capturingTempDir();

    const run = () =>
      runBruProcess({
        binary: "bru",
        collectionRoot,
        timeoutMs: 1_000,
        buildArgs: (reportPath) => ["run", "--reporter-json", reportPath],
        spawn: fakeSpawnClose(0),
        makeTempDir,
      });

    await run();
    await run();

    expect(dirs).toHaveLength(2);
    expect(dirs[0]).not.toBe(dirs[1]);
    for (const dir of dirs) {
      expect(existsSync(dir)).toBe(false);
    }
  });
});

describe("runBruProcess result capture", () => {
  it("captures exit code, stdout, and the report file when present", async () => {
    const { dirs, makeTempDir } = capturingTempDir();

    const result = await runBruProcess({
      binary: process.execPath,
      collectionRoot,
      timeoutMs: 5_000,
      buildArgs: (reportPath) => ["-e", SCRIPT_WRITE_REPORT, reportPath],
      makeTempDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(collectionRoot);
    expect(result.stderr).toBe("diag");
    expect(result.reportRaw).toBeDefined();
    expect(JSON.parse(result.reportRaw!)).toEqual({ ok: true });
    expect(result.reportPath).toBe(join(dirs[0]!, "report.json"));
    // Temp directory removed after a successful run.
    expect(existsSync(dirs[0]!)).toBe(false);
  });

  it("captures a non-zero exit and omits the report when none is written", async () => {
    const { dirs, makeTempDir } = capturingTempDir();

    const result = await runBruProcess({
      binary: process.execPath,
      collectionRoot,
      timeoutMs: 5_000,
      buildArgs: (reportPath) => ["-e", SCRIPT_FAIL_NO_REPORT, reportPath],
      makeTempDir,
    });

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toBe("boom");
    expect(result.reportRaw).toBeUndefined();
    expect("reportRaw" in result).toBe(false);
    // Temp directory removed even though the run failed.
    expect(existsSync(dirs[0]!)).toBe(false);
  });

  it("passes user arguments through verbatim, never via a shell", async () => {
    const payload = ["$(echo pwned)", "`whoami`", "&&", "ls", "|", "cat"];

    const result = await runBruProcess({
      binary: process.execPath,
      collectionRoot,
      timeoutMs: 5_000,
      buildArgs: (reportPath) => ["-e", SCRIPT_ECHO_ARGV, reportPath, ...payload],
      makeTempDir: () => mkdtemp(join(tmpdir(), "bruno-mcp-run-")),
    });

    expect(JSON.parse(result.stdout)).toEqual(payload);
  });
});

describe("runBruProcess timeout handling", () => {
  it("terminates a real child and surfaces EXECUTION_TIMEOUT, cleaning up", async () => {
    const { dirs, makeTempDir } = capturingTempDir();

    let caught: unknown;
    try {
      await runBruProcess({
        binary: process.execPath,
        collectionRoot,
        timeoutMs: 100,
        buildArgs: (reportPath) => ["-e", SCRIPT_HANG, reportPath],
        makeTempDir,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BrunoMcpError);
    expect((caught as BrunoMcpError).code).toBe("EXECUTION_TIMEOUT");
    expect(existsSync(dirs[0]!)).toBe(false);
  });

  it("signals the child with SIGTERM on timeout", async () => {
    const signals: (NodeJS.Signals | number | undefined)[] = [];
    const { dirs, makeTempDir } = capturingTempDir();

    let caught: unknown;
    try {
      await runBruProcess({
        binary: "bru",
        collectionRoot,
        timeoutMs: 10,
        buildArgs: (reportPath) => ["run", "--reporter-json", reportPath],
        spawn: fakeSpawnHang(signals),
        makeTempDir,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BrunoMcpError);
    expect((caught as BrunoMcpError).code).toBe("EXECUTION_TIMEOUT");
    expect(signals[0]).toBe("SIGTERM");
    expect(existsSync(dirs[0]!)).toBe(false);
  });
});

describe("runBruProcess spawn failure", () => {
  it("rejects with the underlying error and still removes the temp directory", async () => {
    const { dirs, makeTempDir } = capturingTempDir();
    const spawnError: NodeJS.ErrnoException = Object.assign(
      new Error("spawn bru ENOENT"),
      { code: "ENOENT" },
    );

    let caught: unknown;
    try {
      await runBruProcess({
        binary: "bru",
        collectionRoot,
        timeoutMs: 1_000,
        buildArgs: (reportPath) => ["run", "--reporter-json", reportPath],
        spawn: fakeSpawnError(spawnError),
        makeTempDir,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(spawnError);
    expect(existsSync(dirs[0]!)).toBe(false);
  });
});
