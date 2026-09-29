import { z } from "zod";

/** Currencies a bill can be accepted in. */
export const BILL_CURRENCIES = ["HUF", "EUR"] as const;
export type BillCurrency = (typeof BILL_CURRENCIES)[number];

/** What any extractor must return. Validated before anything else reads it. */
export const extractionSchema = z
  .object({
    is_bill: z.boolean(),
    supplier_name: z.string().nullable(),
    invoice_number: z.string().nullable(),
    payer_id: z.string().nullable(),
    amount_due_text: z.string().nullable(),
    currency: z.string().nullable(),
    issue_date: z.string().nullable(),
    due_date: z.string().nullable(),
    iban: z.string().nullable(),
  })
  .strict();
export type Extraction = z.infer<typeof extractionSchema>;

const FIELDS = [
  "is_bill",
  "supplier_name",
  "invoice_number",
  "payer_id",
  "amount_due_text",
  "currency",
  "issue_date",
  "due_date",
  "iban",
] as const;

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };

/** JSON Schema for grammar-constrained decoding (llama.cpp / OpenAI-compatible servers). */
export const extractionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [...FIELDS],
  properties: {
    is_bill: { type: "boolean" },
    supplier_name: nullableString,
    invoice_number: nullableString,
    payer_id: nullableString,
    amount_due_text: nullableString,
    currency: { anyOf: [{ type: "string", enum: [...BILL_CURRENCIES] }, { type: "null" }] },
    issue_date: nullableString,
    due_date: nullableString,
    iban: nullableString,
  },
};

/** The same contract in Gemini's OpenAPI-subset dialect. */
export const extractionGeminiSchema = {
  type: "OBJECT",
  required: [...FIELDS],
  propertyOrdering: [...FIELDS],
  properties: {
    is_bill: { type: "BOOLEAN" },
    supplier_name: { type: "STRING", nullable: true },
    invoice_number: { type: "STRING", nullable: true },
    payer_id: { type: "STRING", nullable: true },
    amount_due_text: { type: "STRING", nullable: true },
    currency: { type: "STRING", enum: [...BILL_CURRENCIES], nullable: true },
    issue_date: { type: "STRING", nullable: true },
    due_date: { type: "STRING", nullable: true },
    iban: { type: "STRING", nullable: true },
  },
};

export const EXTRACTION_PROMPT = `You read Hungarian utility and telecom bills (e.g. MVM, Telekom) and return one JSON object.

Fields:
- is_bill: true only if this document asks the recipient to pay a specific bill (számla, díjbekérő). Newsletters, notices, reminders without a bill: false, all other fields null.
- supplier_name: the issuer (Szolgáltató / Eladó), as printed.
- invoice_number: the bill's own number (Számlaszám / Számla sorszáma), exactly as printed.
- payer_id: the identifier the payer must quote when paying (Fizető azonosító, Ügyfélazonosító, Szerződéses folyószámla, Vevő azonosító), exactly as printed; null if none.
- amount_due_text: the amount the recipient has to pay (Fizetendő összeg / Fizetendő végösszeg; on a settlement bill the final payable or refundable balance), copied character for character as printed, without the currency. A refund / credit balance keeps its minus sign.
- currency: HUF or EUR.
- issue_date: Számla kelte / Kiállítás dátuma, as YYYY-MM-DD.
- due_date: Fizetési határidő, as YYYY-MM-DD.
- iban: the supplier's bank account for the payment, as printed; null if none.

Rules: copy values from the text; never compute, guess or invent. If a value is not in the text, use null.`;
