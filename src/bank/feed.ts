import type { NewTransaction } from "./transactions.ts";

export interface Aspsp {
  name: string;
  country: string;
  maxConsentSeconds: number;
}

export interface AuthorisedSession {
  sessionId: string;
  validUntil: string;
  accounts: {
    uid: string;
    iban: string | null;
    name: string | null;
    currency: string | null;
  }[];
}

export interface AuthorisationRequest {
  aspsp: { name: string; country: string };
  state: string;
  validUntil: string;
  redirectUrl: string;
}

/** Read-only account information. Payment initiation is deliberately absent. */
export interface BankFeed {
  listAspsps(country: string): Promise<Aspsp[]>;
  startAuthorisation(request: AuthorisationRequest): Promise<{ url: string }>;
  createSession(code: string): Promise<AuthorisedSession>;
  bookedTransactions(
    accountUid: string,
    dateFrom: string,
    dateTo: string,
  ): Promise<NewTransaction[]>;
}
