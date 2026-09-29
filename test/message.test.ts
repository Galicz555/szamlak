import assert from "node:assert/strict";
import { test } from "vitest";
import { isAllowedSender } from "../src/mail/message.ts";

test("sender allow-list matches whole addresses and domains, not look-alikes", () => {
  assert.ok(isAllowedSender("szamla@mvm.hu", ["mvm.hu"]));
  assert.ok(isAllowedSender("x@next.mvm.hu", ["mvm.hu"]));
  assert.ok(!isAllowedSender("x@evilmvm.hu", ["mvm.hu"]));
  assert.ok(!isAllowedSender("x@mvm.hu.evil.example", ["mvm.hu"]));
  assert.ok(isAllowedSender("e-szamla@telekom.hu", ["e-szamla@telekom.hu"]));
  assert.ok(!isAllowedSender("mas@telekom.hu", ["e-szamla@telekom.hu"]));
});
