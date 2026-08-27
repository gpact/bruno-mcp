import { describe, expect, it } from "vitest";

import {
  REDACTED,
  SENSITIVE_HEADERS,
  redactReport,
  redactSecretValue,
} from "../../src/security/redact.js";

describe("redactSecretValue", () => {
  it("returns non-secret values verbatim", () => {
    expect(redactSecretValue("http://localhost:4080", false)).toBe(
      "http://localhost:4080",
    );
  });

  it("redacts secret values", () => {
    expect(redactSecretValue("super-secret", true)).toBe(REDACTED);
    expect(REDACTED).toBe("[REDACTED]");
  });

  it("redacts secret values even when stored as plaintext of any type", () => {
    expect(redactSecretValue(1234, true)).toBe(REDACTED);
    expect(redactSecretValue({ token: "abc" }, true)).toBe(REDACTED);
    expect(redactSecretValue(undefined, true)).toBe(REDACTED);
  });

  it("coerces missing non-secret values to an empty string", () => {
    expect(redactSecretValue(undefined, false)).toBe("");
    expect(redactSecretValue(null, false)).toBe("");
  });

  it("coerces non-string non-secret values to strings", () => {
    expect(redactSecretValue(8080, false)).toBe("8080");
    expect(redactSecretValue(true, false)).toBe("true");
  });
});

describe("redactReport", () => {
  it.each(SENSITIVE_HEADERS)(
    "redacts %s case-insensitively while preserving its name",
    (header) => {
      const mixedCase = [...header]
        .map((character, index) =>
          index % 2 === 0 ? character.toLowerCase() : character.toUpperCase(),
        )
        .join("");
      const report = {
        nested: {
          request: {
            headers: {
              [mixedCase]: `${header} secret`,
              Accept: "application/json",
            },
          },
        },
      };

      const redacted = redactReport(report);

      expect(redacted.nested.request.headers).toEqual({
        [mixedCase]: REDACTED,
        Accept: "application/json",
      });
      expect(report.nested.request.headers[mixedCase]).toBe(`${header} secret`);
    },
  );

  it("redacts nested response headers and secret environment values", () => {
    const report = {
      iterations: [
        {
          response: {
            headers: { "set-cookie": ["session=secret"] },
            data: {
              environment: {
                variables: [
                  { name: "apiKey", value: "plaintext secret", secret: true },
                  { name: "baseUrl", value: "https://example.test", secret: false },
                ],
              },
            },
          },
        },
      ],
    };

    expect(redactReport(report)).toEqual({
      iterations: [
        {
          response: {
            headers: { "set-cookie": REDACTED },
            data: {
              environment: {
                variables: [
                  { name: "apiKey", value: REDACTED, secret: true },
                  { name: "baseUrl", value: "https://example.test", secret: false },
                ],
              },
            },
          },
        },
      ],
    });
  });
});
