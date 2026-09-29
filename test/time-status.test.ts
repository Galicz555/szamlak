import assert from "node:assert/strict";
import { test } from "node:test";
import { billState } from "../src/bills/status.ts";
import { addDays, isCalendarDate, todayIn } from "../src/shared/time.ts";

const at = (iso: string) => ({ now: () => new Date(iso) });

test("today is Budapest's calendar day, not UTC's, across both DST changes", () => {
  // Winter (UTC+1): 23:30 UTC is already the next day in Budapest.
  assert.equal(todayIn(at("2026-01-10T23:30:00Z"), "Europe/Budapest"), "2026-01-11");
  // Spring forward, 2026-03-29: 22:30 UTC on the 28th is 23:30 CET, still the 28th.
  assert.equal(todayIn(at("2026-03-28T22:30:00Z"), "Europe/Budapest"), "2026-03-28");
  // Summer (UTC+2): 22:30 UTC is 00:30 the next day.
  assert.equal(todayIn(at("2026-07-10T22:30:00Z"), "Europe/Budapest"), "2026-07-11");
  // Fall back, 2026-10-25: 22:30 UTC on the 24th is 00:30 CEST on the 25th.
  assert.equal(todayIn(at("2026-10-24T22:30:00Z"), "Europe/Budapest"), "2026-10-25");
  assert.equal(todayIn(at("2026-10-24T21:30:00Z"), "Europe/Budapest"), "2026-10-24");
});

test("addDays is calendar arithmetic that DST cannot shift", () => {
  assert.equal(addDays("2026-03-28", 1), "2026-03-29");
  assert.equal(addDays("2026-03-29", 1), "2026-03-30");
  assert.equal(addDays("2026-10-25", -1), "2026-10-24");
  assert.equal(addDays("2026-01-31", 30), "2026-03-02");
});

test("isCalendarDate rejects impossible dates", () => {
  assert.ok(isCalendarDate("2028-02-29"));
  assert.ok(!isCalendarDate("2026-02-29"));
  assert.ok(!isCalendarDate("2026-13-01"));
  assert.ok(!isCalendarDate("2026-1-01"));
});

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
