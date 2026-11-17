import {
  meResponseSchema,
  meSessionsResponseSchema,
  requestCodeRequestSchema,
  updateMeRequestSchema,
  verifyCodeRequestSchema,
  verifyCodeResponseSchema,
} from '@tower-of-habit/shared';
import { z } from 'zod';

/**
 * Hand-assembled OpenAPI 3.0.3 document for apps/api. The request/response
 * bodies are generated from the live zod schemas with zod v4's native
 * `z.toJSONSchema` — no third-party OpenAPI library. Pure (no node imports), so
 * it is served by createApp and testable through buildTestApp.
 *
 * Kept in sync with the routes by hand; docs/openapi.test.ts asserts every known
 * path is present, so a new route added without a doc entry fails CI.
 */

export const OPENAPI_PATH = '/openapi.json';
export const DOCS_PATH = '/docs';

const OPENAPI_VERSION = '3.0.3';
const API_VERSION = '0.0.0';

type Json = Record<string, unknown>;

/**
 * Converts a zod schema to an OpenAPI-3.0 Schema Object. Requests use `io:
 * 'input'` (pre-transform shape, honouring `.default()` as optional); responses
 * use `io: 'output'`. The 3.0 target emits `nullable: true` rather than a 3.1
 * type-array, which Swagger UI renders cleanly.
 */
function toSchema(schema: z.ZodType, io: 'input' | 'output'): Json {
  const json = z.toJSONSchema(schema, { target: 'openapi-3.0', io }) as Json;
  delete json.$schema;
  return json;
}

// On input, `email` converts to a bare string (the pre-transform type), so we
// restate the format and bound for readable docs. Matches the shared `email`
// primitive (z.email().max(320)).
const EMAIL_PROPERTY: Json = { type: 'string', format: 'email', maxLength: 320 };

function requestSchemaWithEmail(schema: z.ZodType): Json {
  const json = toSchema(schema, 'input');
  const properties = json.properties as Json | undefined;
  if (properties && 'email' in properties) properties.email = EMAIL_PROPERTY;
  return json;
}

// Mirrors the single error envelope every non-2xx response uses (ErrorBody in
// errors.ts). Hand-written rather than imported from the test harness so prod
// code never pulls in testing utilities.
const ERROR_RESPONSE_SCHEMA: Json = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', description: 'Stable machine-readable error code.' },
        message: { type: 'string', description: 'Human-readable message; may change.' },
        details: { description: 'Optional, code-specific (e.g. validation_failed field map).' },
      },
    },
  },
};

const ERROR_REF: Json = { $ref: '#/components/schemas/ErrorResponse' };

const jsonContent = (schema: Json): Json => ({ 'application/json': { schema } });
const errorResponse = (description: string): Json => ({
  description,
  content: jsonContent(ERROR_REF),
});

// 2.18: fixed 15-minute windows; see auth/routes.ts for the rule constants.
const rateLimitedResponse = (limits: string): Json => ({
  ...errorResponse(`too_many_requests — rate limited (${limits}).`),
  headers: {
    'Retry-After': {
      description: 'Seconds until the rate-limit window resets.',
      schema: { type: 'integer', minimum: 1 },
    },
  },
});

