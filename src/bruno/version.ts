import { BrunoMcpError } from "./errors.js";
import {
  type BruCommandResult,
  type BruCommandRunner,
  runBruCommand,
} from "./cli.js";

/**
 * Inclusive lower bound of the supported Bruno CLI version range.
 */
export const MIN_BRUNO_VERSION = "4.0.0";
/**
 * Exclusive upper bound of the supported Bruno CLI version range.
 */
export const MAX_BRUNO_VERSION_EXCLUSIVE = "5.0.0";

/**
 * Shared first line of the actionable version errors.
 */
const REQUIREMENT_MESSAGE =
  `Bruno MCP requires Bruno CLI >= ${MIN_BRUNO_VERSION} and ` +
  `< ${MAX_BRUNO_VERSION_EXCLUSIVE}.`;

/**
 * A parsed semantic version and its optional metadata.
 */
export interface BrunoVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: string | null;
  readonly build: string | null;
  /** The complete semantic-version token matched in the CLI output. */
  readonly raw: string;
}

type NumericVersion = Pick<BrunoVersion, "major" | "minor" | "patch">;

const MIN: NumericVersion = { major: 4, minor: 0, patch: 0 };
const MAX_EXCLUSIVE: NumericVersion = {
  major: 5,
  minor: 0,
  patch: 0,
};

function compare(a: NumericVersion, b: NumericVersion): number {
  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }
  return a.patch - b.patch;
}

/**
 * Extract the first complete semantic-version token from arbitrary CLI output.
 * Returns `null` when no valid token is present (garbled output).
 */
export function parseBrunoVersion(output: string): BrunoVersion | null {
  const numericIdentifier = "(?:0|[1-9]\\d*)";
  const prereleaseIdentifier =
    "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
  const match = new RegExp(
    `(?<![0-9A-Za-z.+-])(${numericIdentifier})\\.` +
      `(${numericIdentifier})\\.(${numericIdentifier})` +
      `(?:-(${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*))?` +
      `(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?` +
      `(?![0-9A-Za-z.+-])`,
  ).exec(output);
  if (match === null) {
    return null;
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return null;
  }

  return {
    major,
    minor,
    patch,
    prerelease: match[4] ?? null,
    build: match[5] ?? null,
    raw: match[0],
  };
}

/**
 * Whether a parsed version falls within `>= 4.0.0 && < 5.0.0`.
 */
export function isSupportedBrunoVersion(version: BrunoVersion): boolean {
  return (
    version.prerelease === null &&
    compare(version, MIN) >= 0 &&
    compare(version, MAX_EXCLUSIVE) < 0
  );
}

function isExecutableUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  return ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code));
}

/**
 * Options for {@link validateBrunoVersion}.
 */
export interface ValidateBrunoVersionOptions {
  /** Path or name of the Bruno CLI executable (config `BRUNO_MCP_BRU`). */
  readonly bru: string;
  /** Injectable command runner; defaults to the real {@link runBruCommand}. */
  readonly run?: BruCommandRunner;
}

/**
 * Discover the Bruno CLI and validate its version at startup.
 *
 * Runs `bru --version` through the injectable {@link BruCommandRunner} (never a
 * shell) and enforces the supported range. Fails fast with an actionable,
 * structured {@link BrunoMcpError}:
 *
 * - `BRUNO_NOT_FOUND` when the executable cannot be run.
 * - `UNSUPPORTED_BRUNO_VERSION` when the reported version is out of range or no
 *   version can be parsed from the output.
 *
 * @returns the detected, supported {@link BrunoVersion}.
 */
export async function validateBrunoVersion(
  options: ValidateBrunoVersionOptions,
): Promise<BrunoVersion> {
  const run = options.run ?? runBruCommand;

  let result: BruCommandResult;
  try {
    result = await run(options.bru, ["--version"]);
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    if (isExecutableUnavailable(error)) {
      throw new BrunoMcpError(
        "BRUNO_NOT_FOUND",
        `Could not run the Bruno CLI executable "${options.bru}". Ensure Bruno ` +
          `CLI (>= ${MIN_BRUNO_VERSION} and < ${MAX_BRUNO_VERSION_EXCLUSIVE}) is ` +
          `installed and that BRUNO_MCP_BRU points to it.`,
        { cause },
      );
    }

    throw new BrunoMcpError(
      "UNSUPPORTED_BRUNO_VERSION",
      `${REQUIREMENT_MESSAGE}\nThe Bruno CLI version check failed.`,
      { cause },
    );
  }

  const output = `${result.stdout}\n${result.stderr}`;
  if (result.exitCode !== 0) {
    const detected = parseBrunoVersion(output);
    const suffix =
      detected === null
        ? `The version command exited with status ${result.exitCode}.`
        : `Detected version: ${detected.raw}. The version command exited ` +
          `with status ${result.exitCode}.`;
    throw new BrunoMcpError(
      "UNSUPPORTED_BRUNO_VERSION",
      `${REQUIREMENT_MESSAGE}\n${suffix}`,
    );
  }

  const version = parseBrunoVersion(output);
  if (version === null) {
    throw new BrunoMcpError(
      "UNSUPPORTED_BRUNO_VERSION",
      `${REQUIREMENT_MESSAGE}\nCould not detect a version from the Bruno CLI output.`,
    );
  }

  if (!isSupportedBrunoVersion(version)) {
    throw new BrunoMcpError(
      "UNSUPPORTED_BRUNO_VERSION",
      `${REQUIREMENT_MESSAGE}\nDetected version: ${version.raw}.`,
    );
  }

  return version;
}
