import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrunoMcpError } from "./errors.js";

/**
 * Captured output of a completed Bruno CLI invocation.
 */
export interface BruCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Runs the Bruno CLI executable with a fixed argument array and resolves with
 * its captured output and exit status. Rejects only when the process cannot
 * produce a normal exit status, such as when it cannot be spawned.
 *
 * This is the injectable seam used by higher-level modules (e.g. version
 * validation and, later, the run tool) so that spawning can be mocked in unit
 * tests without touching the real filesystem or a real `bru` binary.
 */
export type BruCommandRunner = (
  file: string,
  args: readonly string[],
) => Promise<BruCommandResult>;

/**
 * Default {@link BruCommandRunner} backed by `child_process.execFile`.
 *
 * The executable and every argument are passed as a discrete array with
 * `shell: false` so nothing is ever interpolated into, or interpreted by, a
 * shell. `windowsHide` avoids flashing a console window.
 */
export const runBruCommand: BruCommandRunner = (file, args) =>
  new Promise<BruCommandResult>((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr, exitCode: 0 });
          return;
        }

        if (typeof error.code === "number") {
          resolve({ stdout, stderr, exitCode: error.code });
          return;
        }

        reject(error);
      },
    );
  });

/** Filename of the JSON report Bruno writes inside the per-run temp directory. */
const REPORT_FILENAME = "report.json";

/**
 * Prefix for the per-run temporary directory. `mkdtemp` appends random
 * characters, so the final name is always unique and never derived from any
 * user-controlled value.
 */
const TEMP_DIR_PREFIX = "bruno-mcp-";

/**
 * Grace period, in milliseconds, between the polite SIGTERM sent on timeout and
 * the forceful SIGKILL used if the child ignores it.
 */
const TERMINATION_GRACE_MS = 2_000;

/**
 * Injectable `spawn`, defaulting to `child_process.spawn`. Tests can substitute
 * a fake to observe how the child process is created.
 */
export type ProcessSpawner = typeof spawn;

/**
 * Options for a single `bru run` execution.
 */
export interface RunBruProcessOptions {
  /**
   * Path or name of the Bruno CLI executable (config `BRUNO_MCP_BRU`). Passed to
   * `spawn` as the program to run; never interpolated into a shell string.
   */
  readonly binary: string;
  /** Working directory for the child process: the collection root. */
  readonly collectionRoot: string;
  /** Per-run execution timeout in milliseconds (config `BRUNO_MCP_TIMEOUT_MS`). */
  readonly timeoutMs: number;
  /**
   * Builds the complete argument array from the reporter path the runner owns.
   *
   * The runner creates a unique temporary directory and derives the reporter
   * path inside it, then calls this to obtain the arguments (which must include
   * `--reporter-json <reportPath>`; see `buildRunArgs` in arguments.ts). Passing
   * a callback keeps the pure argument builder unaware of temp-directory
   * lifecycle while still letting the reporter land in the runner's temp dir.
   */
  readonly buildArgs: (reportPath: string) => readonly string[];
  /** Injectable spawn implementation; defaults to `child_process.spawn`. */
  readonly spawn?: ProcessSpawner;
  /** Injectable unique temp-dir factory; defaults to `mkdtemp` under the OS temp dir. */
  readonly makeTempDir?: () => Promise<string>;
  /** Injectable temp-dir remover; defaults to a recursive, forced `rm`. */
  readonly removeTempDir?: (dir: string) => Promise<void>;
}

/**
 * Raw outcome of a `bru run` execution, before any interpretation of Bruno's
 * report internals.
 */
export interface BruProcessResult {
  /** Process exit code reported by the Bruno CLI. */
  readonly exitCode: number;
  /** Captured standard output. */
  readonly stdout: string;
  /** Captured standard error. */
  readonly stderr: string;
  /** Raw JSON reporter file contents, present only when Bruno produced one. */
  readonly reportRaw?: string;
  /** Path the reporter was requested at, inside the now-removed temp directory. */
  readonly reportPath: string;
}

interface SpawnOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function defaultMakeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
}

