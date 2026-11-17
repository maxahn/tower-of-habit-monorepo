import {
  createHabitRequestSchema,
  createTowerRequestSchema,
  joinTowerRequestSchema,
  towerDetailResponseSchema,
  towerListResponseSchema,
  habitDetailResponseSchema,
  habitListResponseSchema,
  meResponseSchema,
  replaceTiersRequestSchema,
  updateHabitRequestSchema,
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

const ID_PARAM: Json = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};
const AUTHED: Json[] = [{ bearerAuth: [] }];
const NOT_FOUND = errorResponse('not_found — unknown, or owned by someone else.');
const UNAUTHENTICATED = errorResponse('Missing or invalid session.');
const LOCKED = errorResponse('habit_locked_by_tower — the habit is bound into an active tower.');

const detailResponse = (description: string): Json => ({
  description,
  content: jsonContent(toSchema(habitDetailResponseSchema, 'output')),
});

// 2.12
function habitPaths(): Record<string, Json> {
  return {
    '/v1/habits': {
      post: {
        tags: ['habits'],
        summary: 'Create a habit',
        description:
          'Numeric and tiered habits are created with their tier ladder (levels contiguous from 0; numeric thresholds strictly increasing). The habit is active at once.',
        security: AUTHED,
        requestBody: {
          required: true,
          content: jsonContent(toSchema(createHabitRequestSchema, 'input')),
        },
        responses: {
          '201': detailResponse('Created.'),
          '400': errorResponse('validation_failed or invalid_json.'),
          '401': UNAUTHENTICATED,
        },
      },
      get: {
        tags: ['habits'],
        summary: 'List my habits',
        security: AUTHED,
        responses: {
          '200': {
            description: 'The caller’s habits, oldest first.',
            content: jsonContent(toSchema(habitListResponseSchema, 'output')),
          },
          '401': UNAUTHENTICATED,
        },
      },
    },
    '/v1/habits/{id}': {
      get: {
        tags: ['habits'],
        summary: 'A habit with its ladder, current streak and owning tower',
        security: AUTHED,
        parameters: [ID_PARAM],
        responses: { '200': detailResponse('OK.'), '401': UNAUTHENTICATED, '404': NOT_FOUND },
      },
      patch: {
        tags: ['habits'],
        summary: 'Update name, unit or cadence',
        description:
          'Cadence (periodUnit, periodLength, quota) is locked while in an active tower.',
        security: AUTHED,
        parameters: [ID_PARAM],
        requestBody: {
          required: true,
          content: jsonContent(toSchema(updateHabitRequestSchema, 'input')),
        },
        responses: {
          '200': detailResponse('Updated.'),
          '400': errorResponse('validation_failed or invalid_json.'),
          '401': UNAUTHENTICATED,
          '404': NOT_FOUND,
          '409': LOCKED,
        },
      },
    },
    '/v1/habits/{id}/tiers': {
      put: {
        tags: ['habits'],
        summary: 'Replace the tier ladder',
        description:
          'The whole ladder, replaced at once. While in an active tower, tier 0’s threshold may not change; tiers above it may.',
        security: AUTHED,
        parameters: [ID_PARAM],
        requestBody: {
          required: true,
          content: jsonContent(toSchema(replaceTiersRequestSchema, 'input')),
        },
        responses: {
          '200': detailResponse('Replaced.'),
          '400': errorResponse('validation_failed (ladder rules) or invalid_json.'),
          '401': UNAUTHENTICATED,
          '404': NOT_FOUND,
          '409': LOCKED,
        },
      },
    },
    '/v1/habits/{id}/archive': {
      post: {
        tags: ['habits'],
        summary: 'Archive a habit',
        description: 'Idempotent. Refused while the habit is bound into an active tower.',
        security: AUTHED,
        parameters: [ID_PARAM],
        responses: {
          '200': detailResponse('Archived.'),
          '401': UNAUTHENTICATED,
          '404': NOT_FOUND,
          '409': LOCKED,
        },
      },
    },
  };
}

