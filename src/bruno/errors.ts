export const BRUNO_MCP_ERROR_CODES = [
  "BRUNO_NOT_FOUND",
  "UNSUPPORTED_BRUNO_VERSION",
  "COLLECTION_NOT_FOUND",
  "INVALID_COLLECTION",
  "REQUEST_NOT_FOUND",
  "REQUEST_ALREADY_EXISTS",
  "INVALID_REQUEST_PATH",
  "ENVIRONMENT_NOT_FOUND",
  "INVALID_YAML",
  "PATH_OUTSIDE_ROOT",
  "INVALID_TARGET",
  "INVALID_ENVIRONMENT_NAME",
  "INVALID_VARIABLE_NAME",
  "DEVELOPER_SANDBOX_DISABLED",
  "INSECURE_DISABLED",
  "EXECUTION_TIMEOUT",
  "BRUNO_EXECUTION_ERROR",
  "REPORT_TOO_LARGE",
  "REPORT_PARSE_ERROR",
] as const;

export type BrunoMcpErrorCode = (typeof BRUNO_MCP_ERROR_CODES)[number];

export interface McpErrorContent {
  code: BrunoMcpErrorCode;
  message: string;
}

export class BrunoMcpError extends Error {
  override readonly name = "BrunoMcpError";

  constructor(
    readonly code: BrunoMcpErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function toMcpErrorContent(error: BrunoMcpError): McpErrorContent {
  return {
    code: error.code,
    message: error.message,
  };
}