function defaultRemoveTempDir(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true });
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

/**
 * Read the reporter file if Bruno produced one. A missing file is expected,
 * since Bruno may exit without writing a report, and yields `undefined` rather
 * than an error.
 */
async function readReportIfPresent(
  reportPath: string,
): Promise<string | undefined> {
  try {
    return await readFile(reportPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Terminate a child on timeout: ask politely with SIGTERM, then escalate to
 * SIGKILL if it lingers. Returns the escalation timer so the caller can cancel
 * it once the child has actually exited.
 */
function terminateChild(child: ChildProcess): NodeJS.Timeout {
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => {
    child.kill("SIGKILL");
  }, TERMINATION_GRACE_MS);
  killTimer.unref();
  return killTimer;
}

/**
 * Spawn the child and resolve once it closes, enforcing the timeout.
 *
 * The child is always spawned with `shell: false` and `cwd` set to the
 * collection root, so user-provided arguments remain discrete process arguments
 * and are never interpreted by a shell. On timeout the child is terminated and
 * the returned promise rejects with `EXECUTION_TIMEOUT` only after the process
 * has actually exited, so the caller can safely remove the temp directory
 * without racing Bruno's writes.
 */
function spawnAndWait(
  spawnImpl: ProcessSpawner,
  binary: string,
  args: readonly string[],
  context: { readonly collectionRoot: string; readonly timeoutMs: number },
): Promise<SpawnOutcome> {
  return new Promise<SpawnOutcome>((resolve, reject) => {
    const child = spawnImpl(binary, [...args], {
      cwd: context.collectionRoot,
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killTimer = terminateChild(child);
    }, context.timeoutMs);
    timeoutTimer.unref();

    const clearTimers = (): void => {
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
    };

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();

      if (timedOut) {
        reject(
          new BrunoMcpError(
            "EXECUTION_TIMEOUT",
            `Bruno execution exceeded the ${context.timeoutMs} ms timeout and was terminated.`,
          ),
        );
        return;
      }

      // A null exit code means the process was killed by a signal rather than
      // exiting normally; map it to the generic "other error" code.
      resolve({ exitCode: code ?? 255, stdout, stderr });
    });
  });
}

/**
 * Execute `bru run` as a child process and return its raw result.
 *
 * Lifecycle for every execution:
 *
 * 1. create a unique temporary directory (never based on user input);
 * 2. derive a JSON reporter path inside it;
 * 3. spawn `bru` with `cwd` = collection root and `shell: false`;
 * 4. read the reporter file if present;
 * 5. return the raw result;
 * 6. remove the temporary directory in a `finally` block, even on failure or
 *    timeout.
 *
 * The result is intentionally uninterpreted: `reportRaw` is the reporter file's
 * bytes as text, not a parsed structure. Normalization, redaction, and output
 * limits belong to later stages.
 *
 * @throws {BrunoMcpError} `EXECUTION_TIMEOUT` when the run exceeds `timeoutMs`.
 */
export async function runBruProcess(
  options: RunBruProcessOptions,
): Promise<BruProcessResult> {
  const spawnImpl = options.spawn ?? spawn;
  const makeTempDir = options.makeTempDir ?? defaultMakeTempDir;
  const removeTempDir = options.removeTempDir ?? defaultRemoveTempDir;

  const tempDir = await makeTempDir();
  try {
    const reportPath = join(tempDir, REPORT_FILENAME);
    const args = options.buildArgs(reportPath);

    const outcome = await spawnAndWait(spawnImpl, options.binary, args, {
      collectionRoot: options.collectionRoot,
      timeoutMs: options.timeoutMs,
    });

    const reportRaw = await readReportIfPresent(reportPath);

    // Only attach reportRaw when Bruno actually produced a report;
    // exactOptionalPropertyTypes forbids an explicit undefined property.
    return reportRaw === undefined
      ? {
          exitCode: outcome.exitCode,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          reportPath,
        }
      : {
          exitCode: outcome.exitCode,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          reportRaw,
          reportPath,
        };
  } finally {
    await removeTempDir(tempDir);
  }
}
