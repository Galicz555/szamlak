import assert from "node:assert/strict";
import { test } from "vitest";
import { errorText } from "../src/shared/log.ts";

test("error text carries the cause chain, bounded", () => {
  const err = new Error("IMAP connect failed", {
    cause: new Error("connect ECONNREFUSED 127.0.0.1:1"),
  });
  assert.equal(
    errorText(err),
    "Error: IMAP connect failed ← Error: connect ECONNREFUSED 127.0.0.1:1",
  );
  assert.equal(errorText(new Error("x".repeat(50)), { maxChars: 20 }).length, 21);
});
