import assert from "node:assert/strict";
import { test } from "vitest";
import type { InboundItem } from "../src/bills/repo.ts";
import { inboxPage, layout, type StatusBar } from "../src/web/pages.ts";

// 22:30 UTC is already the next day in Budapest (UTC+2 in September).
const LATE_EVENING_UTC = "2026-09-20T22:30:00Z";

test("times are shown in the configured time zone, not Budapest's", () => {
  const item: InboundItem = {
    id: "i1",
    kind: "pdf",
    sender: "szamla@mvm.hu",
    sender_domain: "mvm.hu",
    subject: "Számla",
    received_at: LATE_EVENING_UTC,
    file_path: "files/x.pdf",
    status: "dead_lettered",
    attempt_count: 1,
    last_error_code: "X",
    last_error: "x",
    result_code: null,
  };
  const status: StatusBar = {
    running: false,
    runs: [
      {
        label: "Levelek",
        run: { started_at: LATE_EVENING_UTC, finished_at: null, outcome: "ok", error: null },
      },
    ],
    deadLettered: 0,
    consentWarnings: [],
    timeZone: "UTC",
  };
  const page = layout("Beérkezett", status, inboxPage([item], "UTC")).value;
  assert.equal(page.split("2026. 09. 20. 22:30").length - 1, 2, "status bar and inbox row");
  assert.ok(!page.includes("2026. 09. 21."));
});
