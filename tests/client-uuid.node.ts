import assert from "node:assert/strict";
import test from "node:test";
import { createClientUuid } from "../lib/material-management/client-uuid";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("client UUID uses native randomUUID when available", () => {
  const expected = "4df56f72-cedc-4bbc-980f-1a80b9833ed2";
  assert.equal(
    createClientUuid({
      randomUUID: () => expected,
    }),
    expected,
  );
});

test("client UUID falls back to RFC 4122 version 4 using getRandomValues", () => {
  const uuid = createClientUuid({
    getRandomValues(values) {
      values.set(Array.from({ length: 16 }, (_, index) => index));
      return values;
    },
  });

  assert.equal(uuid, "00010203-0405-4607-8809-0a0b0c0d0e0f");
  assert.match(uuid, UUID_V4_PATTERN);
});

test("client UUID remains valid when Web Crypto is unavailable", () => {
  assert.match(createClientUuid({}), UUID_V4_PATTERN);
});
