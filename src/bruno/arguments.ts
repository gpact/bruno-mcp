/**
 * Pure translation from semantic `bruno_run` parameters into an exact `bru run`
 * argument array.
 *
 * Nothing is spawned here. Isolating argument construction keeps the
 * security-critical translation deterministic and exhaustively unit-testable,
 * and guarantees user-provided values always stay separate process arguments
 * rather than being folded into a shell string.
 */

import { lstatSync } from "node:fs";
import { join } from "node:path";

import type { Config } from "../config/config.js";
import { ENVIRONMENTS_DIR, YAML_EXTENSION } from "../opencollection/paths.js";
import { resolveWithinCollection } from "../security/paths.js";
import { BrunoMcpError } from "./errors.js";

/** JavaScript sandbox modes Bruno v4 exposes for a run. */
export type SandboxMode = "safe" | "developer";

/**
 * Semantic parameters for a single `bru run` invocation, mirroring the
 * `bruno_run` tool input. These express the caller's intent; the builder itself
 * performs no policy checks (see {@link buildRunArgs}).
 */
export interface RunArgsParams {
  /** Collection identifier: the collection root path relative to the root. */
  collection: string;
  /** Request files or folders to run; empty runs the whole collection. */
  targets?: string[];
  /** Environment name to select for the run. */
  environment?: string;
  /** Non-secret environment variable overrides applied for this run. */
  variables?: Record<string, string>;
  /** Stop after the first failing request, test, or assertion. */
  bail?: boolean;
  /** Only run requests that carry a test or an active assertion. */
  testsOnly?: boolean;
  /** Delay between requests, in milliseconds. */
  delayMs?: number;
  /** Requested JavaScript sandbox. Developer mode must be pre-authorized. */
  sandbox?: SandboxMode;
  /** Allow insecure TLS. Must be pre-authorized. */
  insecure?: boolean;
}

/** Ambient inputs the builder needs beyond the semantic parameters. */
export interface BuildRunArgsContext {
  /** Absolute path the JSON reporter must be written to. */
  reportPath: string;
  /** Validated runtime configuration; only {@link Config.root} is consulted. */
  config: Config;
}

/** The sandbox value that must translate into a developer-mode flag. */
const DEVELOPER_SANDBOX: SandboxMode = "developer";

/**
 * Characters forbidden in a variable name. A NUL, newline, or carriage return
 * could break argument framing or smuggle control bytes into the child process,
 * so names carrying them are rejected. No other restriction is imposed: any
 * name Bruno itself accepts is passed through unchanged.
 */
const FORBIDDEN_NAME_CHARS = /[\0\n\r]/;

/** Leading token Bruno's argument parser treats as an option, never a path. */
const OPTION_PREFIX = "-";

/** Matches a path separator (POSIX or Windows) inside an environment name. */
const PATH_SEPARATOR = /[\\/]/;

/**
 * Whether `value` contains any C0 control character (U+0000-U+001F) or DEL
 * (U+007F). Such bytes could break argument framing, smuggle control sequences
 * into the child process, or corrupt diagnostics, so tokens carrying them are
 * rejected. This is a code-point scan rather than a control-character regex so
 * the intent stays explicit.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }

  return false;
}

/** Whether an existing path is a symbolic link. Missing paths are not links. */
function isExistingSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return false;
    }

    throw error;
  }
}

/**
 * Validate a single run target so it can only ever act as a collection-relative
 * request or folder path, never as a Bruno CLI option.
 *
 * Bruno parses its run arguments with yargs, which classifies any token that
 * begins with "-" as an option regardless of position, and does not bind
 * operands that follow a "--" terminator to the variadic `paths` positional
 * (they are silently dropped, expanding the run to the whole collection). A
 * "--" terminator therefore cannot force an option-like token to be treated as
 * data, so such a target is rejected outright. The resolved location is then
 * confirmed to stay within the collection root, symlinks included.
 *
 * @throws {BrunoMcpError} `INVALID_TARGET` when the target is empty, carries a
 *   control character, or begins with "-".
 * @throws {BrunoMcpError} `PATH_OUTSIDE_ROOT` when the target escapes the
 *   collection root via traversal, an absolute path, or a symlink.
 */
function assertRunnableTarget(
  root: string,
  collection: string,
  target: string,
): void {
  if (target.length === 0) {
    throw new BrunoMcpError("INVALID_TARGET", "A run target must not be empty.");
  }

  if (hasControlCharacter(target)) {
    throw new BrunoMcpError(
      "INVALID_TARGET",
      `Run target ${JSON.stringify(target)} must not contain control characters.`,
    );
  }

  if (target.startsWith(OPTION_PREFIX)) {
    throw new BrunoMcpError(
      "INVALID_TARGET",
      `Run target ${JSON.stringify(target)} must be a collection-relative request or folder path, not an option.`,
    );
  }

  // Verify containment against the collection root before the value is ever
  // handed to Bruno. Targets may be request files or folders, so no suffix is
  // required; only the resolved location matters.
  resolveWithinCollection(root, collection, target);
}