export function buildOpenApiDocument(): Json {
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'Tower of Habit API',
      version: API_VERSION,
      description:
        'Passwordless email-OTP authentication and service health probes (2.9). ' +
        'Authenticated endpoints take a session token as `Authorization: Bearer <token>`.',
    },
    servers: [{ url: '/' }],
    tags: [
      { name: 'health', description: 'Liveness and readiness probes.' },
      { name: 'auth', description: 'Passwordless email-OTP authentication.' },
      { name: 'me', description: 'The authenticated user’s profile and sessions.' },
    ],
    paths: {
      '/healthz': {
        get: {
          tags: ['health'],
          summary: 'Liveness probe',
          responses: {
            '200': {
              description: 'The process is up.',
              content: jsonContent({
                type: 'object',
                required: ['status'],
                properties: { status: { type: 'string', enum: ['ok'] } },
              }),
            },
          },
        },
      },
      '/readyz': {
        get: {
          tags: ['health'],
          summary: 'Readiness probe',
          responses: {
            '200': {
              description: 'All dependencies are reachable.',
              content: jsonContent({
                type: 'object',
                required: ['status', 'checks'],
                properties: {
                  status: { type: 'string', enum: ['ready'] },
                  checks: {
                    type: 'object',
                    required: ['postgres', 'redis'],
                    properties: {
                      postgres: { type: 'string', enum: ['up', 'down'] },
                      redis: { type: 'string', enum: ['up', 'down'] },
                    },
                  },
                },
              }),
            },
            '503': errorResponse(
              'A dependency is unavailable (not_ready) or the server is draining (shutting_down).'
            ),
          },
        },
      },
      '/v1/auth/request-code': {
        post: {
          tags: ['auth'],
          summary: 'Request a login code',
          description:
            'Sends a one-time code to the email. Always 202 whether or not an account exists, so the response never reveals account existence.',
          requestBody: {
            required: true,
            content: jsonContent(requestSchemaWithEmail(requestCodeRequestSchema)),
          },
          responses: {
            '202': { description: 'Accepted. A code is sent if the address can receive one.' },
            '400': errorResponse('validation_failed (bad email) or invalid_json.'),
            '413': errorResponse('Request body too large.'),
            '429': rateLimitedResponse('3 per email and 10 per client IP per 15 minutes'),
          },
        },
      },
      '/v1/auth/verify-code': {
        post: {
          tags: ['auth'],
          summary: 'Verify a login code',
          description:
            'Exchanges a valid code for a session token, creating the user on first login. The code is single-use.',
          requestBody: {
            required: true,
            content: jsonContent(requestSchemaWithEmail(verifyCodeRequestSchema)),
          },
          responses: {
            '200': {
              description: 'Session created. The token is returned once.',
              content: jsonContent(toSchema(verifyCodeResponseSchema, 'output')),
            },
            '401': errorResponse(
              'invalid_code — the code is wrong, consumed, expired, or unknown (one body for all).'
            ),
            '400': errorResponse('validation_failed or invalid_json.'),
            '413': errorResponse('Request body too large.'),
            '429': rateLimitedResponse('10 per email per 15 minutes'),
          },
        },
      },
      '/v1/auth/logout': {
        post: {
          tags: ['auth'],
          summary: 'Log out (revoke the current session)',
          security: [{ bearerAuth: [] }],
          responses: {
            '204': { description: 'The current session is revoked. Idempotent.' },
            '401': errorResponse('Missing or invalid session.'),
          },
        },
      },
      '/v1/auth/sessions/revoke-all': {
        post: {
          tags: ['auth'],
          summary: 'Revoke every session for the user',
          security: [{ bearerAuth: [] }],
          responses: {
            '204': { description: 'All of the user’s sessions are revoked.' },
            '401': errorResponse('Missing or invalid session.'),
          },
        },
      },
      '/v1/me': {
        get: {
          tags: ['me'],
          summary: 'The current user',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'The user plus a count of towers they are active in.',
              content: jsonContent(toSchema(meResponseSchema, 'output')),
            },
            '401': errorResponse('Missing or invalid session.'),
          },
        },
        patch: {
          tags: ['me'],
          summary: 'Update display name and/or timezone',
          description:
            'Email is not changeable in Phase 2. Changing timezone never rewrites past entries.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: jsonContent(toSchema(updateMeRequestSchema, 'input')),
          },
          responses: {
            '200': {
              description: 'Updated.',
              content: jsonContent(toSchema(meResponseSchema, 'output')),
            },
            '400': errorResponse('validation_failed (e.g. unknown IANA zone) or invalid_json.'),
            '401': errorResponse('Missing or invalid session.'),
          },
        },
      },
      '/v1/me/sessions': {
        get: {
          tags: ['me'],
          summary: 'List the current user’s live sessions',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Live sessions, newest first; `current` marks this one.',
              content: jsonContent(toSchema(meSessionsResponseSchema, 'output')),
            },
            '401': errorResponse('Missing or invalid session.'),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Session token from verify-code.',
        },
      },
      schemas: { ErrorResponse: ERROR_RESPONSE_SCHEMA },
    },
  };
}
