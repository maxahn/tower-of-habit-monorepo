import {
  findHabitTower,
  getHabit,
  getUser,
  listEntriesForHabit,
  listTiers,
  qualifyingEntryForDate,
  recordEntry,
  transitionMembership,
  updateMembership,
  type Db,
  type Entry,
  type Habit,
} from '@tower-of-habit/db';
import {
  civilInZone,
  DEFAULT_GRACE_WINDOW_MINUTES,
  gapFillCandidate,
  logEntryRequestSchema,
  resolveLocalDate,
  SOLO_DEADLINE_TIME,
  wallClockToInstant,
  type EntryListResponse,
  type EntrySource,
  type LogEntryResponse,
} from '@tower-of-habit/shared';
import { HabitConfigError, qualifies, stepMembership } from '@tower-of-habit/shared/evaluator';
import type { Hono } from 'hono';
import type { AppEnv } from '../app.js';
import { withTx, type RequestCtx, type TxRunner } from '../context.js';
import { DomainError } from '../errors.js';
import { jsonBody } from '../validation.js';

/**
 * 2.16: logging.
 *   POST /entries              log against one of the caller's habits
 *   GET  /habits/:id/entries   the habit's entries, newest first
 *
 * The day boundary (D3): the tower's zone, deadline and grace for a bound
 * habit; the user's zone (overridable per request) with the solo midnight
 * boundary otherwise. The server derives the date from ctx.now; a client
 * `localDate` is validated against that window, never trusted (P7).
 * Qualification is 2.3's. A qualifying log by an automatically dormant member
 * returns them to active (2.5), effective from the open period.
 */

export type EntryRouteDeps = { db: TxRunner };

async function ownHabit(tx: Db, ctx: RequestCtx, id: string): Promise<Habit> {
  const habit = await getHabit(tx, id);
  if (!habit || habit.ownerId !== ctx.userId) {
    throw new DomainError(404, 'not_found', 'Habit not found');
  }
  return habit;
}

/** live before the day's deadline, grace at or after it. */
function sourceOf(
  entry: Pick<Entry, 'localDate' | 'loggedAt'>,
  deadlineTime: string,
  timeZone: string
): EntrySource {
  const deadline = wallClockToInstant(entry.localDate, deadlineTime, timeZone);
  return entry.loggedAt.getTime() >= deadline.getTime() ? 'grace' : 'live';
}

export function mountEntryRoutes(api: Hono<AppEnv>, deps: EntryRouteDeps): void {
  api.post('/entries', jsonBody(logEntryRequestSchema), (c) =>
    withTx(deps.db, c, async (tx, ctx) => {
      const body = c.req.valid('json');
      const habit = await ownHabit(tx, ctx, body.habitId);
      const bound = await findHabitTower(tx, habit.id);
      const user = await getUser(tx, ctx.userId);

      // D3: which clock owns "today".
      const timeZone = bound ? bound.tower.timezone : (body.timezone ?? user?.timezone ?? 'UTC');
      const deadlineTime = bound ? bound.tower.deadlineTime : SOLO_DEADLINE_TIME;
      const graceMinutes = bound ? bound.tower.graceWindowMinutes : DEFAULT_GRACE_WINDOW_MINUTES;
      const window = { loggedAt: ctx.now, timeZone, deadlineTime, graceMinutes };

      const today = civilInZone(ctx.now, timeZone).date;
      const candidate = gapFillCandidate(window); // yesterday, while its grace window is open
      const yesterdayIsFilled =
        candidate !== null && (await qualifyingEntryForDate(tx, habit.id, candidate)) !== undefined;
      let localDate: string;
      if (body.localDate !== undefined) {
        if (body.localDate !== today && body.localDate !== candidate) {
          throw new DomainError(
            400,
            'date_out_of_window',
            'localDate must be today, or yesterday while its grace window is open'
          );
        }
        localDate = body.localDate;
      } else {
        localDate = resolveLocalDate({ ...window, yesterdayIsFilled });
      }

      let verdict: boolean;
      try {
        verdict = qualifies(
          { type: habit.type, tiers: await listTiers(tx, habit.id) },
          { numericValue: body.numericValue ?? null, tierReached: body.tierReached ?? 0 }
        );
      } catch (e) {
        if (e instanceof HabitConfigError) {
          throw new DomainError(409, 'habit_misconfigured', 'The habit has no base threshold');
        }
        throw e;
      }

      const { entry, created } = await recordEntry(tx, {
        habitId: habit.id,
        localDate,
        loggedAt: ctx.now,
        qualifies: verdict,
        ...(body.tierReached !== undefined ? { tierReached: body.tierReached } : {}),
        ...(body.numericValue !== undefined ? { numericValue: body.numericValue } : {}),
        ...(body.clientEntryId !== undefined ? { clientEntryId: body.clientEntryId } : {}),
      });

      if (created && verdict && bound) {
        const m = bound.membership;
        if (m.lastQualifyingDate === null || m.lastQualifyingDate < localDate) {
          await updateMembership(tx, m.id, { lastQualifyingDate: localDate });
        }
        // 2.5: an automatically dormant member who logs once returns to active.
        const step = stepMembership(
          {
            membershipId: m.id,
            state: m.state,
            dormancyReason: m.dormancyReason,
            consecutiveMisses: m.consecutiveMissedPeriods,
            lastQualifyingDate: m.lastQualifyingDate,
            joinedOn: civilInZone(m.joinedAt, timeZone).date,
            voluntaryReturnDate: m.voluntaryReturnDate,
          },
          { kind: 'qualifying_entry', localDate, openPeriodStart: localDate }
        );
        if (step.transition?.to === 'active') {
          await transitionMembership(tx, m.id, { to: 'active' }, ctx.now);
        }
      }

      const response: LogEntryResponse = {
        entry: {
          ...(entry as unknown as LogEntryResponse['entry']),
          source: sourceOf(entry, deadlineTime, timeZone),
        },
        qualifies: verdict,
        created,
      };
      return c.json(response, created ? 201 : 200);
    })
  );

  api.get('/habits/:id/entries', (c) =>
    withTx(deps.db, c, async (tx, ctx) => {
      const habit = await ownHabit(tx, ctx, c.req.param('id'));
      const rows = await listEntriesForHabit(tx, habit.id);
      const body: EntryListResponse = { entries: rows as unknown as EntryListResponse['entries'] };
      return c.json(body);
    })
  );
}
