import { and, eq } from 'drizzle-orm';
import type { db as appDb } from '../../client.js';
import { memberships, type DormancyReason, type MembershipState } from './schema.js';

type Db = typeof appDb;
export type Membership = typeof memberships.$inferSelect;
// State, counters and dates come from defaults.
export type NewMembership = Pick<typeof memberships.$inferInsert, 'towerId' | 'userId' | 'habitId'>;
// Evaluator-owned fields. State and the dormancy fields change only through
// transitionMembership; tower, user and habit are immutable.
export type MembershipPatch = Partial<
  Pick<
    typeof memberships.$inferInsert,
    'consecutiveMissedPeriods' | 'lastQualifyingDate' | 'voluntaryReturnDate'
  >
>;

// Going dormant needs a reason, so it can't be expressed without one.
export type MembershipTransition =
  { to: 'dormant'; reason: DormancyReason } | { to: Exclude<MembershipState, 'dormant'> };

export const ALLOWED_MEMBERSHIP_TRANSITIONS: Record<MembershipState, readonly MembershipState[]> = {
  active: ['at_risk', 'dormant', 'removed'],
  at_risk: ['active', 'dormant', 'removed'],
  dormant: ['active', 'removed'],
  removed: [],
};

export class IllegalMembershipTransitionError extends Error {
  constructor(
    readonly from: MembershipState,
    readonly to: MembershipState
  ) {
    super(`Illegal membership state transition: ${from} -> ${to}`);
    this.name = 'IllegalMembershipTransitionError';
  }
}

export class MembershipNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Membership not found: ${id}`);
    this.name = 'MembershipNotFoundError';
  }
}

/** Pure check, usable by the evaluator before it touches the DB. */
export function assertMembershipTransition(from: MembershipState, to: MembershipState): void {
  if (!ALLOWED_MEMBERSHIP_TRANSITIONS[from].includes(to)) {
    throw new IllegalMembershipTransitionError(from, to);
  }
}

export async function createMembership(db: Db, input: NewMembership): Promise<Membership> {
  const { towerId, userId, habitId } = input;
  // A second live tower for the habit surfaces as one_active_tower_per_habit (23505).
  const [row] = await db.insert(memberships).values({ towerId, userId, habitId }).returning();
  return row!;
}

export async function getMembership(db: Db, id: string): Promise<Membership | undefined> {
  const [row] = await db.select().from(memberships).where(eq(memberships.id, id));
  return row;
}

export async function listMembershipsForTower(db: Db, towerId: string): Promise<Membership[]> {
  return db.select().from(memberships).where(eq(memberships.towerId, towerId));
}

export async function updateMembership(
  db: Db,
  id: string,
  patch: MembershipPatch
): Promise<Membership> {
  // Runtime guard: the type forbids these keys, but callers may pass untyped data.
  const {
    id: _id,
    towerId,
    userId,
    habitId,
    state,
    dormantSince,
    dormancyReason,
    joinedAt,
    ...safe
  } = patch as Record<string, unknown>;
  void [_id, towerId, userId, habitId, state, dormantSince, dormancyReason, joinedAt];
  if (Object.keys(safe).length === 0) {
    const existing = await getMembership(db, id);
    if (!existing) throw new MembershipNotFoundError(id);
    return existing;
  }
  const [row] = await db.update(memberships).set(safe).where(eq(memberships.id, id)).returning();
  if (!row) throw new MembershipNotFoundError(id);
  return row;
}

export async function deleteMembership(db: Db, id: string): Promise<void> {
  await db.delete(memberships).where(eq(memberships.id, id));
}

export async function transitionMembership(
  db: Db,
  id: string,
  t: MembershipTransition
): Promise<Membership> {
  const current = await getMembership(db, id);
  if (!current) throw new MembershipNotFoundError(id);
  const from = current.state;
  assertMembershipTransition(from, t.to);

  // Dormancy fields are set iff dormant (memberships_dormancy_iff_dormant).
  // Back to active resets the miss counter: a qualifying period or a return.
  const [row] = await db
    .update(memberships)
    .set({
      state: t.to,
      ...(t.to === 'dormant'
        ? { dormantSince: new Date(), dormancyReason: t.reason }
        : { dormantSince: null, dormancyReason: null }),
      ...(t.to === 'active' ? { consecutiveMissedPeriods: 0 } : {}),
    })
    // Conditioning on the observed `from` makes a concurrent transition lose
    // cleanly (zero rows) instead of overwriting.
    .where(and(eq(memberships.id, id), eq(memberships.state, from)))
    .returning();
  if (!row) {
    const latest = await getMembership(db, id);
    if (!latest) throw new MembershipNotFoundError(id);
    throw new IllegalMembershipTransitionError(latest.state, t.to);
  }
  return row;
}
