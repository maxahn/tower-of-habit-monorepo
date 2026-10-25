import { eq } from 'drizzle-orm';
import type { db as appDb } from '../client.js';
import { towers } from './schema.js';

type Db = typeof appDb;
export type Tower = typeof towers.$inferSelect;
// Lifecycle and startedAt change only through lifecycle transitions; height
// and currentStreak are evaluator-owned.
export type NewTower = Omit<
  typeof towers.$inferInsert,
  'id' | 'lifecycle' | 'startedAt' | 'createdAt' | 'height' | 'currentStreak' | 'joinCode'
> & { joinCode?: string };
// The host changes only through host reassignment, not a patch.
export type TowerPatch = Partial<Omit<NewTower, 'hostId'>>;

export class InvalidTimeZoneError extends Error {
  constructor(readonly timezone: string) {
    super(`Invalid IANA time zone: ${JSON.stringify(timezone)}`);
    this.name = 'InvalidTimeZoneError';
  }
}

export class TowerNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Tower not found: ${id}`);
    this.name = 'TowerNotFoundError';
  }
}

/**
 * True for IANA identifiers the runtime's ICU knows, e.g. "America/Edmonton".
 *
 * ICU alone isn't enough: it also accepts abbreviations like "PST" (silently
 * mapped to America/Los_Angeles), so require the Area/Location shape. Not
 * Intl.supportedValuesOf('timeZone') either: that lists ICU-canonical names
 * only and rejects valid IANA names browsers send, e.g. "Asia/Kolkata".
 */
export function isValidTimeZone(tz: string): boolean {
  if (tz !== 'UTC' && !tz.includes('/')) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// No 0/O/1/I/L, so codes survive being read aloud or retyped.
const JOIN_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const JOIN_CODE_LENGTH = 8;

export function generateJoinCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(JOIN_CODE_LENGTH));
  // Modulo bias over 31 symbols is negligible for a join code.
  return Array.from(bytes, (b) => JOIN_CODE_ALPHABET[b % JOIN_CODE_ALPHABET.length]).join('');
}

export async function createTower(db: Db, input: NewTower): Promise<Tower> {
  if (!isValidTimeZone(input.timezone)) throw new InvalidTimeZoneError(input.timezone);
  // A join_code collision surfaces as towers_join_code_unique (23505).
  const [row] = await db
    .insert(towers)
    .values({ ...input, joinCode: input.joinCode ?? generateJoinCode() })
    .returning();
  return row!;
}

export async function getTower(db: Db, id: string): Promise<Tower | undefined> {
  const [row] = await db.select().from(towers).where(eq(towers.id, id));
  return row;
}

export async function updateTower(db: Db, id: string, patch: TowerPatch): Promise<Tower> {
  // Runtime guard: the type forbids these keys, but callers may pass untyped data.
  const {
    id: _id,
    hostId,
    lifecycle,
    startedAt,
    createdAt,
    height,
    currentStreak,
    ...safe
  } = patch as Record<string, unknown>;
  void [_id, hostId, lifecycle, startedAt, createdAt, height, currentStreak];
  if (safe.timezone !== undefined && !isValidTimeZone(safe.timezone as string)) {
    throw new InvalidTimeZoneError(safe.timezone as string);
  }
  if (Object.keys(safe).length === 0) {
    const existing = await getTower(db, id);
    if (!existing) throw new TowerNotFoundError(id);
    return existing;
  }
  const [row] = await db.update(towers).set(safe).where(eq(towers.id, id)).returning();
  if (!row) throw new TowerNotFoundError(id);
  return row;
}

export async function deleteTower(db: Db, id: string): Promise<void> {
  await db.delete(towers).where(eq(towers.id, id));
}
