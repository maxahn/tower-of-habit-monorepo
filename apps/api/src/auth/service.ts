import {
  consumeCode,
  createSession,
  createUser,
  findLiveCodeForEmail,
  findLiveSessionByHash,
  findUserByEmail,
  insertAuthCode,
  invalidateCodesForEmail,
  isEmailDeliverable,
  recordFailedAttempt,
  revokeAllForUser,
  revokeSession,
  touchLastSeen,
  type Db,
} from '@tower-of-habit/db';
import { DomainError } from '../errors.js';
import {
  codeMatches,
  generateCode,
  generateSessionToken,
  hashCode,
  hashToken,
  normalizeEmail,
} from './crypto.js';
import type { LoginCodeSender } from './sender.js';

/**
 * The authenticated user as the API returns it. A plain shape, not the db row
 * type, so the handler and the in-memory fake share one contract and the app
 * layer never imports db. Timestamps are Date; Hono's c.json serialises them to
 * ISO strings, which sessionUserSchema validates.
 */
export type AuthUser = {
  id: string;
  email: string;
  timezone: string;
  displayName: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** verify-code success: the raw bearer token (returned once) plus the user. */
export type VerifiedSession = { token: string; user: AuthUser };

/** What the session middleware needs from a live session. */
export type SessionIdentity = { userId: string; sessionId: string };

export type VerifyCodeInput = {
  email: string;
  code: string;
  /** IANA zone, defaulted to UTC by the schema. Used only when creating the user. */
  timezone: string;
  userAgent?: string | null;
};

/**
 * The auth port. The real implementation (createAuthService) is wired in the
 * composition root; handler and middleware tests run against the in-memory fake
 * in testing.ts. Neither request-code nor verify-code signals whether an email
 * has an account.
 */
export interface AuthService {
  /** Issues and sends a fresh code, invalidating any outstanding one. Always resolves. */
  requestCode(email: string): Promise<void>;
  /** Returns a session on the right code, or null for any wrong/consumed/expired/unknown code. */
  verifyCode(input: VerifyCodeInput): Promise<VerifiedSession | null>;
  /** Resolves a raw bearer token to its session identity, or null. */
  authenticate(rawToken: string): Promise<SessionIdentity | null>;
  /** Revokes one session (logout). Idempotent. */
  revokeSession(sessionId: string): Promise<void>;
  /** Revokes every session for the user. */
  revokeAllSessions(userId: string): Promise<void>;
}

export type AuthServiceDeps = {
  db: Db;
  sender: LoginCodeSender;
  /** Code lifetime. Spec: 10 minutes. */
  codeTtlSeconds: number;
  /** Session lifetime. Spec: 90 days. */
  sessionTtlSeconds: number;
};

/**
 * The real, Postgres-backed auth service. Login and signup share one flow:
 * request-code issues a code for any email (always the same work, so account
 * existence is never revealed), and verify-code creates the user on first
 * successful verify. Abuse (code spam) is bounded by rate limiting (2.18).
 */
export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { db, sender, codeTtlSeconds, sessionTtlSeconds } = deps;

  return {
    async requestCode(rawEmail) {
      const email = normalizeEmail(rawEmail);
      if (!(await isEmailDeliverable(db, email))) {
        throw new DomainError(
          422,
          'email_undeliverable',
          'This email address has previously bounced. Please try a different email address.'
        );
      }
      const code = generateCode();
      // One live code per email: drop any outstanding code, then insert the new
      // one. The same work runs whether or not a user exists (users are created
      // only on verify), so nothing here reveals account existence.
      await invalidateCodesForEmail(db, email);
      await insertAuthCode(db, { email, codeHash: hashCode(code), ttlSeconds: codeTtlSeconds });
      await sender.sendLoginCode(email, code);
    },

    async verifyCode(input) {
      const email = normalizeEmail(input.email);
      // One transaction: consume the code, create-or-find the user, open the
      // session — so a crash can't consume a code without issuing a session.
      return db.transaction(async (tx) => {
        const live = await findLiveCodeForEmail(tx, email);
        if (!live) return null;

        if (!codeMatches(input.code, live.codeHash)) {
          await recordFailedAttempt(tx, live.id);
          return null;
        }

        // Compare-and-set: a concurrent verify that already consumed it loses.
        const consumed = await consumeCode(tx, live.id);
        if (!consumed) return null;

        const user =
          (await findUserByEmail(tx, email)) ??
          (await createUser(tx, { email, timezone: input.timezone }));

        const token = generateSessionToken();
        await createSession(tx, {
          userId: user.id,
          tokenHash: hashToken(token),
          userAgent: input.userAgent ?? null,
          ttlSeconds: sessionTtlSeconds,
        });

        return { token, user };
      });
    },

    async authenticate(rawToken) {
      const session = await findLiveSessionByHash(db, hashToken(rawToken));
      if (!session) return null;
      // Refreshes last_seen_at at most once per hour (the query's own guard).
      await touchLastSeen(db, session.id);
      return { userId: session.userId, sessionId: session.id };
    },

    async revokeSession(sessionId) {
      await revokeSession(db, sessionId);
    },

    async revokeAllSessions(userId) {
      await revokeAllForUser(db, userId);
    },
  };
}
