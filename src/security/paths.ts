/**
 * Security-critical path resolution helpers.
 *
 * Every collection, request, environment, and execution path handled by the
 * server must ultimately resolve **beneath** `BRUNO_MCP_ROOT` (and, for
 * collection-relative inputs, beneath the relevant collection root). These
 * helpers defend against:
 *
 * - `../` traversal (e.g. `../../secret.yml`),
 * - absolute-path escapes (e.g. `/etc/passwd`),
 * - symlink escapes (e.g. `hotel/escape -> /etc` accessed via `escape/passwd`).
 *
 * Containment is verified on **canonical** paths (symlinks resolved via
 * `realpath()`), never on raw user input, and never by string-prefix checking
 * alone.
 */

import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";

import { BrunoMcpError } from "../bruno/errors.js";

/**
 * Resolve `candidate` (relative to `root`) to a canonical absolute path,
 * guaranteeing the result stays beneath the canonical `root`.
 *
 * The `candidate` may be relative (the common case) or absolute; either way the
 * fully resolved, symlink-canonicalized target must live inside `root`. When the
 * target does not yet exist, the nearest existing ancestor is canonicalized and
 * the remaining segments are re-attached before the containment check, so a
 * symlinked ancestor cannot smuggle the path outside the root.
 *
 * @throws {BrunoMcpError} with code `PATH_OUTSIDE_ROOT` when the candidate
 *   escapes the root via traversal, an absolute path, or a symlink.
 */
export function resolveWithinRoot(root: string, candidate: string): string {
  const canonicalRoot = canonicalize(resolve(root));
  const target = canonicalize(resolve(canonicalRoot, candidate));

  if (!isWithin(canonicalRoot, target)) {
    throw new BrunoMcpError(
      "PATH_OUTSIDE_ROOT",
      `Path "${candidate}" resolves outside the permitted root`,
    );
  }

  return target;
}

/**
 * Resolve `candidate` beneath a specific collection root, which must itself live
 * beneath `root`. Used for request/environment paths expressed relative to a
 * collection.
 *
 * @param root - The `BRUNO_MCP_ROOT` boundary.
 * @param collectionRoot - The collection root, either absolute or relative to
 *   `root` (e.g. a collection's relative identifier such as `"hotel"`).
 * @param candidate - The path to resolve, relative to the collection root.
 * @throws {BrunoMcpError} `PATH_OUTSIDE_ROOT` when either the collection root
 *   escapes `root` or the candidate escapes the collection root.
 */
export function resolveWithinCollection(
  root: string,
  collectionRoot: string,
  candidate: string,
): string {
  const canonicalCollectionRoot = resolveWithinRoot(root, collectionRoot);
  const target = resolveWithinRoot(canonicalCollectionRoot, candidate);

  // Defense in depth: containment beneath the collection root already implies
  // containment beneath the (ancestor) root, but assert it explicitly since the
  // invariant is security-critical.
  if (!isWithin(canonicalize(resolve(root)), target)) {
    throw new BrunoMcpError(
      "PATH_OUTSIDE_ROOT",
      `Path "${candidate}" resolves outside the permitted root`,
    );
  }

  return target;
}

/**
 * Convert an absolute path to one relative to `root`, for reporting through MCP
 * (spec §11: collections, requests, and environments must be reported relative,
 * never as unnecessary absolute filesystem paths).
 *
 * The relative form uses POSIX (`/`) separators so identifiers are stable and
 * can be re-resolved with {@link resolveWithinRoot}. Returns `"."` when
 * `absolutePath` is the root itself.
 *
 * @throws {BrunoMcpError} `PATH_OUTSIDE_ROOT` when `absolutePath` is not beneath
 *   `root`.
 */
export function relativeToRoot(root: string, absolutePath: string): string {
  const canonicalRoot = canonicalize(resolve(root));
  const target = canonicalize(resolve(absolutePath));

  if (!isWithin(canonicalRoot, target)) {
    throw new BrunoMcpError(
      "PATH_OUTSIDE_ROOT",
      `Path "${absolutePath}" is not beneath the permitted root`,
    );
  }

  const rel = relative(canonicalRoot, target);
  if (rel === "") {
    return ".";
  }

  return sep === "/" ? rel : rel.split(sep).join("/");
}

/**
 * Return the canonical (symlink-resolved) form of an already-resolved absolute
 * `target`. When `target` does not exist, walk up to the nearest existing
 * ancestor, canonicalize it, and re-attach the remaining (non-existent)
 * segments. Existing symlinks are followed explicitly, including broken
 * symlinks whose destinations do not exist yet. This ensures a symlinked
 * ancestor is followed before the caller's containment check runs.
 *
 * `target` is expected to be normalized (as produced by {@link resolve}), so it
 * contains no `.`/`..` segments and the ancestor walk is a plain segment strip.
 */
function canonicalize(
  target: string,
  followedSymlinks = new Set<string>(),
): string {
  const trailing: string[] = [];
  let current = target;

  for (;;) {
    try {
      const real = realpathSync(current);
      return resolve(real, ...trailing);
    } catch (realpathError) {
      const stats = lstatIfPresent(current);
      if (stats?.isSymbolicLink()) {
        if (followedSymlinks.has(current)) {
          throw realpathError;
        }

        followedSymlinks.add(current);
        const linkTarget = resolve(dirname(current), readlinkSync(current));
        return canonicalize(
          resolve(linkTarget, ...trailing),
          followedSymlinks,
        );
      }

      if (stats !== undefined) {
        throw realpathError;
      }

      const parent = dirname(current);
      if (parent === current) {
        throw realpathError;
      }
      trailing.unshift(basename(current));
      current = parent;
    }
  }
}

function lstatIfPresent(target: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(target);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return undefined;
    }

    throw error;
  }
}

/**
 * Segment-aware containment check for two canonical paths: is `target` equal to
 * `root` or nested beneath it? Appending the separator prevents a sibling like
 * `/root-evil` from matching the root `/root`.
 */
function isWithin(root: string, target: string): boolean {
  if (target === root) {
    return true;
  }
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(rootWithSep);
}
