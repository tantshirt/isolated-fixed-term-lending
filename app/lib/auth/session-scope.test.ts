import test from "node:test";
import assert from "node:assert/strict";
import { SessionScope } from "./session-scope";

test("pending sign-in cannot install credentials after switching away and back", async () => {
  const scope = new SessionScope();
  scope.setWallet("A");
  const attempt = scope.begin();
  const completion = Promise.resolve().then(() => scope.isCurrent(attempt));
  scope.setWallet("B");
  scope.setWallet("A");
  assert.equal(await completion, false);
  assert.equal(scope.isCurrent(scope.begin()), true);
});

test("sign-out, disconnect and a newer attempt each invalidate pending sign-ins", () => {
  for (const cancel of [(s: SessionScope) => s.invalidate(), (s: SessionScope) => s.setWallet(null), (s: SessionScope) => s.begin()]) {
    const scope = new SessionScope();
    scope.setWallet("A");
    const attempt = scope.begin();
    cancel(scope);
    assert.equal(scope.isCurrent(attempt), false);
  }
});
