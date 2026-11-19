import { z } from 'zod';
import { localDate } from './common.js';

export const declareAbsenceRequestSchema = z.strictObject({
  from: localDate,
  to: localDate,
});

export type DeclareAbsenceRequest = z.infer<typeof declareAbsenceRequestSchema>;

export const declareAbsenceResponseSchema = z.strictObject({
  from: localDate,
  to: localDate,
});

export type DeclareAbsenceResponse = z.infer<typeof declareAbsenceResponseSchema>;
