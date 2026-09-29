import type { z } from "zod";

/**
 * Row shape checks at the one place SQL results enter typed code. A column renamed in a
 * migration but not in a query fails here, in the test that runs the query, not as `undefined`
 * three calls later.
 */
export function parseRow<S extends z.ZodType>(schema: S, row: unknown): z.infer<S> | undefined {
  return row === undefined ? undefined : schema.parse(row);
}

export function parseRows<S extends z.ZodType>(schema: S, rows: unknown[]): z.infer<S>[] {
  return rows.map((r) => schema.parse(r));
}
