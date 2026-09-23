#!/usr/bin/env node
// Migrations are forward-only: once a migration exists on the base branch it is never
// edited, renamed or deleted (production has already run it, and the migrator refuses a
// changed checksum). New migrations must be numbered after every existing one.
//
// Usage: node scripts/check-migrations.mjs <base-ref>
import { execFileSync } from 'node:child_process';

const DIR = 'apps/api/migrations';
const base = process.argv[2];
if (!base) {
  console.error('usage: check-migrations.mjs <base-ref>');
  process.exit(2);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const lines = (text) => (text ? text.split('\n') : []);
const number = (file) => Number(/^(\d{4})_[a-z0-9_]+\.sql$/.exec(file.split('/').pop())?.[1]);

const problems = [];
for (const line of lines(
  git('diff', '--name-status', '--no-renames', `${base}...HEAD`, '--', DIR),
)) {
  const [status, file] = line.split('\t');
  if (status !== 'A')
    problems.push(`${file}: existing migrations must not change (status ${status})`);
}

const existing = lines(git('ls-tree', '--name-only', base, `${DIR}/`)).map(number);
const highest = Math.max(0, ...existing.filter(Number.isFinite));
const added = lines(git('diff', '--name-only', '--diff-filter=A', `${base}...HEAD`, '--', DIR));
for (const file of added) {
  const n = number(file);
  if (!Number.isFinite(n)) problems.push(`${file}: name must be NNNN_lower_snake.sql`);
  else if (n <= highest)
    problems.push(`${file}: must be numbered after ${String(highest).padStart(4, '0')}`);
}
const numbers = added.map(number);
if (new Set(numbers).size !== numbers.length) problems.push('two new migrations share a number');

if (problems.length > 0) {
  console.error(`Migration check failed against ${base}:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`Migration check passed against ${base} (${added.length} new).`);
