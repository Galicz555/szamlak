import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { test } from "node:test";
import { loadEnv, loadExtractorEnv } from "../src/env.ts";

test("the extractor settings load alone, without the mail or bank settings the app needs", () => {
  assert.deepEqual(
    loadExtractorEnv({
      LOCAL_LLM_URL: "http://127.0.0.1:8002/v1",
      LOCAL_LLM_MODEL: "qwen3-14b",
      // An `.env` line left blank means "not configured", as in .env.example.
      GEMINI_API_KEY: "",
    }),
    {
      LOCAL_LLM_URL: "http://127.0.0.1:8002/v1",
      LOCAL_LLM_MODEL: "qwen3-14b",
      GEMINI_API_KEY: undefined,
      GEMINI_MODEL: "gemini-2.5-flash",
    },
  );
  assert.throws(
    () => loadExtractorEnv({ LOCAL_LLM_URL: "not a url", LOCAL_LLM_MODEL: "m" }),
    /Invalid configuration[\s\S]*LOCAL_LLM_URL/,
  );
});

test("the app starts from .env.example once the secrets are filled in, blank optionals included", () => {
  const example = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
  const env = loadEnv({ ...example, IMAP_PASSWORD: "app-password", EB_APP_ID: "app-id" });
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.throws(
    () => loadEnv({ ...example, EB_APP_ID: "app-id" }),
    /Invalid configuration[\s\S]*IMAP_PASSWORD/,
  );
});