const towerDetailResponse = (description: string): Json => ({
  description,
  content: jsonContent(toSchema(towerDetailResponseSchema, 'output')),
});
const TOWER_NOT_FOUND = errorResponse(
  'not_found — unknown id, or the caller is not a member (never 403).'
);

// 2.13
function towerPaths(): Record<string, Json> {
  return {
    '/v1/towers': {
      post: {
        tags: ['towers'],
        summary: 'Create a tower (lobby)',
        description:
          'Creates the tower in the lobby with the creator as host, bound through the given habit (owned, not archived, same cadence, not committed elsewhere).',
        security: AUTHED,
        requestBody: {
          required: true,
          content: jsonContent(toSchema(createTowerRequestSchema, 'input')),
        },
        responses: {
          '201': towerDetailResponse('Created, in the lobby shape.'),
          '400': errorResponse('validation_failed or invalid_json.'),
          '401': UNAUTHENTICATED,
          '404': errorResponse('not_found — the habit is not the caller’s.'),
          '409': errorResponse(
            'habit_already_committed, habit_cadence_mismatch or habit_archived.'
          ),
        },
      },
      get: {
        tags: ['towers'],
        summary: 'List my towers',
        security: AUTHED,
        responses: {
          '200': {
            description: 'Towers the caller is a live member of.',
            content: jsonContent(toSchema(towerListResponseSchema, 'output')),
          },
          '401': UNAUTHENTICATED,
        },
      },
    },
    '/v1/towers/join': {
      post: {
        tags: ['towers'],
        summary: 'Join a tower by code',
        description:
          'Lobby only. The code is case-insensitive. The habit must be the caller’s, not archived, of the tower’s cadence, and not committed elsewhere.',
        security: AUTHED,
        requestBody: {
          required: true,
          content: jsonContent(toSchema(joinTowerRequestSchema, 'input')),
        },
        responses: {
          '201': towerDetailResponse('Joined; the lobby shape.'),
          '400': errorResponse('validation_failed or invalid_json.'),
          '401': UNAUTHENTICATED,
          '404': errorResponse('not_found — unknown code, or the habit is not the caller’s.'),
          '409': errorResponse(
            'tower_not_joinable, already_member, habit_already_committed, habit_cadence_mismatch or habit_archived.'
          ),
          '429': rateLimitedResponse('10 per user and 30 per client IP per hour'),
        },
      },
    },
    '/v1/towers/{id}/memberships/{membershipId}': {
      delete: {
        tags: ['towers'],
        summary: 'Leave, or remove a member (lobby only)',
        description:
          'A member may remove themselves; the creator may remove anyone. The creator cannot leave while others remain; leaving alone disbands the lobby.',
        security: AUTHED,
        parameters: [
          ID_PARAM,
          {
            name: 'membershipId',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '204': { description: 'Removed.' },
          '401': UNAUTHENTICATED,
          '403': errorResponse('forbidden — only the creator removes others.'),
          '404': TOWER_NOT_FOUND,
          '409': errorResponse('creator_cannot_leave or tower_not_in_lobby.'),
        },
      },
    },
    '/v1/towers/{id}': {
      get: {
        tags: ['towers'],
        summary: 'A tower, as a member sees it',
        description:
          'Two shapes keyed on `kind`: `lobby` (with the join code) while in the lobby; `active` (current period, block stack, no join code) afterwards.',
        security: AUTHED,
        parameters: [ID_PARAM],
        responses: {
          '200': towerDetailResponse('OK.'),
          '401': UNAUTHENTICATED,
          '404': TOWER_NOT_FOUND,
        },
      },
    },
  };
}

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
      { name: 'habits', description: 'Habits and their tier ladders.' },
      { name: 'towers', description: 'Towers: lobby, membership, start, period and evaluation.' },
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
      ...habitPaths(),
      ...towerPaths(),
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
