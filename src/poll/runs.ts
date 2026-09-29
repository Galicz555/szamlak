import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { parseRow } from "../db/rows.ts";
import { instant, type Clock } from "../shared/time.ts";

export type RunKind = "mail" | "extract" | "bank" | "backup";

export function startRun(db: DatabaseSync, clock: Clock, kind: RunKind): string {
  const id = randomUUID();
  db.prepare(`INSERT INTO poll_run (id, kind, started_at) VALUES (?, ?, ?)`).run(
    id,
    kind,
    instant(clock),
  );
  return id;
}

/** `error: null` records the run as ok. */
export function finishRun(
  db: DatabaseSync,
  clock: Clock,
  id: string,
  { error }: { error: string | null },
): void {
  db.prepare(`UPDATE poll_run SET finished_at = ?, outcome = ?, error = ? WHERE id = ?`).run(
    instant(clock),
    error === null ? "ok" : "error",
    error,
    id,
  );
}

const runRow = z.object({
  started_at: z.string(),
  finished_at: z.string().nullable(),
  outcome: z.enum(["ok", "error"]).nullable(),
  error: z.string().nullable(),
});
export type RunRow = z.infer<typeof runRow>;

export function getLastRun(db: DatabaseSync, kind: RunKind): RunRow | undefined {
  return parseRow(
    runRow,
    db
      .prepare(
        `SELECT started_at, finished_at, outcome, error FROM poll_run WHERE kind = ?
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(kind),
  );
}

export function getLastSuccessAt(db: DatabaseSync, kind: RunKind): string | undefined {
  return parseRow(
    z.object({ started_at: z.string() }),
    db
      .prepare(
        `SELECT started_at FROM poll_run WHERE kind = ? AND outcome = 'ok'
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(kind),
  )?.started_at;
}
