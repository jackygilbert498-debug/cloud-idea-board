import assert from "node:assert/strict";
import test from "node:test";
import { OperationCoordinator, waitForInitialOutcome } from "../lib/operation-state.ts";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("immediate success is confirmed", async () => {
  assert.deepEqual(await waitForInitialOutcome(Promise.resolve("saved"), 50), {
    state: "confirmed",
    value: "saved",
  });
});

test("immediate failure is reported to the caller", async () => {
  await assert.rejects(
    waitForInitialOutcome(Promise.reject(new Error("write failed")), 50),
    /write failed/,
  );
});

test("timeout reports pending while preserving late success", async () => {
  const deferred = createDeferred<string>();
  const initial = await waitForInitialOutcome(deferred.promise, 1);
  assert.deepEqual(initial, { state: "pending" });
  deferred.resolve("saved");
  await assert.doesNotReject(deferred.promise);
});

test("timeout leaves the original promise available for late failure rollback", async () => {
  const deferred = createDeferred<string>();
  assert.deepEqual(await waitForInitialOutcome(deferred.promise, 1), { state: "pending" });
  const observedFailure = deferred.promise.catch((reason: unknown) => reason);
  deferred.reject(new Error("late failure"));
  assert.match(String(await observedFailure), /late failure/);
});

test("newer card mutation versions reject stale responses", () => {
  const coordinator = new OperationCoordinator();
  const first = coordinator.nextMutationVersion(7);
  const second = coordinator.nextMutationVersion(7);
  assert.equal(coordinator.isCurrentMutation(7, first), false);
  assert.equal(coordinator.isCurrentMutation(7, second), true);
});

test("activity stays nonzero until two concurrent operations both finish", () => {
  const counts: number[] = [];
  const coordinator = new OperationCoordinator((count) => counts.push(count));
  const finishFirst = coordinator.beginOperation();
  const finishSecond = coordinator.beginOperation();
  assert.equal(coordinator.activeCount, 2);
  finishFirst();
  assert.equal(coordinator.activeCount, 1);
  finishFirst();
  assert.equal(coordinator.activeCount, 1);
  finishSecond();
  assert.equal(coordinator.activeCount, 0);
  assert.deepEqual(counts, [1, 2, 1, 0]);
});
