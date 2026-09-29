import assert from "node:assert/strict";
import { test } from "node:test";
import { formatMinor, parseAmountMinor, parseDecimalMinor } from "../src/shared/money.ts";

test("parseAmountMinor reads the ways Hungarian bills print amounts", () => {
  const cases: [string, number][] = [
    ["12 345 Ft", 1_234_500],
    ["12 345 Ft", 1_234_500],
    ["12.345", 1_234_500],
    ["1.234.567", 123_456_700],
    ["12.345,50", 1_234_550],
    ["12,345.50", 1_234_550],
    ["12.345,-", 1_234_500],
    ["12345", 1_234_500],
    ["-1 234", -123_400],
    ["99,5", 9950],
    ["HUF 5 000", 500_000],
  ];
  for (const [text, expected] of cases) {
    assert.equal(parseAmountMinor(text, 2), expected, text);
  }
});

test("parseAmountMinor refuses what is not an amount or has too much precision", () => {
  for (const bad of ["", "abc", "12a", "1,2,3.4.5x", "12.345,678"]) {
    assert.throws(() => parseAmountMinor(bad, 2), Error, bad);
  }
});

test("parseDecimalMinor treats a dot as the decimal point, never as grouping", () => {
  assert.equal(parseDecimalMinor("12.500", 2), 1250);
  assert.equal(parseDecimalMinor("100", 2), 10_000);
  assert.equal(parseDecimalMinor("-0.01", 2), -1);
  assert.throws(() => parseDecimalMinor("12,50", 2));
  assert.throws(() => parseDecimalMinor("1.005", 2));
});

test("formatMinor prints forints without fillér", () => {
  assert.match(formatMinor(1_234_500, "HUF"), /^12\s345\sFt$/);
});
