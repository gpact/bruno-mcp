import { execFile } from "node:child_process";

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
 * shell (spec §8, §29). `windowsHide` avoids flashing a console window.
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
