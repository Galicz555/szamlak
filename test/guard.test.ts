import assert from "node:assert/strict";
import { test } from "vitest";
import { guardRequest } from "../src/web/guard.ts";

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
