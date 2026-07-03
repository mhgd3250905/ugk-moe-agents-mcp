import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const failures = [];
function fail(a,e,ac){failures.push({assertion:a,expected:e,actual:ac});}
const outDir = process.env.TASK_OUTPUT_DIR || '.';
const f = join(outDir, 'echo_output.json');
const input = JSON.parse(process.env.TASK_INPUT || '{}');
if (!existsSync(f)) {
  fail('output exists','echo_output.json','missing');
} else {
  const data = JSON.parse(readFileSync(f,'utf8'));
  if (data.message !== input.message) fail('message matches input', input.message, data.message);
}
if (failures.length) { console.log(JSON.stringify(failures,null,2)); process.exit(1); }
console.log('PASS');
