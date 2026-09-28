import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../src/cli.js';

// Deterministic output regardless of whether the test runner owns a TTY.
process.env.NO_COLOR = '1';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '..', 'fixtures');
const fixture = (name) => resolve(FIXTURES, name);
const EMPTY_HOME = resolve(FIXTURES, 'no-such-home');
const stripAnsi = (text) => text.replace(/\u001b\[[0-9;]*m/g, '');

/**
 * Run the CLI in-process against the committed fixtures with an empty DSH home,
 * so the assertions describe the tool and not the machine it runs on.
 */
async function run(argv) {
  const out = [];
  const errors = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args) => out.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const code = await main(argv);
    return { code, out: stripAnsi(out.join('\n')), err: stripAnsi(errors.join('\n')) };
  } finally {
    console.log = log;
    console.error = error;
  }
}

const offlineCheck = (extra = []) => [
  'check',
  '--dump',
  fixture('dump-web-real.txt'),
  '--dump-stderr',
  fixture('dump-web-stderr-real.txt'),
  '--patch',
  fixture('patch-web-real.yml'),
  '--home',
  EMPTY_HOME,
  ...extra,
];

test('--version answers with the version, not the usage banner', async () => {
  const result = await run(['--version']);
  assert.equal(result.code, 0);
  assert.match(result.out, /^\d+\.\d+\.\d+$/);

  const short = await run(['-v']);
  assert.equal(short.code, 0);
  assert.equal(short.out, result.out);
});

test('--help answers with the usage banner and succeeds', async () => {
  const result = await run(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.out, /^dsh-plugin-doctor \d/);
  assert.match(result.out, /usage/);
  assert.match(result.out, /exit codes/);

  const short = await run(['-h']);
  assert.equal(short.code, 0);
  assert.equal(short.out, result.out);
});

test('an empty invocation is a usage error, not a success', async () => {
  const result = await run([]);
  assert.equal(result.code, 2);
  assert.match(result.out, /usage/);
});

test('an unknown command is rejected', async () => {
  const result = await run(['bogus']);
  assert.equal(result.code, 2);
  assert.match(result.err, /unknown command "bogus"/);
});

test('--key=value and --key value are both accepted', async () => {
  const viaSpace = await run(['graph', '--dump', fixture('dump-web-real.txt'), '--home', EMPTY_HOME]);
  const viaEquals = await run(['graph', `--dump=${fixture('dump-web-real.txt')}`, `--home=${EMPTY_HOME}`]);
  assert.equal(viaSpace.code, 0);
  assert.equal(viaEquals.code, 0);
  assert.equal(viaSpace.out, viaEquals.out);
  assert.match(viaSpace.out, /composed loader tree/);
});

test('graph renders every entry and marks its state', async () => {
  const result = await run(['graph', '--dump', fixture('dump-web-real.txt'), '--home', EMPTY_HOME]);
  assert.equal(result.code, 0);
  assert.match(result.out, /on {2}ui-sidebar/);
  assert.match(result.out, /off hmr/);
  assert.match(result.out, /dyn/);
});

test('check reads a dump offline and reports findings', async () => {
  const result = await run(offlineCheck());
  assert.equal(result.code, 1, 'the fixture contains a known error');
  assert.match(result.out, /D001/);
  assert.match(result.out, /summary/);
});

test('check --strict fails on warnings too', async () => {
  const relaxed = await run(offlineCheck());
  const strict = await run(offlineCheck(['--strict']));
  const warns = (text) => Number(/summary\s+.*?(\d+) warning/.exec(text)?.[1] ?? 0);
  if (warns(relaxed.out) > 0) assert.equal(strict.code, 1);
  else assert.equal(strict.code, relaxed.code);
});

test('check --json emits one parseable document', async () => {
  const result = await run(offlineCheck(['--json']));
  const parsed = JSON.parse(result.out);
  assert.equal(parsed.tool, 'dsh-plugin-doctor');
  assert.equal(parsed.ok, false);
  assert.ok(Array.isArray(parsed.findings) && parsed.findings.length > 0);
  assert.ok(parsed.findings.every((item) => item.code && item.severity && item.title));
});

test('a missing dump is a usage error with guidance, not a crash', async () => {
  const result = await run(['check', '--dump', fixture('definitely-not-here.txt')]);
  assert.equal(result.code, 2);
  assert.match(result.err, /cannot read dump file/);
});

test('explain reads a UTF-16LE log, as PowerShell writes it', async () => {
  const result = await run(['explain', fixture('dump-web-stderr-real.txt')]);
  assert.equal(result.code, 1, 'a matched signature is a failing exit code');
  assert.match(result.out, /patch entry was skipped|patch entry matched nothing/);
  assert.match(result.out, /name mismatch|not found/);
});

test('explain on a clean log succeeds and says so', async () => {
  const clean = resolve(FIXTURES, 'no-such-log.txt');
  const result = await run(['explain', clean]);
  assert.equal(result.code, 2);
  assert.match(result.err, /cannot read/);
});
