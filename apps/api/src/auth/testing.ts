import type { LoginCodeSender } from './sender.js';
import type {
  AuthService,
  AuthUser,
  RefreshedSession,
  SessionIdentity,
  VerifiedSession,
  VerifyCodeInput,
} from './service.js';

/*
 * In-memory test doubles for the auth layer. Fully implemented: they are test
 * infrastructure, not production logic, and let handler / middleware / flow
 * tests run without Postgres (createApp never imports db).
 */

export type SentCode = { email: string; code: string };

export type FakeSender = LoginCodeSender & { readonly sent: SentCode[] };

/** A LoginCodeSender that records every call instead of delivering anything. */
export function createFakeSender(): FakeSender {
  const sent: SentCode[] = [];
  return {
    sent,
    async sendLoginCode(email, code) {
      sent.push({ email, code });
    },
  };
}

const normalize = (raw: string): string => raw.trim().toLowerCase();

export type FakeAuthService = AuthService & {
  /** The sender the fake drove, for asserting what (if anything) was delivered. */
  readonly sender: FakeSender;
};

/**
 * A believable in-memory AuthService. It mirrors the real flow closely enough to
 * drive a request → verify → authenticated-route → logout test end to end:
 *   - one live code per email, six digits, single-use, 5-attempt cap
 *   - first verify creates the user (with the supplied timezone)
 *   - sessions are bearer tokens resolvable by authenticate, revocable by logout
 *
 * Time-based expiry is NOT modelled here (the fake has no clock); expiry and the
 * at-most-hourly last_seen refresh are proven against real Postgres in the db
 * package. For the handler matrix (consumed / expired / unknown / wrong all →
 * 401), tests use a minimal vi.fn()-based AuthService instead.
 */
export function createFakeAuthService(): FakeAuthService {
  const sender = createFakeSender();
  const codes = new Map<string, { code: string; attempts: number; consumed: boolean }>();
  const usersByEmail = new Map<string, AuthUser>();
  const sessions = new Map<
    string,
    {
      userId: string;
      sessionId: string;
      revoked: boolean;
      previousToken?: string;
      rotatedAt?: number;
    }
  >();

  let codeCounter = 100000; // keeps generated codes six digits
  let idCounter = 0;
  const nextId = (prefix: string): string => `${prefix}-${++idCounter}`;

  return {
    sender,

    async requestCode(rawEmail) {
      const email = normalize(rawEmail);
      const code = String(codeCounter++).padStart(6, '0');
      // One live code per email: a new request replaces any outstanding one.
      codes.set(email, { code, attempts: 0, consumed: false });
      await sender.sendLoginCode(email, code);
    },

    async verifyCode(input: VerifyCodeInput): Promise<VerifiedSession | null> {
      const email = normalize(input.email);
      const live = codes.get(email);
      if (!live || live.consumed || live.attempts >= 5) return null;
      if (live.code !== input.code) {
        live.attempts += 1;
        return null;
      }
      live.consumed = true;

      let isNewUser = false;
      let user = usersByEmail.get(email);
      if (!user) {
        const now = new Date();
        user = {
          id: crypto.randomUUID(),
          email,
          timezone: input.timezone,
          displayName: null,
          createdAt: now,
          updatedAt: now,
        };
        usersByEmail.set(email, user);
        isNewUser = true;
      }

      const token = nextId('token');
      sessions.set(token, { userId: user.id, sessionId: nextId('session'), revoked: false });
      return { token, user, isNewUser };
    },

    async authenticate(rawToken): Promise<SessionIdentity | null> {
      const session = sessions.get(rawToken);
      if (session && !session.revoked) {
        return { userId: session.userId, sessionId: session.sessionId };
      }

      // Reuse detection: check if any session has this as its previous token.
      for (const [, s] of sessions) {
        if (s.revoked || s.previousToken !== rawToken) continue;
        const GRACE_MS = 30_000;
        if (s.rotatedAt && Date.now() - s.rotatedAt <= GRACE_MS) {
          return { userId: s.userId, sessionId: s.sessionId };
        }
        s.revoked = true;
        return null;
      }
      return null;
    },

    async refreshSession(rawToken): Promise<RefreshedSession | null> {
      const session = sessions.get(rawToken);
      if (!session || session.revoked) return null;

      const newToken = nextId('token');
      sessions.delete(rawToken);
      session.previousToken = rawToken;
      session.rotatedAt = Date.now();
      sessions.set(newToken, session);
      return { token: newToken, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) };
    },

    async revokeSession(sessionId) {
      for (const session of sessions.values()) {
        if (session.sessionId === sessionId) session.revoked = true;
      }
    },

    async revokeAllSessions(userId) {
      for (const session of sessions.values()) {
        if (session.userId === userId) session.revoked = true;
      }
    },
  };
}
