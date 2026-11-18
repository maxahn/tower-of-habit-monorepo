import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../src/schema.js';

// ── Introspection ────────────────────────────────────────────────────────────

type TableEntry = { exportName: string; config: ReturnType<typeof getTableConfig> };
type EnumEntry = { enumName: string; values: readonly string[] };

const tables: TableEntry[] = [];
const enums: EnumEntry[] = [];

for (const [name, value] of Object.entries(schema)) {
  try {
    const config = getTableConfig(value as PgTable);
    tables.push({ exportName: name, config });
    continue;
  } catch {
    // not a table
  }

  if (
    typeof value === 'function' &&
    'enumName' in value &&
    'enumValues' in value &&
    typeof (value as { enumName: unknown }).enumName === 'string'
  ) {
    const e = value as { enumName: string; enumValues: readonly string[] };
    enums.push({ enumName: e.enumName, values: e.enumValues });
  }
}

tables.sort((a, b) => a.config.name.localeCompare(b.config.name));
enums.sort((a, b) => a.enumName.localeCompare(b.enumName));

// ── Mermaid generation ───────────────────────────────────────────────────────

function mermaidType(dataType: string): string {
  const map: Record<string, string> = {
    string: 'text',
    number: 'int',
    boolean: 'bool',
    date: 'timestamp',
    json: 'jsonb',
    custom: 'text',
    bigint: 'bigint',
    buffer: 'bytea',
    array: 'array',
  };
  return map[dataType] ?? dataType;
}

const DRIZZLE_NAME = Symbol.for('drizzle:Name');

function tableName(table: object): string {
  return (table as Record<symbol, string>)[DRIZZLE_NAME];
}

function colName(col: { name: string }): string {
  return col.name;
}

function generateDiagram(subset: TableEntry[]): string {
  const lines: string[] = ['erDiagram'];

  for (const { config } of subset) {
    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      const targetName = tableName(ref.foreignTable);
      const fkColName = ref.columns.map(colName).join(',');
      const onDel = fk.onDelete ?? 'default';
      lines.push(`    ${targetName} ||--o{ ${config.name} : "${fkColName} [${onDel}]"`);
    }
  }

  lines.push('');

  for (const { config } of subset) {
    lines.push(`    ${config.name} {`);
    for (const col of config.columns) {
      const pk = col.primaryKey ? 'PK' : '';
      const fkMarker = config.foreignKeys.some((fk) =>
        fk.reference().columns.some((c) => c.name === col.name)
      )
        ? 'FK'
        : '';
      const marker = [pk, fkMarker].filter(Boolean).join(',');
      const nullable = col.notNull ? '' : ' "nullable"';
      lines.push(
        `        ${mermaidType(col.dataType)} ${col.name}${marker ? ` ${marker}` : ''}${nullable}`
      );
    }
    lines.push('    }');
  }

  return lines.join('\n');
}

const fullDiagram = generateDiagram(tables);

// ── Enum reference ───────────────────────────────────────────────────────────

const enumRows = enums
  .map(
    (e) =>
      `      <tr><td><code>${e.enumName}</code></td><td>${e.values.map((v) => `<code>${v}</code>`).join(', ')}</td></tr>`
  )
  .join('\n');

// ── HTML output ──────────────────────────────────────────────────────────────

const totalFks = tables.reduce((n, t) => n + t.config.foreignKeys.length, 0);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tower of Habit — Schema ERD</title>
  <style>
    :root {
      --bg: #fafaf9;
      --fg: #1c1917;
      --muted: #78716c;
      --surface: #ffffff;
      --border: #e7e5e4;
      --accent: #7c3aed;
      --accent-soft: #ede9fe;
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        --bg: #0c0a09;
        --fg: #e7e5e4;
        --muted: #a8a29e;
        --surface: #1c1917;
        --border: #292524;
        --accent: #a78bfa;
        --accent-soft: #1e1338;
        color-scheme: dark;
      }
    }
    :root[data-theme="dark"] {
      --bg: #0c0a09;
      --fg: #e7e5e4;
      --muted: #a8a29e;
      --surface: #1c1917;
      --border: #292524;
      --accent: #a78bfa;
      --accent-soft: #1e1338;
      color-scheme: dark;
    }
    * { box-sizing: border-box; margin: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--fg);
      padding-left: max(16px, env(safe-area-inset-left, 0px));
      padding-right: max(16px, env(safe-area-inset-right, 0px));
      padding-block: 2rem;
      max-width: 1200px;
      margin: 0 auto;
      line-height: 1.6;
    }
    h1 {
      font-size: 1.5rem;
      font-weight: 700;
      margin-bottom: 0.25rem;
    }
    .subtitle {
      color: var(--muted);
      font-size: 0.8125rem;
      margin-bottom: 2rem;
      font-variant-numeric: tabular-nums;
    }
    h2 {
      font-size: 1rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--accent);
      margin: 2.5rem 0 0.75rem;
    }
    .diagram-wrap {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1.5rem;
      overflow-x: auto;
      min-width: 0;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.8125rem;
    }
    th, td {
      text-align: left;
      padding: 0.5rem 0.75rem;
      border-bottom: 1px solid var(--border);
    }
    th {
      font-weight: 600;
      color: var(--muted);
      font-size: 0.6875rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    td code {
      background: var(--accent-soft);
      color: var(--accent);
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 0.75rem;
    }
    .stats {
      color: var(--muted);
      font-size: 0.6875rem;
      margin-top: 2rem;
    }
  </style>
</head>
<body>
  <h1>Tower of Habit — Schema ERD</h1>
  <p class="subtitle">${tables.length} tables &middot; ${enums.length} enums &middot; ${totalFks} foreign keys &middot; auto-generated from Drizzle</p>

  <h2>Entity Relationships</h2>
  <div class="diagram-wrap">
    <pre class="mermaid">
${fullDiagram}
    </pre>
  </div>

  <h2>Enum Types</h2>
  <div class="diagram-wrap">
    <table>
      <thead><tr><th>Enum</th><th>Values</th></tr></thead>
      <tbody>
${enumRows}
      </tbody>
    </table>
  </div>

  <p class="stats">Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</p>
</body>
</html>`;

const outPath = resolve(import.meta.dirname!, '../../..', 'docs/schema-erd.html');
writeFileSync(outPath, html, 'utf-8');
console.log(`Wrote ${outPath}`);
console.log(`  ${tables.length} tables, ${enums.length} enums, ${totalFks} foreign keys`);
