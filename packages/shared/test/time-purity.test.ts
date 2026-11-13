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

// 2.3 / 2.4: the evaluator must return the same result for the same input
// regardless of ambient state (2.4 takes `now` as input), so the same scan,
// plus randomness.
describe('src/evaluator reads no clock or randomness', () => {
  it.each(['qualifies.ts', 'evaluate.ts'])('%s', (file) => {
    const src = readFileSync(new URL(`../src/evaluator/${file}`, import.meta.url), 'utf8');
    expect(src).not.toMatch(/Date\.now\s*\(/);
    expect(src).not.toMatch(/new Date\(\s*\)/);
    expect(src).not.toMatch(/performance\.now\s*\(/);
    expect(src).not.toMatch(/Math\.random\s*\(/);
    // A stub that only throws reads no clock either, so the scan must not
    // pass until the real implementation replaces it.
    expect(src).not.toMatch(/not implemented/);
  });
});
