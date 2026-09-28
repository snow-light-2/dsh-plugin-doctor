import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDump, parsePatch, parseDumpWarnings, parseDisabled, enablement, scalar } from '../src/parse.js';
import { readText, decodeText } from '../src/paths.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// Deliberately read through the tool's own reader: one fixture is UTF-16LE,
// exactly as PowerShell writes a captured stderr.
const fixture = (name) => readText(resolve(HERE, '..', 'fixtures', name)).value;

test('decodeText handles utf8, utf8+BOM and utf16 either endianness', () => {
  assert.equal(decodeText(Buffer.from('hi', 'utf8')), 'hi');
  assert.equal(decodeText(Buffer.from('\uFEFFhi', 'utf8')), 'hi');
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi', 'utf16le')])), 'hi');
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('hi', 'utf16le').swap16()])), 'hi');
});

test('scalar strips quotes', () => {
  assert.equal(scalar("'a'"), 'a');
  assert.equal(scalar('"a"'), 'a');
  assert.equal(scalar('a'), 'a');
  assert.equal(scalar(''), '');
});

test('parseDisabled distinguishes literals from !!js', () => {
  assert.deepEqual(parseDisabled('true'), { kind: 'bool', value: true });
  assert.deepEqual(parseDisabled('false'), { kind: 'bool', value: false });
  assert.equal(parseDisabled("!!js process.platform === 'win32'").kind, 'js');
  assert.equal(enablement(parseDisabled('false')), 'on');
  assert.equal(enablement(parseDisabled('true')), 'off');
  assert.equal(enablement(null), 'on');
  assert.equal(enablement(parseDisabled("!!js x")), 'dynamic');
});

test('parseDump reads the entry envelope from a real dump', () => {
  const { entries, sections } = parseDump(fixture('dump-web-real.txt'));
  assert.ok(entries.length > 100, `expected many entries, got ${entries.length}`);
  assert.ok(sections.length >= 5, `expected several sections, got ${sections.length}`);

  const ids = new Set(entries.map((entry) => entry.id));
  assert.ok(ids.has('ui-sidebar'));
  assert.ok(ids.has('session-title-llm'));
  assert.ok(ids.has('dsh-market'));

  // A nested `config.models[].id` must never become a loader entry.
  assert.ok(!ids.has('deepseek-v4-flash'));
  assert.ok(!ids.has('deepseek-v4-pro'));

  const sidebar = entries.find((entry) => entry.id === 'ui-sidebar');
  assert.equal(sidebar.name, '@deepseek-ai/dsh-client-ui-sidebar');
  assert.deepEqual(sidebar.disabled, { kind: 'bool', value: false });
  assert.match(sidebar.patchedBy, /cordis\.patch\.yml$/);
  assert.equal(sidebar.owner, '@deepseek-ai/dsh-web-app');
});

test('parseDump keeps dynamic enablement dynamic', () => {
  const { entries } = parseDump(fixture('dump-web-real.txt'));
  const bash = entries.find((entry) => entry.id === 'bash-sandbox');
  assert.ok(bash, 'bash-sandbox should exist');
  assert.equal(bash.disabled.kind, 'js');
  assert.equal(enablement(bash.disabled), 'dynamic');
});

test('parseDump marks the sections a patch layer touched', () => {
  const { entries } = parseDump(fixture('dump-web-real.txt'));
  const patched = entries.filter((entry) => entry.patchedBy);
  assert.ok(patched.length > 0);

  // A section can be touched by a chain of layers, mixing bundle names and the
  // profile patch path: `# == @deepseek-ai/dsh-base, patched by A, B`.
  assert.ok(patched.some((entry) => entry.patchedByList.some((layer) => /cordis\.patch\.yml$/.test(layer))));
  assert.ok(patched.some((entry) => entry.patchedByList.includes('billion-context')));
  for (const entry of patched) assert.ok(entry.patchedByList.length > 0, entry.id);
});

