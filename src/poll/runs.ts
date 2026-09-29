import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { instant, type Clock } from "../shared/time.ts";

export type RunKind = "mail" | "extract" | "bank" | "backup";

export async function startRun(db: Kysely<Database>, clock: Clock, kind: RunKind): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("poll_run")
    .values({ id, kind, started_at: instant(clock) })
    .execute();
  return id;
}

/** `error: null` records the run as ok. */
export async function finishRun(
  db: Kysely<Database>,
  clock: Clock,
  id: string,
  { error }: { error: string | null },
): Promise<void> {
  await db
    .updateTable("poll_run")
    .set({ finished_at: instant(clock), outcome: error === null ? "ok" : "error", error })
    .where("id", "=", id)
    .execute();
}

export interface RunRow {
  started_at: string;
  finished_at: string | null;
  outcome: "ok" | "error" | null;
  error: string | null;
}

export function getLastRun(db: Kysely<Database>, kind: RunKind): Promise<RunRow | undefined> {
  return db
    .selectFrom("poll_run")
    .select(["started_at", "finished_at", "outcome", "error"])
    .where("kind", "=", kind)
    .orderBy("started_at", "desc")
    .limit(1)
    .executeTakeFirst();
}

export async function getLastSuccessAt(
  db: Kysely<Database>,
  kind: RunKind,
): Promise<string | undefined> {
  const row = await db
    .selectFrom("poll_run")
    .select("started_at")
    .where("kind", "=", kind)
    .where("outcome", "=", "ok")
    .orderBy("started_at", "desc")
    .limit(1)
    .executeTakeFirst();
  return row?.started_at;
}
