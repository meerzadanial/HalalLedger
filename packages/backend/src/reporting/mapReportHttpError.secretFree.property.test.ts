import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { mapReportHttpError } from "./http";

const CORRELATION_ID = "11111111-1111-4111-8111-111111111111";
const secretFragment = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"), {
    minLength: 12,
    maxLength: 48,
  })
  .map((characters) => characters.join(""));

const internalExceptionArbitrary = fc.record({
  sessionToken: secretFragment.map((value) => `SESSION_TOKEN_${value}`),
  providerCredential: secretFragment.map((value) => `PROVIDER_CREDENTIAL_${value}`),
  signature: secretFragment.map((value) => `WEBHOOK_SIGNATURE_${value}`),
  sentinelSecret: secretFragment.map((value) => `SENTINEL_SECRET_${value}`),
  stackFrames: fc.array(secretFragment.map((value) => `at submitReport (/srv/private/${value}.ts:42:7)`), {
    minLength: 1,
    maxLength: 6,
  }),
}).map((values) => {
  const message = `session=${values.sessionToken}; provider=${values.providerCredential}; signature=${values.signature}; sentinel=${values.sentinelSecret}`;
  const error = new Error(message);
  error.stack = `Error: ${message}\n${values.stackFrames.join("\n")}`;
  Object.assign(error, {
    sessionToken: values.sessionToken,
    providerCredential: values.providerCredential,
    signature: values.signature,
    cause: { secret: values.sentinelSecret },
  });
  return { error, values };
});

describe("centralized report HTTP error mapper", () => {
  // Feature: bulk-csv-report-email, Property 25: Public unexpected errors are secret-free
  // **Validates: Requirements 7.10**
  it("maps arbitrary secret-bearing exceptions to one fixed public response", () => {
    fc.assert(fc.property(internalExceptionArbitrary, ({ error, values }) => {
      const mapped = mapReportHttpError(error, CORRELATION_ID);
      expect(mapped).toEqual({
        status: 500,
        body: {
          code: "unexpected_report_error",
          stage: "unexpected",
          message: "The report could not be completed because of an unexpected error.",
          correlationId: CORRELATION_ID,
        },
      });

      const publicOutput = JSON.stringify(mapped);
      const privateValues = [
        values.sessionToken,
        values.providerCredential,
        values.signature,
        values.sentinelSecret,
        error.message,
        error.stack ?? "",
        ...values.stackFrames,
      ];
      for (const privateValue of privateValues) {
        expect(publicOutput).not.toContain(privateValue);
      }
    }), { numRuns: 150 });
  });
});