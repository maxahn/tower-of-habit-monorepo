import { customType } from 'drizzle-orm/pg-core';

// Max length for short user-facing labels (names, units, tier labels).
export const DISPLAY_VARCHAR_MAX = 60;

// Drizzle has no built-in citext. Requires the citext extension, enabled by
// migration 0003_enable_citext.
export const citext = customType<{ data: string }>({ dataType: () => 'citext' });
