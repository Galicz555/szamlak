import assert from "node:assert/strict";
import { test } from "vitest";
import { isAddressedToUs, isSenderAuthenticated, isToSigned } from "../src/mail/sender-auth.ts";

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
  assert.ok(isSenderAuthenticated(lines, "mvm.hu", "mx.google.com"));
  assert.ok(isSenderAuthenticated(lines, "szamla.mvm.hu", "mx.google.com"));
});

test("a DMARC pass counts only for the same From domain", () => {
  const lines = [ar("mx.google.com; dmarc=pass (p=REJECT) header.from=telekom.hu")];
  assert.ok(isSenderAuthenticated(lines, "telekom.hu", "mx.google.com"));
  assert.ok(!isSenderAuthenticated(lines, "mvm.hu", "mx.google.com"));
});

test("a verdict the sender wrote below ours, or another server's verdict, is not trusted", () => {
  const forgedBelow = [
    ar("mx.google.com; dkim=fail header.d=mvm.hu; dmarc=fail header.from=mvm.hu"),
    ar("mx.google.com; dkim=pass header.d=mvm.hu"),
  ];
  assert.ok(!isSenderAuthenticated(forgedBelow, "mvm.hu", "mx.google.com"));
  assert.ok(
    !isSenderAuthenticated(
      [ar("evil.example; dkim=pass header.d=mvm.hu")],
      "mvm.hu",
      "mx.google.com",
    ),
  );
  assert.ok(!isSenderAuthenticated([], "mvm.hu", "mx.google.com"));
});

test("a signature by a bare TLD or another domain does not align", () => {
  assert.ok(
    !isSenderAuthenticated([ar("mx.google.com; dkim=pass header.d=hu")], "mvm.hu", "mx.google.com"),
  );
  assert.ok(
    !isSenderAuthenticated(
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
  assert.ok(!isSenderAuthenticated(injected, "mvm.hu", "mx.google.com"));
});

test("mail to our Gmail address counts as ours through dots and +tags, mail to others does not", () => {
  assert.ok(isAddressedToUs(["Your.Name+bills@gmail.com"], ["yourname@gmail.com"]));
  assert.ok(!isAddressedToUs(["someone@gmail.com"], ["yourname@gmail.com"]));
  assert.ok(!isAddressedToUs([], ["yourname@gmail.com"]));
});

const PASS = "mx.google.com; dkim=pass header.i=@mvm.hu header.s=s1 header.b=AbCdEfGh";
const sig = (tags: string) => ({ key: "dkim-signature", line: `DKIM-Signature: ${tags}` });
const SIGNED = "v=1; d=mvm.hu; s=s1; h=From:To:Subject; b=AbCdEfGh1234";

test("To counts as signed when the passing signature lists it, whatever the case or folding", () => {
  assert.ok(isToSigned([ar(PASS), sig(SIGNED)], "mvm.hu", "mx.google.com"));
  const folded = sig("v=1; d=mvm.hu; s=s1;\r\n h=from:\r\n subject : TO;\r\n b=AbCdEf\r\n Gh1234");
  assert.ok(isToSigned([ar(PASS), folded], "mvm.hu", "mx.google.com"));
});

test("To is not signed when the passing signature leaves it out", () => {
  const noTo = sig("v=1; d=mvm.hu; s=s1; h=from:subject:cc; b=AbCdEfGh1234");
  assert.ok(!isToSigned([ar(PASS), noTo], "mvm.hu", "mx.google.com"));
  // `tomorrow` is not `to`.
  const lookAlike = sig("v=1; d=mvm.hu; s=s1; h=from:tomorrow; b=AbCdEfGh1234");
  assert.ok(!isToSigned([ar(PASS), lookAlike], "mvm.hu", "mx.google.com"));
});

test("a signature that is not the one that passed does not vouch for To", () => {
  const otherValue = sig("v=1; d=mvm.hu; s=s1; h=from:to; b=ZZZZZZZZ1234");
  assert.ok(!isToSigned([ar(PASS), otherValue], "mvm.hu", "mx.google.com"));
  const otherSelector = sig("v=1; d=mvm.hu; s=s2; h=from:to; b=AbCdEfGh1234");
  assert.ok(!isToSigned([ar(PASS), otherSelector], "mvm.hu", "mx.google.com"));
  assert.ok(!isToSigned([ar(PASS)], "mvm.hu", "mx.google.com"));
});

test("a look-alike signature header added by a re-sender cannot vouch for To", () => {
  const forged = sig("v=1; d=mvm.hu; s=s1; h=from:to; b=AbCdEfGhFORGED");
  const genuineWithoutTo = sig("v=1; d=mvm.hu; s=s1; h=from:subject; b=AbCdEfGh1234");
  assert.ok(!isToSigned([ar(PASS), forged, genuineWithoutTo], "mvm.hu", "mx.google.com"));
});

test("To is not signed without a From-aligned DKIM pass from our provider", () => {
  const dmarcOnly = ar("mx.google.com; dmarc=pass header.from=mvm.hu");
  assert.ok(!isToSigned([dmarcOnly, sig(SIGNED)], "mvm.hu", "mx.google.com"));
  const otherSigner = ar(
    "mx.google.com; dkim=pass header.i=@mailer.example header.s=s1 header.b=AbCdEfGh",
  );
  assert.ok(!isToSigned([otherSigner, sig(SIGNED)], "mvm.hu", "mx.google.com"));
  const foreignServer = ar(PASS.replace("mx.google.com", "evil.example"));
  assert.ok(!isToSigned([foreignServer, sig(SIGNED)], "mvm.hu", "mx.google.com"));
  const noValue = ar("mx.google.com; dkim=pass header.i=@mvm.hu header.s=s1");
  assert.ok(!isToSigned([noValue, sig(SIGNED)], "mvm.hu", "mx.google.com"));
});
