import assert from "node:assert/strict";
import { test } from "vitest";
import { isAddressedToUs, isSenderAuthenticated } from "../src/mail/sender-auth.ts";

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
