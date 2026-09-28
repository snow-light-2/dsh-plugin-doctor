import { test } from 'node:test';
import assert from 'node:assert/strict';

import { explainText, SIGNATURES } from '../src/explain.js';

const CRASH_LOG = [
  '[desktop] profile web',
  '[harness-node] loading=...dsh\\lib\\bin.js',
  'DSH entry failed: dsh: plugin tree failed to load: failed to apply loader entry session-title-llm (@deepseek-ai/dsh-session-title-first-prompt-llm): session-title provider "michengai-codex-ui-session-title" is already registered',
  '[node] Harness process exited (exit code 3221226505 (0xC0000409))',
  '[desktop] plugin recovery detection: unresolved',
  '[desktop] safe mode: third-party web profile bundles are blocked',
].join('\r\n');

test('a real crash log is explained end to end', () => {
  const { lines, hits } = explainText(CRASH_LOG);
  assert.equal(lines, 6);

  const ids = hits.map((hit) => hit.id);
  assert.ok(ids.includes('tree-load-failed'), `got ${ids.join(', ')}`);
  assert.ok(ids.includes('singleton-registered'), `got ${ids.join(', ')}`);
  assert.ok(ids.includes('crash-code'), `got ${ids.join(', ')}`);
  assert.ok(ids.includes('safe-mode'), `got ${ids.join(', ')}`);

  const tree = hits.find((hit) => hit.id === 'tree-load-failed');
  assert.deepEqual(tree.groups, [
    'session-title-llm',
    '@deepseek-ai/dsh-session-title-first-prompt-llm',
    'session-title provider "michengai-codex-ui-session-title" is already registered',
  ]);

  const singleton = hits.find((hit) => hit.id === 'singleton-registered');
  assert.equal(singleton.code, 'D004');
  assert.match(singleton.why, /exactly one provider/);

  const crash = hits.find((hit) => hit.id === 'crash-code');
  assert.deepEqual(crash.groups, ['3221226505', '0xC0000409']);
  assert.match(crash.title, /fail-fast abort/);

  // every hit must be actionable
  for (const hit of hits) {
    assert.ok(hit.title && hit.why && hit.fix, `${hit.id} is missing prose`);
    assert.equal(hit.occurrences, 1);
  }
});

test('exit codes are read, never guessed at', () => {
  const terminated = explainText('[node] Harness process exited (exit code 1073807364 (0x40010004))').hits[0];
  assert.match(terminated.title, /terminated, not crashed/);
  assert.doesNotMatch(terminated.why, /overrun|crash/i);

  const generic = explainText('[node] Harness process exited (exit code 1)').hits[0];
  assert.match(generic.title, /generic failure/);

  const unknown = explainText('[node] Harness process exited (exit code 1234 (0x4D2))').hits[0];
  assert.match(unknown.title, /unrecognised status/);
  assert.match(unknown.why, /no cause is claimed/);
});

test('repeated signatures collapse into one finding', () => {
  const log = Array.from({ length: 12 }, (_, i) => `[node] Harness process exited (exit code 1073807364 (0x40010004))  #${i}`).join('\n');
  const { hits } = explainText(log);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].occurrences, 12);
  assert.equal(hits[0].firstLine, 1);
  assert.equal(hits[0].line, 12);
});

test('plain warnings keep their advice', () => {
  const { hits } = explainText(
    [
      'dsh: [C:\\x\\cordis.patch.yml] patch: name mismatch for "llm-deepseek" (expected "@deepseek-ai/dsh-llm-deepseek", got "@deepseek-ai/dsh-llm-deepseek-api-key"), skipping',
      'Cannot switch a non-link plugin directory: C:\\x\\node_modules\\dsh-pet',
      'plugin kept off: dsh-better-sidebar',
      'generation peer validation failed: @deepseek-ai/dsh-client-runtime does not resolve from the installation closure',
    ].join('\n'),
  );
  const byId = Object.fromEntries(hits.map((hit) => [hit.id, hit]));
  assert.equal(byId['patch-mismatch'].code, 'D001');
  assert.equal(byId['non-link-plugin'].code, 'D006');
  assert.equal(byId['kept-off'].code, 'D005');
  assert.equal(byId['peer-closure'].code, 'D008');
  assert.deepEqual(byId['peer-closure'].groups, ['@deepseek-ai/dsh-client-runtime']);
});

test('a healthy log matches nothing', () => {
  const { hits } = explainText(
    [
      '[desktop] profile web',
      'dsh web: http://127.0.0.1:43129/?token=abc',
      '[stdout] [harness-node] DSH entry loaded',
      '[desktop] projected generations: 3 linked, 0 unlinked',
    ].join('\n'),
  );
  assert.deepEqual(hits, []);
});

test('every signature is well formed', () => {
  for (const signature of SIGNATURES) {
    assert.ok(signature.id && !/\s/.test(signature.id), `bad id: ${signature.id}`);
    assert.ok(signature.re instanceof RegExp, `${signature.id} has no regex`);
    assert.ok(signature.title && signature.why && signature.fix, `${signature.id} is missing prose`);
    assert.equal(signature.re.flags.includes('g'), false, `${signature.id} must not be global (lastIndex state)`);
  }
});
