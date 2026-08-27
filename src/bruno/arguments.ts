/**
 * Pure translation from semantic `bruno_run` parameters into an exact `bru run`
 * argument array.
 *
 * Nothing is spawned here. Isolating argument construction keeps the
 * security-critical translation deterministic and exhaustively unit-testable,
 * and guarantees user-provided values always stay separate process arguments
 * rather than being folded into a shell string.
 */

import type { Config } from "../config/config.js";
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
 * @throws {BrunoMcpError} `PATH_OUTSIDE_ROOT` when a target escapes the
 *   collection root via traversal, an absolute path, or a symlink.
 * @throws {BrunoMcpError} `INVALID_VARIABLE_NAME` when a variable name contains
 *   a NUL, newline, or carriage return.
 */
export function buildRunArgs(
  params: RunArgsParams,
  context: BuildRunArgsContext,
): string[] {
  const args: string[] = [];

  for (const target of params.targets ?? []) {
    // Verify containment against the collection root before the value is ever
    // handed to Bruno. Targets may be request files or folders, so no suffix is
    // required; only the resolved location matters.
    resolveWithinCollection(context.config.root, params.collection, target);
    args.push(target);
  }

  if (params.environment) {
    args.push("--env", params.environment);
  }

  for (const [name, value] of Object.entries(params.variables ?? {})) {
    if (FORBIDDEN_NAME_CHARS.test(name)) {
      throw new BrunoMcpError(
        "INVALID_VARIABLE_NAME",
        `Environment variable name ${JSON.stringify(name)} must not contain NUL, newline, or carriage return characters.`,
      );
    }
    // Flag and pair are separate entries; the pair is never split further, so a
    // value containing "=" stays intact.
    args.push("--env-var", `${name}=${value}`);
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
