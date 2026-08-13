import assert from "node:assert/strict";
import test from "node:test";
import { retryLegacyDraftCleanup } from "../components/project-management/task-composer-legacy-draft-tombstone";

test("legacy draft cleanup retries a transient IndexedDB failure", async () => {
  let attempts = 0;
  const delays: number[] = [];

  await retryLegacyDraftCleanup(
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("IndexedDB temporarily unavailable");
    },
    async (delayMs) => {
      delays.push(delayMs);
    },
  );

  assert.equal(attempts, 2);
  assert.deepEqual(delays, [250]);
});

test("legacy draft cleanup reports failure after three attempts", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const failure = new Error("IndexedDB unavailable");

  await assert.rejects(
    retryLegacyDraftCleanup(
      async () => {
        attempts += 1;
        throw failure;
      },
      async (delayMs) => {
        delays.push(delayMs);
      },
    ),
    failure,
  );

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [250, 1_000]);
});
