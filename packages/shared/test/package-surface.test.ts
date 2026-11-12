import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * Packaging guarantees for 2.1 that no unit test can see:
 *   - `pnpm --filter @tower-of-habit/shared build` emits declarations with no
 *     `any` in the public surface;
 *   - a consumer with no pg dependency (the mobile app, in effect) can import
 *     the package and typecheck without pulling in a database driver.
 *
 * Node built-ins are allowed in this directory only (see eslint.config.js);
 * the src/ firewall is unchanged.
 */

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(PKG_DIR, '../..');
const DIST = join(PKG_DIR, 'dist');
const TSC = join(REPO_ROOT, 'node_modules/.bin/tsc');

const FORBIDDEN_DEPS = ['pg', 'postgres', 'drizzle-orm', '@tower-of-habit/db', '@prisma/client'];
// Matches a path segment, so "postgres" can't hide inside "node_modules/postgres/…".
const FORBIDDEN_PATH =
  /[\\/]node_modules[\\/](pg|postgres|drizzle-orm|@tower-of-habit[\\/]db)[\\/]/;

function run(cmd: string, args: string[], cwd: string): { code: number; out: string } {
  try {
    const out = execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]
  );
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('package.json', () => {
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };

  it('declares a build script', () => {
    expect(pkg.scripts?.build).toBeTruthy();
  });

  it.each(FORBIDDEN_DEPS)('does not depend on %s', (dep) => {
    expect(pkg.dependencies ?? {}).not.toHaveProperty(dep);
    expect(pkg.peerDependencies ?? {}).not.toHaveProperty(dep);
    expect(pkg.optionalDependencies ?? {}).not.toHaveProperty(dep);
  });
});

describe('pnpm --filter @tower-of-habit/shared build', () => {
  let build: { code: number; out: string };

  beforeAll(() => {
    rmSync(DIST, { recursive: true, force: true });
    build = run('pnpm', ['--filter', '@tower-of-habit/shared', 'build'], REPO_ROOT);
  }, 120_000);

  it('exits cleanly', () => {
    expect(build.code, build.out).toBe(0);
  });

  it('emits dist/index.d.ts', () => {
    expect(existsSync(join(DIST, 'index.d.ts'))).toBe(true);
  });

  it('emits declarations for the schemas barrel', () => {
    expect(existsSync(join(DIST, 'schemas/index.d.ts'))).toBe(true);
  });

  it('has no `any` in any emitted declaration', () => {
    const offenders = walk(DIST)
      .filter((f) => f.endsWith('.d.ts'))
      .flatMap((f) =>
        stripComments(readFileSync(f, 'utf8'))
          .split('\n')
          .map((line, i) => ({ f, line, n: i + 1 }))
          .filter(({ line }) => /\bany\b/.test(line))
          .map(({ f, n, line }) => `${f.slice(DIST.length + 1)}:${n}: ${line.trim()}`)
      );
    expect(offenders).toEqual([]);
  });

  it('does not emit test files into the published surface', () => {
    const tests = walk(DIST).filter((f) => /\.test\.(d\.ts|js)$/.test(f));
    expect(tests).toEqual([]);
  });
});

describe('a consumer with no pg dependency', () => {
  let dir: string;
  let compile: { code: number; out: string };

  beforeAll(() => {
    // realpath: macOS tmpdir is a symlink, and tsc reports resolved paths.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'toh-shared-consumer-')));
    mkdirSync(join(dir, 'node_modules/@tower-of-habit'), { recursive: true });
    symlinkSync(PKG_DIR, join(dir, 'node_modules/@tower-of-habit/shared'), 'dir');

    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'consumer',
        private: true,
        type: 'module',
        dependencies: { '@tower-of-habit/shared': 'workspace:*' },
      })
    );
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        extends: join(REPO_ROOT, 'tsconfig.base.json'),
        compilerOptions: { noEmit: true, types: [] },
        files: ['index.ts'],
      })
    );
    // Root import only: no deep paths, exactly as apps/mobile would write it.
    writeFileSync(
      join(dir, 'index.ts'),
      [
        'import {',
        '  createHabitRequestSchema,',
        '  logEntryRequestSchema,',
        '  towerResponseSchema,',
        '  HABIT_TYPES,',
        '  type HabitType,',
        '  type CreateHabitRequest,',
        '  type TowerResponse,',
        "} from '@tower-of-habit/shared';",
        '',
        "const t: HabitType = HABIT_TYPES[0] ?? 'binary';",
        "const body: CreateHabitRequest = createHabitRequestSchema.parse({ name: 'x', type: t });",
        "const entry = logEntryRequestSchema.parse({ habitId: '00000000-0000-4000-8000-000000000000' });",
        'const tower: TowerResponse | undefined = towerResponseSchema.safeParse({}).data;',
        'export { body, entry, tower };',
        '',
      ].join('\n')
    );

    compile = run(TSC, ['-p', 'tsconfig.json', '--listFiles'], dir);
  }, 120_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('typechecks cleanly', () => {
    expect(compile.code, compile.out).toBe(0);
  });

  it('never loads a database driver or the db package', () => {
    const loaded = compile.out.split('\n').filter((f) => FORBIDDEN_PATH.test(f));
    expect(loaded).toEqual([]);
  });

  it('resolved the package through its own entry, not a deep path', () => {
    expect(compile.out).toMatch(/packages[\\/]shared[\\/]/);
  });
});
