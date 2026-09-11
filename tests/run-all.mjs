// Runs every *.test.mjs beside this file and reports a single pass/fail.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(here).filter(f => f.endsWith('.test.mjs')).sort();

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(here, f)], { encoding: 'utf8' });
  const okCount = (r.stdout.match(/ {2}OK {2}/g) || []).length;
  const bad = r.status !== 0;
  if (bad) failed++;
  process.stdout.write(`${bad ? 'FAIL' : 'PASS'}  ${f.padEnd(28)} ${okCount} assertions\n`);
  if (bad) process.stdout.write(r.stdout.split('\n').filter(l => /FAIL/.test(l)).join('\n') + '\n' + (r.stderr || ''));
}
process.stdout.write(`\n${failed === 0 ? 'ALL SUITES PASS' : failed + ' SUITE(S) FAILED'}\n`);
process.exit(failed === 0 ? 0 : 1);
