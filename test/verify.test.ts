import assert from "node:assert/strict";
import { test } from "node:test";
import type { Extraction } from "../src/extract/schema.ts";
import { printedAmounts, verifyExtraction } from "../src/extract/verify.ts";

const TEXT = `MVM Next Energiakereskedelmi Zrt.
Számla sorszáma: 5 1234 5678 90
Fizető azonosító: 100 200 300
Számla kelte: 2026.09.20.
Fizetési határidő: 2026. október 15.
Fizetendő összeg: 12 345 Ft
Bankszámlaszám: 10700024-12345678-51100005`;

const good: Extraction = {
  is_bill: true,
  supplier_name: "MVM Next Energiakereskedelmi Zrt.",
  invoice_number: "5 1234 5678 90",
  payer_id: "100 200 300",
  amount_due_text: "12 345",
  currency: "HUF",
  issue_date: "2026-09-20",
  due_date: "2026-10-15",
  iban: "10700024-12345678-51100005",
};

test("a faithful extraction becomes a bill with parsed amount", () => {
  const v = verifyExtraction(good, TEXT);
  assert.equal(v.kind, "bill");
  assert.equal(v.bill.amountMinor, 1_234_500);
  assert.equal(v.bill.dueDate, "2026-10-15");
  assert.equal(v.bill.issueDate, "2026-09-20");
  assert.equal(v.bill.payerId, "100 200 300");
});

test("values the text does not contain are rejected, each named", () => {
  const v = verifyExtraction(
    {
      ...good,
      invoice_number: "5 1234 5678 91",
      amount_due_text: "12 354",
      due_date: "2026-10-16",
    },
    TEXT,
  );
  assert.equal(v.kind, "rejected");
  assert.deepEqual(v.problems, [
    "invoice_number not found in text",
    "amount_due_text not found in text",
    "due_date not found in text",
  ]);
});

test("an invented optional identifier is dropped, not trusted", () => {
  const v = verifyExtraction({ ...good, payer_id: "999", iban: "HU00 0000" }, TEXT);
  assert.equal(v.kind, "bill");
  assert.equal(v.bill.payerId, null);
  assert.equal(v.bill.iban, null);
});

test("a refund balance means nothing to pay; a non-bill is recognised", () => {
  const refundText = TEXT.replace("12 345 Ft", "-12 345 Ft");
  assert.equal(
    verifyExtraction({ ...good, amount_due_text: "-12 345" }, refundText).kind,
    "nothing_to_pay",
  );
  assert.equal(verifyExtraction({ ...good, is_bill: false }, TEXT).kind, "not_a_bill");
});

test("missing required fields are rejected", () => {
  const v = verifyExtraction({ ...good, due_date: null, currency: null }, TEXT);
  assert.equal(v.kind, "rejected");
});

test("an amount is not 'found' inside a longer number such as the invoice number", () => {
  // 12345 occurs inside invoice number 51234567890, but the bill says 9 870 Ft.
  const text = TEXT.replace("12 345 Ft", "9 870 Ft");
  const v = verifyExtraction(good, text);
  assert.equal(v.kind, "rejected");
  assert.deepEqual(v.problems, ["amount_due_text not found in text"]);
});

test("a truncated invoice number does not pass as the whole one", () => {
  const v = verifyExtraction({ ...good, invoice_number: "5 1234 5678 9" }, TEXT);
  assert.equal(v.kind, "rejected");
});

test("an amount is not 'found' at the end of a longer number either", () => {
  // "9912345" ends in 12345; the bill itself says 8 000 Ft.
  const text = `${TEXT.replace("12 345 Ft", "8 000 Ft")}\nÜgyfélszám: 9912345`;
  const v = verifyExtraction(good, text);
  assert.equal(v.kind, "rejected");
});

test("a fragment of a space-grouped amount, or digits joined across columns, is not an amount", () => {
  const text = `${TEXT}\nTétel 3 45 678 Ft`;
  for (const wrong of ["345", "12", "345678", "45 678"]) {
    const v = verifyExtraction({ ...good, amount_due_text: wrong }, text);
    assert.equal(v.kind, "rejected", wrong);
  }
});

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

test("a number is not found inside a longer space-grouped number", () => {
  assert.equal(
    verifyExtraction({ ...good, invoice_number: "1234" }, `${TEXT}\nRef: 1234 5678`).kind,
    "rejected",
  );
});
