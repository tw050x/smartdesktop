#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { runJob } from './lib/run.js';

// smartspec-runner run [job.json | -]: runs a job (see lib/run.js), read from the file or stdin,
// writing what happens as JSON lines on stdout. Exits 0 when every check passed, 1 when one failed,
// 2 when they couldn't all be run. Ctrl-C (or SIGTERM) stops it, tidying up what it started.

const usage = 'Usage: smartspec-runner run [job.json | -]\n  Runs a SmartSpec job and writes its events as JSON lines.';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const [command, file = '-'] = process.argv.slice(2);
if (command !== 'run') {
  process.stderr.write(`${usage}\n`);
  process.exit(command === '--help' || command === '-h' ? 0 : 64);
}

let job;
try {
  job = JSON.parse(file === '-' ? await readStdin() : await readFile(file, 'utf8'));
} catch (error) {
  process.stdout.write(`${JSON.stringify({ type: 'done', outcome: 'error', counts: { passed: 0, failed: 0, error: 0 }, detail: `The job couldn't be read: ${error.message}` })}\n`);
  process.exit(2);
}

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => controller.abort());

const done = await runJob(job, { emit: (event) => process.stdout.write(`${JSON.stringify(event)}\n`), signal: controller.signal });
process.exitCode = { passed: 0, failed: 1 }[done.outcome] ?? 2;
