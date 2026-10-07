import test from "node:test";
import assert from "node:assert/strict";
import { AsyncScope } from "./async-scope";

test("a wallet switch prevents delayed work from publishing or starting a transfer", async () => {
  const scope = new AsyncScope();
  const operation = scope.capture();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let transfers = 0;
  let published = false;
  const action = (async () => {
    await pending;
    operation.assertActive();
    transfers++;
    if (operation.active()) published = true;
  })();
  scope.invalidate();
  release();
  await assert.rejects(action, /wallet session changed/);
  assert.equal(transfers, 0);
  assert.equal(published, false);
  assert.equal(scope.capture().active(), true, "a fresh operation can proceed");
});
