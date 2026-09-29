import type { CalendarDate } from "../shared/time.ts";

export type BillState = "paid" | "awaiting" | "overdue";

/** Derived, never stored: an active match means paid; otherwise the due date decides. */
export function billState(
  bill: { hasActiveMatch: boolean; dueDate: CalendarDate },
  today: CalendarDate,
): BillState {
  if (bill.hasActiveMatch) return "paid";
  // Due on the day itself is not yet overdue. ISO dates compare correctly as strings.
  return bill.dueDate < today ? "overdue" : "awaiting";
}

export function billStateLabel(state: BillState): string {
  switch (state) {
    case "paid":
      return "Fizetve";
    case "awaiting":
      return "Fizetésre vár";
    case "overdue":
      return "Lejárt";
  }
}
