import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { test } from "vitest";
import { loadEnv, loadExtractorEnv } from "../src/env.ts";
import { pollerSettingsFrom } from "../src/poll/settings.ts";

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

test("own payer ids are optional, parsed per supplier, and handed to the extract stage", () => {
  const example = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
  const base = { ...example, IMAP_PASSWORD: "app-password", EB_APP_ID: "app-id" };
  assert.equal(loadEnv(base).MAIL_PAYER_IDS, undefined);
  assert.equal(loadEnv({ ...base, MAIL_PAYER_IDS: "" }).MAIL_PAYER_IDS, undefined);

  const env = loadEnv({
    ...base,
    MAIL_PAYER_IDS: "MVM.hu=123456789, mvm.hu=AB-1,telekom.hu=987654321",
  });
  assert.deepEqual(env.MAIL_PAYER_IDS, [
    { domain: "mvm.hu", payerId: "123456789" },
    { domain: "mvm.hu", payerId: "ab-1" },
    { domain: "telekom.hu", payerId: "987654321" },
  ]);
  assert.deepEqual(pollerSettingsFrom(env).extract.payerIds, env.MAIL_PAYER_IDS);

  for (const bad of ["123456789", "mvm.hu=", "=123", "mvm.hu=1=2", "mvm.hu=1 2"]) {
    assert.throws(
      () => loadEnv({ ...base, MAIL_PAYER_IDS: bad }),
      /Invalid configuration[\s\S]*MAIL_PAYER_IDS/,
      bad,
    );
  }
});