/**
 * Reduce an environment reference to the bare name Bruno expects for `--env`,
 * rejecting anything that could select a file outside the collection's
 * `environments/` directory.
 *
 * Bruno resolves `--env <name>` to `<collection>/environments/<name>.yml`, so a
 * name carrying path separators or dot segments could traverse elsewhere. A
 * bare name (`Local`) and the collection-relative forms (`Local.yml`,
 * `environments/Local.yml`) all reduce to the same name; every other shape is
 * rejected. The resolved file is finally confirmed to stay within the
 * collection root. Existing environment directories and files must be direct
 * filesystem entries rather than symbolic links.
 *
 * @throws {BrunoMcpError} `INVALID_ENVIRONMENT_NAME` when the reference is
 *   empty, carries a control character, contains a path separator or dot
 *   segment, or selects a symbolic link.
 * @throws {BrunoMcpError} `PATH_OUTSIDE_ROOT` when the resolved environment file
 *   escapes the collection root (for example via a symlink).
 */
function resolveEnvironmentName(
  root: string,
  collection: string,
  reference: string,
): string {
  if (hasControlCharacter(reference)) {
    throw new BrunoMcpError(
      "INVALID_ENVIRONMENT_NAME",
      `Environment name ${JSON.stringify(reference)} must not contain control characters.`,
    );
  }

  let name = reference.trim();

  const prefix = `${ENVIRONMENTS_DIR}/`;
  if (name.startsWith(prefix)) {
    name = name.slice(prefix.length);
  }
  if (name.toLowerCase().endsWith(YAML_EXTENSION)) {
    name = name.slice(0, -YAML_EXTENSION.length);
  }

  if (name.length === 0) {
    throw new BrunoMcpError(
      "INVALID_ENVIRONMENT_NAME",
      "An environment name must not be empty.",
    );
  }

  if (PATH_SEPARATOR.test(name) || name === "." || name === "..") {
    throw new BrunoMcpError(
      "INVALID_ENVIRONMENT_NAME",
      `Environment ${JSON.stringify(reference)} must be a single environment name without path separators or dot segments.`,
    );
  }

  const fileName = `${name}${YAML_EXTENSION}`;
  const relativePath = `${ENVIRONMENTS_DIR}/${fileName}`;
  const collectionRoot = resolveWithinCollection(root, collection, ".");
  const environmentsPath = join(collectionRoot, ENVIRONMENTS_DIR);
  if (
    isExistingSymbolicLink(environmentsPath) ||
    isExistingSymbolicLink(join(environmentsPath, fileName))
  ) {
    throw new BrunoMcpError(
      "INVALID_ENVIRONMENT_NAME",
      `Environment ${JSON.stringify(reference)} must identify a direct environment file, not a symbolic link.`,
    );
  }

  resolveWithinCollection(root, collection, relativePath);

  return name;
}

/**
 * Translate semantic run parameters into the argument array for `bru run`.
 *
 * Ordering mirrors the canonical Bruno invocation: targets, environment,
 * variable overrides, behavioral flags, then the JSON reporter path last. The
 * result is always a plain `string[]`; a shell string is never produced.
 *
 * Policy contract: developer sandbox and insecure TLS are gated by the run tool
 * before this builder is called. The builder assumes an already-authorized
 * request and simply emits the matching flags; it never consults the
 * `allowDeveloperSandbox` or `allowInsecure` configuration itself.
 *
 * @throws {BrunoMcpError} `INVALID_TARGET` when a target is empty, carries a
 *   control character, or begins with "-" (which Bruno would parse as an
 *   option).
 * @throws {BrunoMcpError} `INVALID_ENVIRONMENT_NAME` when the environment
 *   reference is empty, carries a control character, or contains a path
 *   separator or dot segment, or selects a symbolic link.
 * @throws {BrunoMcpError} `PATH_OUTSIDE_ROOT` when a target or the resolved
 *   environment file escapes the collection root via traversal, an absolute
 *   path, or a symlink.
 * @throws {BrunoMcpError} `INVALID_VARIABLE_NAME` when a variable name contains
 *   a NUL, newline, or carriage return.
 */
export function buildRunArgs(
  params: RunArgsParams,
  context: BuildRunArgsContext,
): string[] {
  const args: string[] = [];

  for (const target of params.targets ?? []) {
    assertRunnableTarget(context.config.root, params.collection, target);
    args.push(target);
  }

  if (params.environment !== undefined) {
    const environment = resolveEnvironmentName(
      context.config.root,
      params.collection,
      params.environment,
    );
    args.push(`--env=${environment}`);
  }

  for (const [name, value] of Object.entries(params.variables ?? {})) {
    if (FORBIDDEN_NAME_CHARS.test(name)) {
      throw new BrunoMcpError(
        "INVALID_VARIABLE_NAME",
        `Environment variable name ${JSON.stringify(name)} must not contain NUL, newline, or carriage return characters.`,
      );
    }
    // Bind the pair to its option so an option-like variable name remains data.
    args.push(`--env-var=${name}=${value}`);
  }

  if (params.bail) {
    args.push("--bail");
  }

  if (params.testsOnly) {
    args.push("--tests-only");
  }

  if (params.delayMs !== undefined) {
    args.push("--delay", String(params.delayMs));
  }

  if (params.sandbox === DEVELOPER_SANDBOX) {
    args.push("--sandbox", DEVELOPER_SANDBOX);
  }

  if (params.insecure) {
    args.push("--insecure");
  }

  args.push("--reporter-json", context.reportPath);

  return args;
}
