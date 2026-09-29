import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { instant, type Clock } from "../shared/time.ts";

export async function saveOauthState(
  db: Kysely<Database>,
  state: string,
  aspsp: { name: string; country: string },
  expiresAt: string,
): Promise<void> {
  await db
    .insertInto("oauth_state")
    .values({
      state,
      aspsp_name: aspsp.name,
      aspsp_country: aspsp.country,
      expires_at: expiresAt,
    })
    .execute();
}

/** Single use: the row is deleted whether or not it has expired. */
export async function takeOauthState(
  db: Kysely<Database>,
  clock: Clock,
  state: string,
): Promise<{ name: string; country: string } | undefined> {
  const row = await db
    .deleteFrom("oauth_state")
    .where("state", "=", state)
    .returning(["aspsp_name", "aspsp_country", "expires_at"])
    .executeTakeFirst();
  if (!row || row.expires_at < instant(clock)) return undefined;
  return { name: row.aspsp_name, country: row.aspsp_country };
}
