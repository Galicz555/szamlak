import assert from "node:assert/strict";
import { test } from "vitest";
import { printedAmounts } from "../src/extract/text-search.ts";

test("printed amounts: grouped, decimal, suffixed; never date or id fragments", () => {
  const found = printedAmounts(
    "Összesen: 1 234 567 Ft, díj 12.345,- és 99,50 EUR; 12345Ft. Kelt 2026.09.18. Szám E-SZ-2026/0045871",
    2,
  );
  assert.deepEqual(
    [...found].sort((a, b) => a - b),
    [9950, 1_234_500, 123_456_700],
  );
});
