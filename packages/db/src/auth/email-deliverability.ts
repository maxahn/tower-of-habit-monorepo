import type { Db } from '../client.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function markEmailUndeliverable(db: Db, email: string, reason: string): Promise<void> {
  // stub — red phase
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function isEmailDeliverable(db: Db, email: string): Promise<boolean> {
  return true; // stub — red phase
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function clearEmailDeliverability(db: Db, email: string): Promise<void> {
  // stub — red phase
}
