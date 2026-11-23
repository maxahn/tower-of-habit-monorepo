import { getPushTokenByToken } from '@tower-of-habit/db';
import { db } from '@tower-of-habit/db';
import { describe, expect, it } from 'vitest';
import { useIntegrationApp } from '../testing/integration.js';

const t = useIntegrationApp();

describe('POST /v1/push-tokens', () => {
  it('registers a push token', async () => {
    const alice = await t.fixtures.user();
    const res = await t.request('/v1/push-tokens', {
      as: alice,
      json: { token: 'ExponentPushToken[abc123]', platform: 'ios' },
    });
    expect(res.status).toBe(204);

    const row = await getPushTokenByToken(db, 'ExponentPushToken[abc123]');
    expect(row).toBeDefined();
    expect(row!.userId).toBe(alice.user.id);
    expect(row!.platform).toBe('ios');
  });

  it('re-registers the same token (upsert)', async () => {
    const alice = await t.fixtures.user();
    await t.request('/v1/push-tokens', {
      as: alice,
      json: { token: 'ExponentPushToken[abc123]', platform: 'ios' },
    });
    const res2 = await t.request('/v1/push-tokens', {
      as: alice,
      json: { token: 'ExponentPushToken[abc123]', platform: 'ios' },
    });
    expect(res2.status).toBe(204);
  });

  it('reassigns token to a different user', async () => {
    const alice = await t.fixtures.user();
    const bob = await t.fixtures.user();
    await t.request('/v1/push-tokens', {
      as: alice,
      json: { token: 'ExponentPushToken[shared]', platform: 'android' },
    });
    await t.request('/v1/push-tokens', {
      as: bob,
      json: { token: 'ExponentPushToken[shared]', platform: 'android' },
    });
    const row = await getPushTokenByToken(db, 'ExponentPushToken[shared]');
    expect(row!.userId).toBe(bob.user.id);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await t.request('/v1/push-tokens', {
      json: { token: 'ExponentPushToken[abc123]', platform: 'ios' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects invalid platform', async () => {
    const alice = await t.fixtures.user();
    const res = await t.request('/v1/push-tokens', {
      as: alice,
      json: { token: 'ExponentPushToken[abc123]', platform: 'web' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects empty token', async () => {
    const alice = await t.fixtures.user();
    const res = await t.request('/v1/push-tokens', {
      as: alice,
      json: { token: '', platform: 'ios' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects token with surrounding whitespace', async () => {
    const alice = await t.fixtures.user();
    const res = await t.request('/v1/push-tokens', {
      as: alice,
      json: { token: ' ExponentPushToken[abc123] ', platform: 'ios' },
    });
    expect(res.status).toBe(400);
  });
});
