/**
 * Internal collection model shared by discovery and tool code.
 *
 * These types describe the minimum structure the MCP relies on. Documents may
 * carry additional, unrecognized OpenCollection fields; the index signatures
 * below keep the model forward-compatible with future Bruno v4 additions.
 */

/** Summary of a discovered OpenCollection. */
export interface CollectionSummary {
  /** Stable identifier: the collection root path relative to `BRUNO_MCP_ROOT`. */
  id: string;
  /** Human-readable name from `info.name`. */
  name: string;
  /** Collection root path relative to `BRUNO_MCP_ROOT`. */
  path: string;
  /** Declared OpenCollection format version (e.g. `"1.0.0"`). */
  openCollectionVersion: string;
}

/** Normalized request fields shared by request listing and inspection. */
export interface RequestMetadata {
  /** Display name from `info.name`. */
  name: string;
  /** Request type from `info.type` (e.g. `"http"`, `"graphql"`, future types). */
  type: string;
  /** Ordering hint from `info.seq`, when present. */
  sequence?: number;
  /** HTTP method, when the request declares one. */
  method?: string;
  /** Request URL, when the request declares one. */
  url?: string;
}

/** Summary of a single request within a collection. */
export interface RequestSummary extends RequestMetadata {
  /** Request file path relative to its collection root. */
  path: string;
}

/** Request summary tagged with its owning collection identifier. */
export interface RequestSearchResult extends RequestSummary {
  /** Collection path relative to `BRUNO_MCP_ROOT`. */
  collection: string;
}

/** Summary of an environment definition. */
export interface EnvironmentSummary {
  /** Environment name (file base name without extension). */
  name: string;
  /** Environment file path relative to its collection root. */
  path: string;
  /** Total number of declared variables. */
  variableCount: number;
  /** Number of variables marked `secret: true`. */
  secretCount: number;
}

/** A single environment variable as stored in an environment document. */
export type EnvironmentValueType =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "object";

/** An OpenCollection variable value with explicit type metadata. */
export interface EnvironmentTypedValue {
  type: EnvironmentValueType;
  data: string;
}

/** One selectable alternative for an environment variable value. */
export interface EnvironmentValueVariant {
  title: string;
  selected?: boolean;
  value: string | EnvironmentTypedValue;
}

/** A value stored in an OpenCollection environment variable. */
export type EnvironmentVariableValue =
  | string
  | EnvironmentTypedValue
  | EnvironmentValueVariant[];

/** Optional human-readable variable documentation. */
export type EnvironmentVariableDescription =
  | string
  | { content: string; type: string };

export interface EnvironmentVariable {
  name: string;
  value?: EnvironmentVariableValue;
  /** When `true`, the stored value must never be returned through MCP. */
  secret?: boolean;
  /** Type metadata for a secret variable whose value is stored externally. */
  type?: EnvironmentValueType;
  description?: EnvironmentVariableDescription;
  disabled?: boolean;
  enabled?: boolean;
  [key: string]: unknown;
}

interface EnvironmentVariableDetailBase {
  name: string;
  description?: EnvironmentVariableDescription;
  disabled?: boolean;
}

/** A regular environment variable as exposed through environment inspection. */
export interface RegularEnvironmentVariableDetail
  extends EnvironmentVariableDetailBase {
  /**
   * Non-secret values are returned verbatim, including typed and variant values.
   */
  value: EnvironmentVariableValue;
  secret: false;
}

/** A secret environment variable as exposed through environment inspection. */
export interface SecretEnvironmentVariableDetail
  extends EnvironmentVariableDetailBase {
  /** Always the redaction placeholder, never the stored value. */
  value: string;
  secret: true;
  type?: EnvironmentValueType;
}

/** A single environment variable as exposed through environment inspection. */
export type EnvironmentVariableDetail =
  | RegularEnvironmentVariableDetail
  | SecretEnvironmentVariableDetail;

/** Full environment detail, with secret values already redacted. */
export interface EnvironmentDetail {
  /** Environment name, derived from the file base name. */
  name: string;
  variables: EnvironmentVariableDetail[];
}

/** Parsed shape of an `environments/*.yml` document. */
export interface EnvironmentDocument {
  variables?: EnvironmentVariable[];
  [key: string]: unknown;
}

/** The `info` block shared by collection and request documents. */
export interface DocumentInfo {
  name?: string;
  type?: string;
  seq?: number;
  [key: string]: unknown;
}

/** Parsed shape of an `opencollection.yml` document. */
export interface OpenCollectionDocument {
  /** OpenCollection format marker, e.g. `1.0.0`. */
  opencollection?: string;
  info?: DocumentInfo;
  [key: string]: unknown;
}

/** The `http` block of an HTTP request document. */
export interface RequestHttpBlock {
  method?: string;
  url?: string;
  [key: string]: unknown;
}

/** Parsed shape of a request `*.yml` document. */
export interface RequestDocument {
  info?: DocumentInfo;
  http?: RequestHttpBlock;
  [key: string]: unknown;
}
