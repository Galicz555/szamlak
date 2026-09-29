import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/schema.ts";
import type { MailCursor } from "./mailbox.ts";

export async function getMailCursor(db: Kysely<Database>): Promise<MailCursor | null> {
  const row = await db
    .selectFrom("mail_cursor")
    .select(["uid_validity", "last_uid"])
    .limit(1)
    .executeTakeFirst();
  return row ? { uidValidity: row.uid_validity, lastUid: row.last_uid } : null;
}

/** Takes a transaction: the cursor only moves together with the queue rows it stands for. */
export async function saveMailCursor(
  trx: Transaction<Database>,
  { mailbox, uidValidity, lastUid }: { mailbox: string; uidValidity: string; lastUid: number },
): Promise<void> {
  await trx
    .insertInto("mail_cursor")
    .values({ mailbox, uid_validity: uidValidity, last_uid: lastUid })
    .onConflict((oc) =>
      oc.column("mailbox").doUpdateSet((eb) => ({
        uid_validity: eb.ref("excluded.uid_validity"),
        last_uid: eb.ref("excluded.last_uid"),
      })),
    )
    .execute();
}
