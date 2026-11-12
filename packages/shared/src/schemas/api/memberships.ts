import type { z } from 'zod';
import type { LocalDate } from '../../time/local-date.js';
import type { DormancyReason, MembershipState } from '../enums.js';
import { notImplemented } from '../todo.js';

/*
 * Membership response. Mirrors Membership in @tower-of-habit/db
 * (towers/memberships/schema.ts). Joining is joinTowerRequestSchema (towers.ts);
 * state changes are server-driven, so there is no request body here.
 *
 * TODO(2.1): implement, then replace the hand-written type with z.infer.
 * Rules (tests: ./memberships.test.ts):
 *   - state: membershipStateSchema; dormancyReason: dormancyReasonSchema | null;
 *   - consecutiveMissedPeriods: integer >= 0;
 *   - lastQualifyingDate / voluntaryReturnDate: YYYY-MM-DD or null;
 *   - dormantSince / joinedAt: ISO-8601 with offset;
 *   - memberships_dormancy_iff_dormant: state === 'dormant' exactly when
 *     dormantSince AND dormancyReason are both non-null (a refine).
 */

export type MembershipResponse = {
  id: string;
  towerId: string;
  userId: string;
  habitId: string;
  state: MembershipState;
  consecutiveMissedPeriods: number;
  lastQualifyingDate: LocalDate | null;
  dormantSince: string | null;
  dormancyReason: DormancyReason | null;
  voluntaryReturnDate: LocalDate | null;
  joinedAt: string;
};

export const membershipResponseSchema = notImplemented<z.ZodType<MembershipResponse>>(
  'membershipResponseSchema'
);
