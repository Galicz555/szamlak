import assert from "node:assert/strict";
import { test } from "vitest";
import { billState } from "../src/bills/status.ts";

test("bill state: due today is still awaiting, the day after is overdue, a match wins", () => {
  assert.equal(
    billState({ hasActiveMatch: false, dueDate: "2026-10-15" }, "2026-10-15"),
    "awaiting",
  );
  assert.equal(
    billState({ hasActiveMatch: false, dueDate: "2026-10-15" }, "2026-10-16"),
    "overdue",
  );
  assert.equal(billState({ hasActiveMatch: true, dueDate: "2026-10-15" }, "2026-12-01"), "paid");
});
