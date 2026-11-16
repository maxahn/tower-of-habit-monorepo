import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AUTH_HEADER, buildTestApp, readErrorBody } from './testing/harness.js';
import { jsonBody, ROOT_FIELD, zodFieldDetails } from './validation.js';

const signupSchema = z.object({
  email: z.email(),
  displayName: z.string().min(1).max(20),
  address: z.object({ city: z.string().min(1) }),
});

function appWithSignup() {
  const received: unknown[] = [];
  const harness = buildTestApp({
    mountRoutes: (api) => {
      api.post('/signup', jsonBody(signupSchema), (c) => {
        const body = c.req.valid('json');
        received.push(body);
        return c.json({ ok: true, email: body.email }, 201);
      });
    },
  });
  return { ...harness, received };
}

function post(app: ReturnType<typeof appWithSignup>['app'], body: string) {
  return app.request('/v1/signup', {
    method: 'POST',
    headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
    body,
  });
}

const VALID = { email: 'a@b.co', displayName: 'Ada', address: { city: 'Austin' } };

describe('zodFieldDetails', () => {
  it('keys messages by dotted path', () => {
    const result = signupSchema.safeParse({
      email: 'nope',
      displayName: 'Ada',
      address: { city: '' },
    });
    expect(result.success).toBe(false);
    const details = zodFieldDetails(result.error!);
    expect(Object.keys(details).sort()).toEqual(['address.city', 'email']);
    expect(details.email).toHaveLength(1);
    expect(details['address.city']).toHaveLength(1);
  });

  it('keeps every message for a field, in issue order', () => {
    const schema = z.object({
      password: z.string().min(8, 'too short').regex(/\d/, 'needs a digit'),
    });
    const result = schema.safeParse({ password: 'abc' });
    expect(zodFieldDetails(result.error!)).toEqual({ password: ['too short', 'needs a digit'] });
  });

  it('puts array indices in the path', () => {
    const schema = z.object({ items: z.array(z.object({ name: z.string() })) });
    const result = schema.safeParse({ items: [{ name: 'x' }, { name: 1 }] });
    expect(Object.keys(zodFieldDetails(result.error!))).toEqual(['items.1.name']);
  });

  it(`puts a root-level issue under ${ROOT_FIELD}`, () => {
    const result = signupSchema.safeParse('not an object');
    expect(Object.keys(zodFieldDetails(result.error!))).toEqual([ROOT_FIELD]);
  });
});

describe('jsonBody + error envelope', () => {
  it('passes a valid, parsed body to the handler', async () => {
    const { app, received } = appWithSignup();
    const res = await post(app, JSON.stringify({ ...VALID, extra: 'dropped' }));
    expect(res.status).toBe(201);
    expect(received).toEqual([VALID]);
  });

  it('maps a schema failure to 400 validation_failed with field-keyed details', async () => {
    const { app, received } = appWithSignup();
    const res = await post(app, JSON.stringify({ email: 'nope', address: { city: '' } }));

    expect(res.status).toBe(400);
    const { error } = await readErrorBody(res);
    expect(error.code).toBe('validation_failed');
    expect(error.message).toEqual(expect.any(String));
    const details = error.details as Record<string, unknown>;
    expect(Object.keys(details).sort()).toEqual(['address.city', 'displayName', 'email']);
    for (const messages of Object.values(details)) {
      expect(messages).toEqual([expect.any(String)]);
    }
    expect(received).toEqual([]);
  });

  it('uses the same mapping for a ZodError thrown from a handler', async () => {
    const { app } = buildTestApp({
      mountRoutes: (api) => {
        api.get('/parse', () => {
          z.object({ n: z.number() }).parse({ n: 'x' });
          return new Response('unreachable');
        });
      },
    });
    const res = await app.request('/v1/parse', { headers: AUTH_HEADER });
    expect(res.status).toBe(400);
    const { error } = await readErrorBody(res);
    expect(error.code).toBe('validation_failed');
    expect(Object.keys(error.details as object)).toEqual(['n']);
  });

  it('maps a JSON-shaped root failure to the root key', async () => {
    const { app } = appWithSignup();
    const res = await post(app, JSON.stringify([1, 2, 3]));
    expect(res.status).toBe(400);
    const { error } = await readErrorBody(res);
    expect(error.code).toBe('validation_failed');
    expect(Object.keys(error.details as object)).toEqual([ROOT_FIELD]);
  });

  it.each(['{"email": ', 'not json', ''])(
    'maps a malformed body %j to 400 invalid_json',
    async (body) => {
      const { app, received } = appWithSignup();
      const res = await post(app, body);
      expect(res.status).toBe(400);
      expect((await readErrorBody(res)).error.code).toBe('invalid_json');
      expect(received).toEqual([]);
    }
  );
});
