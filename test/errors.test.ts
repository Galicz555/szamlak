import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { AppError, errnoCodeOf } from "../src/shared/errors.ts";
import { parseJson } from "../src/shared/json.ts";

test("bad JSON text fails as an invalid AppError with the caller's code, message and cause", () => {
  assert.deepEqual(parseJson('{"a": 1}', { code: "X_BAD_JSON", message: "x" }), { a: 1 });
  assert.throws(
    () => parseJson("<html>", { code: "X_BAD_JSON", message: "x answered non-JSON" }),
    (err) =>
      err instanceof AppError &&
      err.category === "invalid" &&
      err.code === "X_BAD_JSON" &&
      err.message === "x answered non-JSON" &&
      err.cause instanceof SyntaxError,
  );
});

test("the code of a Node system error is read; an error or value without one has none", async () => {
  const missing = path.join(mkdtempSync(path.join(tmpdir(), "szamlak-")), "nope");
  const err: unknown = await readdir(missing).catch((e: unknown) => e);
  assert.equal(errnoCodeOf(err), "ENOENT");
  assert.equal(errnoCodeOf(new Error("plain")), undefined);
  assert.equal(errnoCodeOf(Object.assign(new Error("odd"), { code: 13 })), undefined);
  assert.equal(errnoCodeOf("ENOENT"), undefined);
});
