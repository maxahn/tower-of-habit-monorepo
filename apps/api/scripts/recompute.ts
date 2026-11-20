import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    tower: { type: 'string' },
    repair: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

if (values.help || !values.tower) {
  console.log(`Usage: recompute --tower <tower-id> [--repair]

  --tower <id>   Tower UUID to verify (required)
  --repair       Rewrite height/streak if diverged (default: verify only)
  --help         Show this message

Requires DATABASE_URL in the environment.`);
  process.exit(values.help ? 0 : 1);
}

const { db, closeDb, verifyTower, repairTower } = await import('@tower-of-habit/db');

try {
  if (values.repair) {
    const report = await repairTower(db, values.tower);
    console.log(JSON.stringify(report, null, 2));
    if (report.repaired) {
      console.error(
        `Repaired: height ${report.before.height} → ${report.after.height}, streak ${report.before.currentStreak} → ${report.after.currentStreak}`
      );
    } else {
      console.error('Tower is healthy — no repair needed.');
    }
    if (report.blockDivergences.length > 0) {
      console.error(
        `${report.blockDivergences.length} block divergence(s) reported (not auto-fixed).`
      );
    }
    await closeDb();
    process.exit(0);
  } else {
    const report = await verifyTower(db, values.tower);
    console.log(JSON.stringify(report, null, 2));
    if (report.ok) {
      console.error('Tower is healthy.');
    } else {
      console.error(`Divergences found: ${report.divergences.map((d) => d.field).join(', ')}`);
    }
    await closeDb();
    process.exit(report.ok ? 0 : 1);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  await closeDb().catch(() => {});
  process.exit(2);
}
