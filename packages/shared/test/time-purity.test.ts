import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 2.2: computePeriodWindow is pure, so nothing in its module graph may read a
// clock. A static scan, because a fake-timer test only proves the clocks it
// knows to fake. Lives outside src/ because node:fs is banned there (Hermes).
describe('src/time reads no clock', () => {
  it.each(['period-window.ts', 'wall-clock.ts', 'local-date.ts'])('%s', (file) => {
    const src = readFileSync(new URL(`../src/time/${file}`, import.meta.url), 'utf8');
    expect(src).not.toMatch(/Date\.now\s*\(/);
    expect(src).not.toMatch(/new Date\(\s*\)/);
    expect(src).not.toMatch(/performance\.now\s*\(/);
  });
});
