import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../testing/harness.js';
import { buildOpenApiDocument, DOCS_PATH, OPENAPI_PATH } from './openapi.js';

/*
 * The OpenAPI spec is hand-maintained; these tests pin its shape and — most
 * importantly — act as a drift guard: every live route must appear in the spec.
 */

const doc = buildOpenApiDocument() as {
  openapi: string;
  paths: Record<
    string,
    Record<
      string,
      { security?: unknown[]; requestBody?: unknown; responses: Record<string, unknown> }
    >
  >;
  components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> };
};

const EXPECTED_PATHS = [
  '/healthz',
  '/readyz',
  '/v1/auth/request-code',
  '/v1/auth/verify-code',
  '/v1/auth/logout',
  '/v1/auth/sessions/revoke-all',
  '/v1/me',
  '/v1/me/sessions',
  '/v1/habits',
  '/v1/habits/{id}',
  '/v1/habits/{id}/tiers',
  '/v1/habits/{id}/archive',
] as const;

describe('buildOpenApiDocument', () => {
  it('is an OpenAPI 3.0.3 document', () => {
    expect(doc.openapi).toBe('3.0.3');
  });

  it('documents every live route (drift guard)', () => {
    expect(Object.keys(doc.paths).sort()).toEqual([...EXPECTED_PATHS].sort());
  });

  it('declares a bearer security scheme and an ErrorResponse component', () => {
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    expect(doc.components.schemas.ErrorResponse).toBeDefined();
  });

  it('requires bearer auth on the authenticated routes only', () => {
    expect(doc.paths['/v1/auth/logout']!.post!.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.paths['/v1/auth/sessions/revoke-all']!.post!.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.paths['/v1/auth/request-code']!.post!.security).toBeUndefined();
    expect(doc.paths['/v1/auth/verify-code']!.post!.security).toBeUndefined();
  });

  it('points error responses at the shared ErrorResponse component', () => {
    const notFound = doc.paths['/v1/auth/verify-code']!.post!.responses['401'] as {
      content: { 'application/json': { schema: { $ref: string } } };
    };
    expect(notFound.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/ErrorResponse'
    );
  });

  it('documents 429 with Retry-After on the rate-limited auth routes', () => {
    for (const path of ['/v1/auth/request-code', '/v1/auth/verify-code']) {
      const limited = doc.paths[path]!.post!.responses['429'] as {
        headers: Record<string, unknown>;
        content: { 'application/json': { schema: { $ref: string } } };
      };
      expect(limited.headers['Retry-After']).toBeDefined();
      expect(limited.content['application/json'].schema.$ref).toBe(
        '#/components/schemas/ErrorResponse'
      );
    }
  });

  it('describes the verify-code request and success bodies from the zod schemas', () => {
    const post = doc.paths['/v1/auth/verify-code']!.post!;
    const reqSchema = (
      post.requestBody as {
        content: { 'application/json': { schema: { properties: Record<string, unknown> } } };
      }
    ).content['application/json'].schema;
    expect(Object.keys(reqSchema.properties)).toEqual(
      expect.arrayContaining(['email', 'code', 'timezone'])
    );

    const okSchema = (
      post.responses['200'] as {
        content: { 'application/json': { schema: { properties: Record<string, unknown> } } };
      }
    ).content['application/json'].schema;
    expect(Object.keys(okSchema.properties)).toEqual(expect.arrayContaining(['token', 'user']));
  });
});

describe('GET /openapi.json', () => {
  it('is served publicly (no session) with the spec', async () => {
    const { app, auth } = buildTestApp();
    const res = await app.request(OPENAPI_PATH);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(((await res.json()) as { openapi: string }).openapi).toBe('3.0.3');
    expect(auth.calls).toBe(0);
  });
});

describe('GET /docs', () => {
  it('serves the Swagger UI page publicly, loading assets from the CDN', async () => {
    const { app, auth } = buildTestApp();
    const res = await app.request(DOCS_PATH);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('cdnjs.cloudflare.com/ajax/libs/swagger-ui');
    expect(html).toContain(OPENAPI_PATH);
    expect(auth.calls).toBe(0);
  });
});
