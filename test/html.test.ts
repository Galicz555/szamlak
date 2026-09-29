import assert from "node:assert/strict";
import { test } from "vitest";
import { escapeHtml, html } from "../src/web/html.ts";

test("every interpolation is escaped; nested templates are not double-escaped", () => {
  const subject = `<img src=x onerror="alert(1)">`;
  const out = html`<p title="${subject}">${subject}${html`<b>${"&"}</b>`}</p>`.value;
  assert.ok(!out.includes("<img"));
  assert.ok(out.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
  assert.ok(out.includes("<b>&amp;</b>"));
  assert.equal(escapeHtml(`'`), "&#39;");
});
