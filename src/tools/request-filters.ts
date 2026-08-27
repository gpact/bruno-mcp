import type { RequestSummary } from "../opencollection/types.js";

/** Treat absent and blank filters alike as no filter. */
export function normalizeFilter(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Case-insensitive substring match against name, path, and URL when present. */
export function matchesQuery(
  request: RequestSummary,
  query: string | undefined,
): boolean {
  if (query === undefined) {
    return true;
  }

  const needle = query.toLowerCase();
  const haystacks = [request.name, request.path, request.url ?? ""];
  return haystacks.some((value) => value.toLowerCase().includes(needle));
}

/** Case-insensitive match against the HTTP method when a filter is given. */
export function matchesMethod(
  request: RequestSummary,
  method: string | undefined,
): boolean {
  if (method === undefined) {
    return true;
  }
  return request.method?.toLowerCase() === method.toLowerCase();
}

/** Case-insensitive match against the request type when a filter is given. */
export function matchesType(
  request: RequestSummary,
  type: string | undefined,
): boolean {
  if (type === undefined) {
    return true;
  }
  return request.type.toLowerCase() === type.toLowerCase();
}
