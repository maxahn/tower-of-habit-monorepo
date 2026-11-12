import { z } from 'zod';
import { dormancyReasonSchema, membershipStateSchema } from '../enums.js';
import { localDate, nonNegativeInt, timestamp, uuid } from './common.js';

/*
 * Membership response. Mirrors Membership in @tower-of-habit/db
 * (towers/memberships/schema.ts). Joining is joinTowerRequestSchema; state
 * changes are server-driven, so there is no request body here.
 */

export const membershipResponseSchema = z
  .object({
    id: uuid,
    towerId: uuid,
    userId: uuid,
    habitId: uuid,
    state: membershipStateSchema,
    consecutiveMissedPeriods: nonNegativeInt,
    lastQualifyingDate: localDate.nullable(),
    dormantSince: timestamp.nullable(),
    dormancyReason: dormancyReasonSchema.nullable(),
    voluntaryReturnDate: localDate.nullable(),
    joinedAt: timestamp,
  })
  // memberships_dormancy_iff_dormant
  .refine(
    (m) => (m.state === 'dormant') === (m.dormantSince !== null && m.dormancyReason !== null),
    {
      message: 'dormantSince and dormancyReason are set exactly when state is dormant',
      path: ['state'],
    }
  );
export type MembershipResponse = z.infer<typeof membershipResponseSchema>;
