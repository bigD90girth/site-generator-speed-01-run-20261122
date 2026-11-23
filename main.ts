// The program the harness runs: read every case from /input/cases.json,
// answer each one with run() from solve.js, and write the answers in order
// to /output/answers.json. Runs on Node 22.18 or later, which runs this
// TypeScript as it is. Outside a container, MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { readFileSync, openSync, writeSync, closeSync } from 'node:fs';
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

// Answer one case at a time and write its JSON straight to the file, so
// only one case's answer is ever alive at once: the answers are never all
// held in memory together, and the big stringified whole is never built.
// The bytes written are exactly JSON.stringify of the answers array:
// '[' + each answer's JSON, comma-separated + ']'.
const fd = openSync(join(outDir, 'answers.json'), 'w');
writeSync(fd, '[');
for (let i = 0; i < cases.length; i++) {
  if (i > 0) writeSync(fd, ',');
  writeSync(fd, JSON.stringify(run(cases[i].input)));
}
writeSync(fd, ']');
closeSync(fd);
