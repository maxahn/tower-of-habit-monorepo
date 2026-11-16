import {
  consumeCode,
  createSession,
  createUser,
  findLiveCodeForEmail,
  findLiveSessionByHash,
  findUserByEmail,
  insertAuthCode,
  invalidateCodesForEmail,
  recordFailedAttempt,
  revokeAllForUser,
  revokeSession,
  touchLastSeen,
  type Db,
} from '@tower-of-habit/db';
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
 * The real, Postgres-backed auth service.
 *
 * NOTE(2.9, Pass 1): the factory and its dependency wiring are real, but the
 * method bodies are deferred to Pass 3. The db query helpers it composes
 * (invalidateCodesForEmail, consumeCode, createSession, …) are themselves
 * Pass-1 stubs, covered by the db package's own tests.
 */
export function createAuthService(deps: AuthServiceDeps): AuthService {
  void deps;
  void [
    consumeCode,
    createSession,
    createUser,
    findLiveCodeForEmail,
    findLiveSessionByHash,
    findUserByEmail,
    insertAuthCode,
    invalidateCodesForEmail,
    recordFailedAttempt,
    revokeAllForUser,
    revokeSession,
    touchLastSeen,
  ];
  return {
    async requestCode(email) {
      void email;
      throw new Error('not implemented');
    },
    async verifyCode(input) {
      void input;
      throw new Error('not implemented');
    },
    async authenticate(rawToken) {
      void rawToken;
      throw new Error('not implemented');
    },
    async revokeSession(sessionId) {
      void sessionId;
      throw new Error('not implemented');
    },
    async revokeAllSessions(userId) {
      void userId;
      throw new Error('not implemented');
    },
  };
}
