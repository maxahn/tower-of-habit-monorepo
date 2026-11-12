#!/usr/bin/env node
// Runs each package's `test:coverage` and rewrites the coverage table in
// README.md between the coverage:start / coverage:end markers.
//
// Failing tests don't stop the update; the table reports them instead.
// The db suite needs Postgres (see README); if it isn't reachable, db's
// previous row is kept and marked stale.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import { format, resolveConfig } from 'prettier';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readmePath = join(root, 'README.md');
const START = '<!-- coverage:start -->';
const END = '<!-- coverage:end -->';

const PACKAGES = [
  { name: 'shared', dir: 'packages/shared' },
  { name: 'db', dir: 'packages/db', needsDb: true },
];

const METRICS = ['statements', 'branches', 'functions', 'lines'];

function postgresReachable() {
  // Same env file the db vitest config loads; parsed, not loaded, so it
  // doesn't leak into the child processes.
  const envPath = join(root, process.env.ENV_FILE ?? '.env.test');
  const fileEnv = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
  const databaseUrl = process.env.DATABASE_URL ?? fileEnv.DATABASE_URL;
  if (!databaseUrl) return Promise.resolve(false);
  const url = new URL(databaseUrl);
  return new Promise((done) => {
    const socket = connect({ host: url.hostname, port: Number(url.port || 5432) });
    const finish = (ok) => {
      socket.destroy();
      done(ok);
    };
    socket.setTimeout(1000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function runCoverage(pkg) {
  const summaryPath = join(root, pkg.dir, 'coverage', 'coverage-summary.json');
  // Never report numbers left over from an earlier run.
  rmSync(summaryPath, { force: true });
  console.error(`→ ${pkg.name}: running test:coverage…`);
  const result = spawnSync('pnpm', ['-F', `@tower-of-habit/${pkg.name}`, 'test:coverage'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const testsLine = output.split('\n').find((line) => /^\s*Tests\s{2,}/.test(line));
  // Vitest separates counts with '|', which would split the table cell.
  const tests = testsLine
    ? testsLine
        .trim()
        .replace(/^Tests\s+/, '')
        .replaceAll(' | ', ', ')
    : 'unknown';

  if (!existsSync(summaryPath)) {
    console.error(`  no coverage summary produced (exit ${result.status})`);
    return null;
  }
  const { total } = JSON.parse(readFileSync(summaryPath, 'utf8'));
  return { total, tests };
}

const pct = (metric) => `${metric.pct.toFixed(1)}%`;

function row(name, cells) {
  return `| ${[name, ...cells].join(' | ')} |`;
}

function existingRow(block, name) {
  // Prettier pads cells, so match the first cell loosely.
  const first = new RegExp(`^\\|\\s*${name}\\s*\\|`);
  return block.split('\n').find((line) => first.test(line));
}

const readme = readFileSync(readmePath, 'utf8');
const startIdx = readme.indexOf(START);
const endIdx = readme.indexOf(END);
if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
  console.error(`README.md is missing the ${START} / ${END} markers.`);
  process.exit(1);
}
const oldBlock = readme.slice(startIdx + START.length, endIdx);

const rows = [];
for (const pkg of PACKAGES) {
  if (pkg.needsDb && !(await postgresReachable())) {
    console.error(`→ ${pkg.name}: Postgres not reachable, keeping previous row`);
    const STALE = ' (stale: Postgres not running)';
    const prev = existingRow(oldBlock, pkg.name);
    rows.push(
      prev
        ? prev.includes(STALE)
          ? prev
          : prev.replace(/\s*\|$/, `${STALE} |`)
        : row(pkg.name, [...METRICS.map(() => '—'), `not run${STALE}`])
    );
    continue;
  }
  const result = runCoverage(pkg);
  rows.push(
    result
      ? row(pkg.name, [...METRICS.map((m) => pct(result.total[m])), result.tests])
      : row(pkg.name, [...METRICS.map(() => '—'), 'no report (run failed)'])
  );
}

const table = [
  row('Package', ['Statements', 'Branches', 'Functions', 'Lines', 'Tests']),
  row('---', ['---:', '---:', '---:', '---:', '---']),
  ...rows,
].join('\n');

const replaced = `${readme.slice(0, startIdx + START.length)}\n\n${table}\n\n${readme.slice(endIdx)}`;
// Format like `pnpm format` would, so it never rewrites the table.
const newReadme = await format(replaced, {
  ...(await resolveConfig(readmePath)),
  filepath: readmePath,
});
if (newReadme === readme) {
  console.error('README.md coverage table is already up to date.');
} else {
  writeFileSync(readmePath, newReadme);
  console.error('Updated README.md coverage table.');
}