test('parseDump recovers the owning package of every entry', () => {
  const { entries } = parseDump(fixture('dump-web-real.txt'));

  const timer = entries.find((entry) => entry.id === 'timer');
  assert.equal(timer.ownerInfo.name, '@deepseek-ai/dsh-base');
  assert.equal(timer.ownerInfo.version, '0.1.2-rc.1');
  assert.match(timer.ownerInfo.dir, /node_modules[\\/]@deepseek-ai[\\/]dsh-base$/);

  // `packageDir` is sometimes a folded scalar (`>-`) continued on the next line
  const native = entries.find((entry) => entry.id === 'bili-native');
  assert.equal(native.ownerInfo.name, 'billion-context');
  assert.equal(native.ownerInfo.version, '0.1.169');
  assert.match(native.ownerInfo.dir, /node_modules[\\/]billion-context$/);

  // every parsed owner block is complete, and none comes from a nested config
  for (const entry of entries) {
    if (!entry.ownerInfo) continue;
    assert.ok(entry.ownerInfo.name, entry.id);
    assert.ok(entry.ownerInfo.dir, entry.id);
    assert.ok(entry.ownerInfo.version, entry.id);
  }
});

test('parseDump reads a real profile patch', () => {
  const { entries } = parsePatch(fixture('patch-web-real.yml'), 'cordis.patch.yml');
  const ids = entries.map((entry) => entry.id);
  assert.ok(ids.includes('llm-deepseek'));
  assert.ok(ids.includes('ui-sidebar'));
  assert.ok(ids.includes('codex-ui'));

  // config.models[].id sits at indent 6 and must not be treated as an entry
  assert.ok(!ids.includes('deepseek-v4-pro'));
  assert.ok(!ids.includes('deepseek-v4-flash'));

  const deepseek = entries.find((entry) => entry.id === 'llm-deepseek');
  assert.equal(deepseek.name, '@deepseek-ai/dsh-llm-deepseek-api-key');
  assert.equal(deepseek.line, 30);

  const codex = entries.find((entry) => entry.id === 'codex-ui');
  assert.deepEqual(codex.disabled, { kind: 'bool', value: true });
  assert.equal(codex.insertedBy, null);
});

test('parsePatch reads insert: children at indent N+2 only', () => {
  const yaml = [
    '- id: ui-sidebar',
    '  disabled: true',
    '  insert:',
    '    - id: custom-title',
    "      name: 'pkg/session-title'",
    '      disabled: false',
    '    - id: custom-ui',
    "      name: 'pkg/ui'",
    '- id: other',
    '  config:',
    '    models:',
    '      - id: nested-model',
    '',
  ].join('\n');

  const { entries } = parsePatch(yaml, 'x.yml');
  assert.deepEqual(entries.map((entry) => entry.id), ['ui-sidebar', 'custom-title', 'custom-ui', 'other']);

  const custom = entries[1];
  assert.equal(custom.insertedBy, 'ui-sidebar');
  assert.equal(custom.name, 'pkg/session-title');
  assert.deepEqual(custom.disabled, { kind: 'bool', value: false });

  const second = entries[2];
  assert.equal(second.insertedBy, 'ui-sidebar', 'sibling inserts share the same owner');

  const sidebar = entries[0];
  assert.equal(sidebar.inserts.length, 2);
});

test('parsePatch tolerates comments and blank lines', () => {
  const yaml = ['# a comment', '', '- id: x', '  # inline comment', '  disabled: true', ''].join('\n');
  const { entries } = parsePatch(yaml, 'x.yml');
  assert.deepEqual(entries.map((entry) => entry.id), ['x']);
  assert.equal(entries[0].disabled.value, true);
});

test('parseDumpWarnings recovers DSH stderr diagnostics even when hard-wrapped', () => {
  const findings = parseDumpWarnings(fixture('dump-web-stderr-real.txt'));
  const codes = findings.map((item) => `${item.code}:${item.id}`);
  assert.ok(codes.includes('D001:llm-deepseek'), `got ${codes.join(', ')}`);
  // The console broke this id across a line, right after `ui`
  assert.ok(codes.includes('D002:michengai-codex-ui-session-title'), `got ${codes.join(', ')}`);
  assert.ok(codes.includes('D002:codex-ui'), `got ${codes.join(', ')}`);

  const mismatch = findings.find((item) => item.code === 'D001');
  assert.equal(mismatch.expected, '@deepseek-ai/dsh-llm-deepseek');
  assert.equal(mismatch.got, '@deepseek-ai/dsh-llm-deepseek-api-key');
  assert.equal(mismatch.severity, 'error');
  assert.match(mismatch.file, /cordis\.patch\.yml$/);

  assert.equal(new Set(codes).size, codes.length, 'diagnostics must be de-duplicated');
});

test('parseDumpWarnings on clean stderr yields nothing', () => {
  assert.deepEqual(parseDumpWarnings(''), []);
  assert.deepEqual(parseDumpWarnings('dsh web: http://127.0.0.1:3080/?token=x'), []);
});
