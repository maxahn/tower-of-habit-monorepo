import type { MiddlewareHandler } from 'hono';
import type { z } from 'zod';
import { DomainError } from './errors.js';

/** details key for an issue with an empty path (the body as a whole). */
export const ROOT_FIELD = '_root';

/**
 * The `details` of a validation_failed error: issue messages keyed by dotted
 * path (`email`, `address.city`, `items.0.name`), every message for a field
 * kept, in issue order. A root-level issue goes under ROOT_FIELD.
 */
export type FieldDetails = Record<string, string[]>;

export function zodFieldDetails(err: z.ZodError): FieldDetails {
  const details: FieldDetails = {};
  for (const issue of err.issues) {
    const key = issue.path.map(String).join('.') || ROOT_FIELD;
    (details[key] ??= []).push(issue.message);
  }
  return details;
}

/**
 * Validates the JSON body against `schema`; the handler reads the parsed value
 * with `c.req.valid('json')`.
 *
 * A schema failure throws the ZodError itself, so handleError owns the 400
 * validation_failed mapping in one place. A body that isn't JSON at all is
 * 400 invalid_json (a DomainError), not validation_failed.
 *
 * Hand-rolled rather than hono's validator('json'): that one silently skips
 * parsing when Content-Type isn't JSON, and reports malformed JSON as a bare
 * HTTPException.
 */
export function jsonBody<S extends z.ZodType>(
  schema: S
): MiddlewareHandler<object, string, { in: { json: z.input<S> }; out: { json: z.output<S> } }> {
  return async (c, next) => {
    let value: unknown;
    try {
      value = JSON.parse(await c.req.text());
    } catch {
      throw new DomainError(400, 'invalid_json', 'Request body is not valid JSON');
    }
    c.req.addValidatedData('json', schema.parse(value) as object);
    await next();
  };
}
