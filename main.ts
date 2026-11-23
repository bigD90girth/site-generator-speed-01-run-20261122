// The program the harness runs: read every case from /input/cases.json,
// answer each one with run() from solve.js, and write the answers in order
// to /output/answers.json. Runs on Node 22.18 or later, which runs this
// TypeScript as it is. Outside a container, MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of
// its work runs under it (the rules allow an entry to tune V8's flags the
// same way the house baseline does).
setFlagsFromString('--no-incremental-marking');

type Runner = (input: unknown) => unknown;

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: Runner };

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inDir, 'cases.json'), 'utf8')) as Array<{
  id: string;
  input: unknown;
}>;

const answers: unknown[] = [];
for (let i = 0; i < cases.length; i++) answers.push(run(cases[i].input));

writeFileSync(join(outDir, 'answers.json'), JSON.stringify(answers));
