import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  noExternal: ['@tower-of-habit/api', '@tower-of-habit/db', '@tower-of-habit/shared'],
});
