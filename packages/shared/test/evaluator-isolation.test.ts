import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * 2.7: the evaluator suite runs with no database and no network. A static
 * scan of everything the suite loads (domain sources, their tests and the
 * fixture modules), because a test that happens not to open a socket proves
 * nothing about the next one. eslint's firewall covers @tower-of-habit/db in
 * src/; this also covers network clients and globals. Node built-ins are
 * allowed in this directory only.
 */

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

const SCANNED_DIRS = ['evaluator', 'time'];
const SCANNED_FILES = ['testing/evaluator-fixtures.ts', 'testing/dst-fixtures.ts'];

const FORBIDDEN: [string, RegExp][] = [
  [
    'database or network import',
    /from\s+['"](@tower-of-habit\/db[^'"]*|pg|postgres|drizzle-orm[^'"]*|ioredis|redis|bullmq|undici|axios|node-fetch|node:(net|http|https|http2|dgram|dns|tls))['"]/,
  ],
  ['dynamic import', /\bimport\s*\(/],
  ['fetch', /\bfetch\s*\(/],
  ['WebSocket', /\bnew\s+WebSocket\b/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
];

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

const files = [
  ...SCANNED_DIRS.flatMap((d) => tsFiles(join(SRC, d))),
  ...SCANNED_FILES.map((f) => join(SRC, f)),
];

describe('evaluator suite: no database, no network', () => {
  it('scans the suite files it claims to', () => {
    const rel = files.map((f) => relative(SRC, f));
    expect(rel).toEqual(
      expect.arrayContaining([
        'evaluator/evaluate.ts',
        'evaluator/suite.fixtures.test.ts',
        'evaluator/suite.dst.test.ts',
        'evaluator/suite.properties.test.ts',
        'time/period-window.ts',
        ...SCANNED_FILES,
      ])
    );
  });

  it.each(FORBIDDEN)('no %s', (_label, pattern) => {
    const offenders = files
      .filter((f) => pattern.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
