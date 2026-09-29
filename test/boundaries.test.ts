import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";
import { signJwt, toTransactions } from "../src/bank/enable-banking.ts";
import { senderAuthenticated } from "../src/mail/sender-auth.ts";
import { guardRequest } from "../src/web/guard.ts";
import { escapeHtml, html } from "../src/web/html.ts";

// ---- sender authentication -----------------------------------------------------------------

const ar = (line: string) => ({
  key: "authentication-results",
  line: `Authentication-Results: ${line}`,
});

test("a DKIM pass for the From domain, written by our provider on top, is trusted", () => {
  const lines = [
    ar(
      "mx.google.com;\r\n       dkim=pass header.i=@mvm.hu header.s=s1 header.b=abc;\r\n       spf=pass smtp.mailfrom=mvm.hu",
    ),
  ];
  assert.ok(senderAuthenticated(lines, "mvm.hu", "mx.google.com"));
  assert.ok(senderAuthenticated(lines, "szamla.mvm.hu", "mx.google.com"));
});

test("a DMARC pass counts only for the same From domain", () => {
  const lines = [ar("mx.google.com; dmarc=pass (p=REJECT) header.from=telekom.hu")];
  assert.ok(senderAuthenticated(lines, "telekom.hu", "mx.google.com"));
  assert.ok(!senderAuthenticated(lines, "mvm.hu", "mx.google.com"));
});

test("a verdict the sender wrote below ours, or another server's verdict, is not trusted", () => {
  const forgedBelow = [
    ar("mx.google.com; dkim=fail header.d=mvm.hu; dmarc=fail header.from=mvm.hu"),
    ar("mx.google.com; dkim=pass header.d=mvm.hu"),
  ];
  assert.ok(!senderAuthenticated(forgedBelow, "mvm.hu", "mx.google.com"));
  assert.ok(
    !senderAuthenticated(
      [ar("evil.example; dkim=pass header.d=mvm.hu")],
      "mvm.hu",
      "mx.google.com",
    ),
  );
  assert.ok(!senderAuthenticated([], "mvm.hu", "mx.google.com"));
});

test("a signature by a bare TLD or another domain does not align", () => {
  assert.ok(
    !senderAuthenticated([ar("mx.google.com; dkim=pass header.d=hu")], "mvm.hu", "mx.google.com"),
  );
  assert.ok(
    !senderAuthenticated(
      [ar("mx.google.com; dkim=pass header.d=mailer.example")],
      "mvm.hu",
      "mx.google.com",
    ),
  );
});

test("pass verdicts smuggled inside a comment or a quoted envelope sender are ignored", () => {
  const injected = [
    ar(
      'mx.google.com; spf=softfail (google.com: domain of "x;dkim=pass header.i=@mvm.hu "@evil.example does not designate 1.2.3.4) smtp.mailfrom="x;dmarc=pass header.from=mvm.hu "@evil.example; dkim=none; dmarc=fail header.from=mvm.hu',
    ),
  ];
  assert.ok(!senderAuthenticated(injected, "mvm.hu", "mx.google.com"));
});

test("addressedToUs matches our addresses, Gmail dots and +tags included", async () => {
  const { addressedToUs } = await import("../src/mail/sender-auth.ts");
  assert.ok(addressedToUs(["Your.Name+bills@gmail.com"], ["yourname@gmail.com"]));
  assert.ok(!addressedToUs(["someone@gmail.com"], ["yourname@gmail.com"]));
  assert.ok(!addressedToUs([], ["yourname@gmail.com"]));
});

// ---- request guard -------------------------------------------------------------------------

test("only our own Host is served (DNS rebinding)", () => {
  assert.deepEqual(guardRequest("GET", { host: "127.0.0.1:8740" }, 8740), { ok: true });
  assert.equal(guardRequest("GET", { host: "evil.example:8740" }, 8740).ok, false);
  assert.equal(guardRequest("GET", {}, 8740).ok, false);
});

test("state-changing requests need our Origin, and fail closed without one (CSRF)", () => {
  const post = (headers: Record<string, string>) =>
    guardRequest("POST", { host: "localhost:8740", ...headers }, 8740).ok;
  assert.ok(post({ origin: "http://localhost:8740" }));
  assert.ok(!post({ origin: "https://evil.example" }));
  assert.ok(!post({ origin: "null" }));
  assert.ok(!post({}));
  assert.ok(post({ "sec-fetch-site": "same-origin" }));
  assert.ok(!post({ "sec-fetch-site": "cross-site" }));
});

// ---- html escaping -------------------------------------------------------------------------

test("every interpolation is escaped; nested templates are not double-escaped", () => {
  const subject = `<img src=x onerror="alert(1)">`;
  const out = html`<p title="${subject}">${subject}${html`<b>${"&"}</b>`}</p>`.value;
  assert.ok(!out.includes("<img"));
  assert.ok(out.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
  assert.ok(out.includes("<b>&amp;</b>"));
  assert.equal(escapeHtml(`'`), "&#39;");
});

// ---- Enable Banking ------------------------------------------------------------------------

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

test("error text carries the cause chain, bounded", async () => {
  const { errorText } = await import("../src/log.ts");
  const err = new Error("IMAP connect failed", {
    cause: new Error("connect ECONNREFUSED 127.0.0.1:1"),
  });
  assert.equal(
    errorText(err),
    "Error: IMAP connect failed ← Error: connect ECONNREFUSED 127.0.0.1:1",
  );
  assert.equal(errorText(new Error("x".repeat(50)), 20).length, 21);
});
