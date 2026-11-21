import { describe, expect, it } from 'vitest';
import { declareAbsenceRequestSchema, declareAbsenceResponseSchema } from './absence.js';

describe('declareAbsenceRequestSchema', () => {
  it('parses a valid absence declaration', () => {
    const result = declareAbsenceRequestSchema.parse({
      from: '2026-11-17',
      to: '2026-11-23',
    });
    expect(result).toEqual({ from: '2026-11-17', to: '2026-11-23' });
  });

  it('rejects extra fields (strict)', () => {
    expect(() =>
      declareAbsenceRequestSchema.parse({
        from: '2026-11-17',
        to: '2026-11-23',
        extra: true,
      })
    ).toThrow();
  });

  it('rejects invalid dates', () => {
    expect(() =>
      declareAbsenceRequestSchema.parse({ from: 'not-a-date', to: '2026-11-23' })
    ).toThrow();
    expect(() =>
      declareAbsenceRequestSchema.parse({ from: '2026-02-30', to: '2026-11-23' })
    ).toThrow();
  });
});

describe('declareAbsenceResponseSchema', () => {
  it('parses a valid response', () => {
    const result = declareAbsenceResponseSchema.parse({
      from: '2026-11-17',
      to: '2026-11-23',
    });
    expect(result).toEqual({ from: '2026-11-17', to: '2026-11-23' });
  });
});
