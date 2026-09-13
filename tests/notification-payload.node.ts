import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { parseNotificationPayload } from "../lib/notification-payload";
import { NonRetryableNotificationError } from "../lib/notification-channel-adapter";

const schema = z.object({ kind: z.literal("example"), value: z.string() });
const row = (payload: string, type = "example") =>
  ({ payload, type } as Parameters<typeof parseNotificationPayload>[0]);

function assertNonRetryable(callback: () => unknown, message: string) {
  assert.throws(callback, (error: unknown) => {
    assert.ok(error instanceof NonRetryableNotificationError);
    assert.equal(error.message, message);
    return true;
  });
}

test("notification payload parser returns validated data", () => {
  assert.deepEqual(
    parseNotificationPayload(row('{"kind":"example","value":"ok"}'), schema, {
      invalidJson: "invalid json",
      invalidPayload: "invalid payload",
      metadata: (kind) => `metadata: ${kind}`,
    }),
    { kind: "example", value: "ok" },
  );
});

test("notification payload parser classifies malformed input safely", () => {
  const labels = {
    invalidJson: "invalid json",
    invalidPayload: "invalid payload",
    metadata: (kind: unknown) => `metadata: ${kind}`,
  };
  assertNonRetryable(
    () => parseNotificationPayload(row("{"), schema, labels),
    "invalid json",
  );
  assertNonRetryable(
    () => parseNotificationPayload(row('{"kind":"wrong","value":"x"}'), schema, labels),
    "invalid payload",
  );
  assertNonRetryable(
    () => parseNotificationPayload(row('{"kind":"example","value":"x"}', "reply"), schema, labels),
    "metadata: example",
  );
});
