/**
 * Well-known OpenCollection filenames and exclusions used when classifying the
 * files inside a collection (spec §10). Centralizing them here keeps discovery
 * and tool code consistent.
 */

/** Marks a directory as an OpenCollection root. */
export const OPENCOLLECTION_FILE = "opencollection.yml";
/** Collection-level metadata; never a request. */
export const COLLECTION_FILE = "collection.yml";
/** Folder-level metadata; never a request. */
export const FOLDER_FILE = "folder.yml";
/** Directory holding environment definitions; excluded from request discovery. */
export const ENVIRONMENTS_DIR = "environments";
/** Extension used by all OpenCollection YAML files. */
export const YAML_EXTENSION = ".yml";

/**
 * Filenames that are collection/folder metadata and must never be treated as
 * requests (spec §10 exclusions).
 */
export const COLLECTION_METADATA_FILES: ReadonlySet<string> = new Set([
  OPENCOLLECTION_FILE,
  COLLECTION_FILE,
  FOLDER_FILE,
]);

/** Whether a file name uses the OpenCollection YAML extension. */
export function isYamlFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(YAML_EXTENSION);
}

/** Whether a file name is collection/folder metadata rather than a request. */
export function isCollectionMetadataFile(fileName: string): boolean {
  return COLLECTION_METADATA_FILES.has(fileName);
}

/** Whether a directory name is the reserved environments directory. */
export function isEnvironmentsDir(dirName: string): boolean {
  return dirName === ENVIRONMENTS_DIR;
}
