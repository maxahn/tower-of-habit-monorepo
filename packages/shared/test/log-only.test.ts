import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * collapseLogFields (src/evaluator/collapse-log.ts) says who missed a period.
 * That is for the application log only (§5): persistence and API code must
 * never touch it, or the blame record the design rules out gets stored or
 * served. A static scan, because no runtime test sees a column that was never
 * written. Node built-ins are allowed in this directory only.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const GUARDED = ['packages/db/src', 'apps/api/src'];
const FORBIDDEN = /collapseLogFields|missedBy|missed_by/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

describe('collapse log fields stay out of db and api source', () => {
  it.each(GUARDED)('%s', (dir) => {
    const files = sourceFiles(join(REPO_ROOT, dir));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files
      .filter((f) => FORBIDDEN.test(readFileSync(f, 'utf8')))
      .map((f) => relative(REPO_ROOT, f));
    expect(offenders).toEqual([]);
  });
});
