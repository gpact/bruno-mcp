import type { McpServer } from "@modelcontextprotocol/server";

import type { Config } from "../config/config.js";
import { discoverCollections } from "../opencollection/discovery.js";
import { jsonResult, runTool } from "./result.js";

/** MCP tool name. */
export const LIST_COLLECTIONS_TOOL_NAME = "bruno_list_collections";

/** A single collection entry in the {@link bruno_list_collections} output. */
export interface CollectionListItem {
  /** Stable identifier: the collection root path relative to `BRUNO_MCP_ROOT`. */
  id: string;
  /** Human-readable name from `info.name`. */
  name: string;
  /** Declared OpenCollection format version (e.g. `"1.0.0"`). */
  openCollectionVersion: string;
}

/** Output payload of the `bruno_list_collections` tool. */
export interface ListCollectionsOutput {
  collections: CollectionListItem[];
}

/**
 * List every OpenCollection beneath the configured root.
 *
 * The internal `path` field is dropped here since `id` already carries the
 * root-relative location. Discovery returns collections sorted lexicographically
 * by `id`, which this preserves for deterministic output.
 */
export function listCollections(config: Config): ListCollectionsOutput {
  const collections = discoverCollections(config.root).map(
    ({ id, name, openCollectionVersion }) => ({
      id,
      name,
      openCollectionVersion,
    }),
  );

  return { collections };
}

/** Register the `bruno_list_collections` tool. */
export function registerListCollections(server: McpServer, config: Config): void {
  server.registerTool(
    LIST_COLLECTIONS_TOOL_NAME,
    {
      title: "List Bruno collections",
      description:
        "List Bruno OpenCollection collections available in the configured workspace.",
    },
    () => runTool(() => jsonResult({ ...listCollections(config) })),
  );
}
