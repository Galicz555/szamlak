import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { test } from "vitest";
import { isBankLoginUrl } from "../src/bank/enable-banking.ts";
import { signJwt } from "../src/bank/jwt.ts";
import { toTransactions } from "../src/bank/provider-transactions.ts";

test("the bank login may start only on an https Enable Banking address", () => {
  assert.ok(isBankLoginUrl("https://tilisy.enablebanking.com/welcome?x=1"));
  assert.ok(isBankLoginUrl("https://enablebanking.com/login"));
  assert.ok(!isBankLoginUrl("http://tilisy.enablebanking.com/welcome"));
  assert.ok(!isBankLoginUrl("https://enablebanking.com.evil.example/login"));
  assert.ok(!isBankLoginUrl("https://evilenablebanking.com/login"));
});

test("the JWT is RS256, carries the app id as kid, and verifies with the public key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const token = signJwt("app-123", privateKey, 1_800_000_000);
  const [h = "", p = "", s = ""] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), {
    typ: "JWT",
    alg: "RS256",
    kid: "app-123",
  });
  const payload = JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>;
  assert.equal(payload.iss, "enablebanking.com");
  assert.equal(payload.aud, "api.enablebanking.com");
  assert.ok(Number(payload.exp) - Number(payload.iat) <= 86_400);
  assert.ok(verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url")));
});

test("transactions map direction and amount exactly; pending ones are skipped", () => {
  const txs = toTransactions([
    {
      entry_reference: "E1",
      transaction_amount: { amount: "8990.00", currency: "HUF" },
      credit_debit_indicator: "DBIT",
      status: "BOOK",
      booking_date: "2026-09-12",
      remittance_information: ["HU123456", "Telekom"],
      creditor: { name: "MAGYAR TELEKOM" },
    },
    {
      entry_reference: "E2",
      transaction_amount: { amount: "100.00", currency: "HUF" },
      credit_debit_indicator: "DBIT",
      status: "PDNG",
      booking_date: "2026-09-12",
    },
  ]);
  assert.deepEqual(txs, [
    {
      providerTxKey: "E1",
      direction: "debit",
      amountMinor: 899_000,
      currency: "HUF",
      bookingDate: "2026-09-12",
      counterparty: "MAGYAR TELEKOM",
      remittance: "HU123456 | Telekom",
    },
  ]);
});

test("without a debit/credit indicator the sign decides the direction; amounts stay positive", () => {
  const booked = { status: "BOOK", booking_date: "2026-09-12" };
  const txs = toTransactions([
    { ...booked, entry_reference: "A", transaction_amount: { amount: "-1200", currency: "HUF" } },
    { ...booked, entry_reference: "B", transaction_amount: { amount: "1200", currency: "HUF" } },
    {
      ...booked,
      entry_reference: "C",
      transaction_amount: { amount: "1200", currency: "HUF" },
      credit_debit_indicator: "CRDT",
    },
  ]);
  assert.deepEqual(
    txs.map((t) => [t.providerTxKey, t.direction, t.amountMinor]),
    [
      ["A", "debit", 120_000],
      ["B", "credit", 120_000],
      ["C", "credit", 120_000],
    ],
  );
});

test("two identical entries without a bank reference stay two rows", () => {
  const coffee = {
    transaction_amount: { amount: "-1200", currency: "HUF" },
    booking_date: "2026-09-12",
    remittance_information: ["CAFE"],
  };
  const keys = toTransactions([coffee, coffee]).map((t) => t.providerTxKey);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  // Stable: the same response yields the same keys, so a re-fetch inserts nothing new.
  assert.deepEqual(
    toTransactions([coffee, coffee]).map((t) => t.providerTxKey),
    keys,
  );
});
