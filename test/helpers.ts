import { migrate, openDb, type Db } from "../src/db/db.ts";
import { createLogger, type Logger } from "../src/log.ts";
import type { Clock } from "../src/shared/time.ts";

/** A fresh database built by the same migration chain production runs. */
export function memDb(): Db {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

export function fixedClock(iso: string): Clock & { set(iso: string): void } {
  let now = new Date(iso);
  return {
    now: () => new Date(now),
    set: (next: string) => {
      now = new Date(next);
    },
  };
}

export const silentLog: Logger = createLogger("silent");

/**
 * A scripted fake: answers the planned calls in order and fails the test on any call it was
 * not told to expect (guide C§10.2).
 */
export function scripted<T>(
  name: string,
  answers: (() => T)[],
): { next: () => T; left: () => number } {
  const queue = [...answers];
  return {
    next: () => {
      const answer = queue.shift();
      if (!answer) throw new Error(`${name}: unexpected call`);
      return answer();
    },
    left: () => queue.length,
  };
}
