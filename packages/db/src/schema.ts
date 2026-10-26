// Barrel for every table definition. drizzle.config.ts (generate/migrate),
// client.ts and the package's "./schema" export all read this file, so a new
// table only needs its own <domain>/schema.ts plus a line here.
//
// Column names are derived from schema keys by `casing: 'snake_case'`, set in
// BOTH drizzle.config.ts (governs generated DDL) and src/client.ts (governs
// runtime queries). Those two must always agree.
export * from './users/schema.js';
export * from './habits/schema.js';
export * from './habits/tiers/schema.js';
export * from './habits/entries/schema.js';
export * from './towers/schema.js';
export * from './towers/memberships/schema.js';
export * from './towers/periods/schema.js';
