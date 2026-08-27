import { describe, expect, it } from "vitest";

import {
  COLLECTION_FILE,
  COLLECTION_METADATA_FILES,
  ENVIRONMENTS_DIR,
  FOLDER_FILE,
  OPENCOLLECTION_FILE,
  YAML_EXTENSION,
  isCollectionMetadataFile,
  isEnvironmentsDir,
  isYamlFile,
} from "../../src/opencollection/paths.js";

describe("opencollection paths", () => {
  it("exposes the well-known filenames", () => {
    expect(OPENCOLLECTION_FILE).toBe("opencollection.yml");
    expect(COLLECTION_FILE).toBe("collection.yml");
    expect(FOLDER_FILE).toBe("folder.yml");
    expect(ENVIRONMENTS_DIR).toBe("environments");
    expect(YAML_EXTENSION).toBe(".yml");
  });

  it("groups metadata files that are never requests", () => {
    expect([...COLLECTION_METADATA_FILES].sort()).toEqual(
      [COLLECTION_FILE, FOLDER_FILE, OPENCOLLECTION_FILE].sort(),
    );
  });

  describe("isCollectionMetadataFile", () => {
    it.each([OPENCOLLECTION_FILE, COLLECTION_FILE, FOLDER_FILE])(
      "excludes %s",
      (fileName) => {
        expect(isCollectionMetadataFile(fileName)).toBe(true);
      },
    );

    it("treats a normal request file as non-metadata", () => {
      expect(isCollectionMetadataFile("Search.yml")).toBe(false);
    });
  });

  describe("isYamlFile", () => {
    it("accepts .yml files regardless of case", () => {
      expect(isYamlFile("Search.yml")).toBe(true);
      expect(isYamlFile("Search.YML")).toBe(true);
    });

    it("rejects non-yaml files", () => {
      expect(isYamlFile("README.md")).toBe(false);
      expect(isYamlFile("script.js")).toBe(false);
    });
  });

  describe("isEnvironmentsDir", () => {
    it("matches the reserved environments directory", () => {
      expect(isEnvironmentsDir("environments")).toBe(true);
      expect(isEnvironmentsDir("Hotel")).toBe(false);
    });
  });
});
