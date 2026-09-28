import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runChecks,
  summarize,
  checkPatchNameMismatch,
  checkPatchOrphans,
  checkSingletonFamilies,
  checkMarketDesync,
  checkPluginLinks,
  checkLayeredOverrides,
  checkDependencyClosure,
  checkStaleInstalls,
  checkDuplicatePackage,
  checkAnalysisCoverage,
} from '../src/checks.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const bool = (value) => ({ kind: 'bool', value });
const on = (id, name, owner = null) => ({ id, name, disabled: null, line: 0, section: null, owner, patchedBy: null });
const off = (id, name, owner = null) => ({ id, name, disabled: bool(true), line: 0, section: null, owner, patchedBy: null });

function makeCtx(overrides = {}) {
  const entries = overrides.entries ?? [];
  const installed = overrides.installed ?? [];
  return {
    options: {},
    home: 'H',
    profile: 'web',
    profileDir: 'P',
    nodeModulesDir: 'NM',
    appDir: null,
    appNodeModules: null,
    dump: { entries, sections: [] },
    dumpWarnings: overrides.warnings ?? [],
    patch: { path: 'P/cordis.patch.yml', entries: overrides.patch ?? [] },
    manifestPath: 'P/package.json',
    bundles: overrides.bundles ?? [],
    dependencies: {},
    market: overrides.market ?? null,
    marketPath: 'P/.dsh-market/state.json',
    installed,
    installedByName: new Map(installed.map((pkg) => [pkg.name, pkg])),
    loadedDirs: new Map(),
    bundlePatches: overrides.bundlePatches ?? new Map(),
    recovery: null,
    recoveryPath: 'H/recovery/plugin-removals.json',
    hostVersion: '0.1.2-rc.1',
    nodeVersion: 'v24.0.0',
    enabled: entries.filter((entry) => entry.disabled === null || (entry.disabled.kind === 'bool' && !entry.disabled.value)),
    dynamic: entries.filter((entry) => entry.disabled?.kind === 'js'),
    resolutionRoots: overrides.resolutionRoots ?? [],
    sharedTreeKeep: new Set(['dshmarket']),
    loggedInstalls: [],
    bin: null,
    availability: { profileDir: true, patchLayer: true, manifest: true, market: true, nodeModules: true, dumpEntries: entries.length },
    ...overrides.ctx,
  };
}

/* ---------------------------------------------------------------- D001 */
test('D001 fires when a patch entry declares the wrong package name', () => {
  const ctx = makeCtx({
    entries: [on('llm-deepseek', '@deepseek-ai/dsh-llm-deepseek')],
    patch: [{ id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key', disabled: null, line: 30, file: 'p.yml' }],
  });
  const findings = checkPatchNameMismatch(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'D001');
  assert.equal(findings[0].severity, 'error');
  assert.equal(findings[0].where.line, 30);
  assert.equal(findings[0].expected, '@deepseek-ai/dsh-llm-deepseek');
  assert.match(findings[0].fix, /dsh-llm-deepseek/);
});

test('D001 stays silent when the name matches', () => {
  const ctx = makeCtx({
    entries: [on('locale', '@deepseek-ai/dsh-client-locale')],
    patch: [{ id: 'locale', name: '@deepseek-ai/dsh-client-locale', disabled: null, line: 10, file: 'p.yml' }],
  });
  assert.deepEqual(checkPatchNameMismatch(ctx), []);
});

test('D001 picks up the same problem from DSH stderr without double-reporting', () => {
  const ctx = makeCtx({
    entries: [on('llm-deepseek', '@deepseek-ai/dsh-llm-deepseek')],
    patch: [{ id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key', disabled: null, line: 30, file: 'p.yml' }],
    warnings: [
      {
        code: 'D001',
        severity: 'error',
        file: 'p.yml',
        id: 'llm-deepseek',
        expected: '@deepseek-ai/dsh-llm-deepseek',
        got: '@deepseek-ai/dsh-llm-deepseek-api-key',
        message: 'x',
      },
    ],
  });
  assert.equal(checkPatchNameMismatch(ctx).length, 1, 'the static pass and stderr must not both report');
});

/* ---------------------------------------------------------------- D002 */
test('D002 treats a pure disable guard as informational', () => {
  const ctx = makeCtx({ patch: [{ id: 'codex-ui', name: null, disabled: bool(true), line: 82, file: 'p.yml' }] });
  const findings = checkPatchOrphans(ctx);
  assert.equal(findings[0].severity, 'info');
  assert.match(findings[0].title, /defensive/);
  assert.equal(findings[0].fix, null);
});

test('D002 warns about an orphan that was meant to do something', () => {
  const ctx = makeCtx({ patch: [{ id: 'ghost', name: 'pkg/ghost', disabled: null, line: 5, file: 'p.yml' }] });
  const findings = checkPatchOrphans(ctx);
  assert.equal(findings[0].severity, 'warn');
  assert.match(findings[0].message, /does nothing/);
});

/* ---------------------------------------------------------------- D003 */
test('D003 ignores one package loaded as several entries from one install', () => {
  const entries = ['preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis'].map((id) => ({
    ...on(id, '@deepseek-ai/dsh-agent-preset', '@deepseek-ai/dsh-web-app'),
    ownerInfo: { name: '@deepseek-ai/dsh-agent-preset', dir: 'APP/preset', version: '0.1.2-rc.1' },
  }));
  assert.deepEqual(checkDuplicatePackage(makeCtx({ entries })), []);
});

test('D003 flags one package loaded from two installs', () => {
  const entries = [
    { ...on('a', 'pkg', 'bundle'), ownerInfo: { name: 'pkg', dir: 'ONE/pkg', version: '1.0.0' } },
    { ...on('b', 'pkg', 'bundle'), ownerInfo: { name: 'pkg', dir: 'TWO/pkg', version: '1.1.0' } },
  ];
  const findings = checkDuplicatePackage(makeCtx({ entries }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'error');
  assert.match(findings[0].message, /1\.0\.0, 1\.1\.0/);
});

test('D003 stays quiet when the dump carries no owner blocks', () => {
  const entries = [on('a', 'pkg', 'bundle'), on('b', 'pkg', 'bundle')];
  assert.deepEqual(checkDuplicatePackage(makeCtx({ entries })), []);
});

/* ---------------------------------------------------------------- D004 */
test('D004 catches the exact clash that killed the harness', () => {
  const ctx = makeCtx({
    entries: [
      on('session-title', '@deepseek-ai/dsh-session-title', '@deepseek-ai/dsh-base'),
      on('session-title-llm', '@deepseek-ai/dsh-session-title-first-prompt-llm', '@deepseek-ai/dsh-base'),
      on('michengai-codex-ui-session-title', '@michengai/dsh-codex-ui/session-title', '@michengai/dsh-codex-ui'),
    ],
  });
  const findings = checkSingletonFamilies(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'error');
  assert.equal(findings[0].ids.length, 2, 'the service package is not a contender');
  assert.match(findings[0].fix, /disable the other/);
});

test('D004 is happy with exactly one session-title provider', () => {
  const ctx = makeCtx({
    entries: [
      on('session-title', '@deepseek-ai/dsh-session-title', '@deepseek-ai/dsh-base'),
      on('session-title-llm', '@deepseek-ai/dsh-session-title-first-prompt-llm', '@deepseek-ai/dsh-base'),
      off('michengai-codex-ui-session-title', '@michengai/dsh-codex-ui/session-title', '@michengai/dsh-codex-ui'),
    ],
  });
  assert.deepEqual(checkSingletonFamilies(ctx), []);
});

/* ---------------------------------------------------------------- D005 */
test('D005 reports a market row the tree contradicts', () => {
  const ctx = makeCtx({
    entries: [on('better-sidebar', 'dsh-better-sidebar', 'dsh-better-sidebar')],
    market: { disabled: ['dsh-better-sidebar'] },
    bundles: ['dsh-better-sidebar'],
  });
  const findings = checkMarketDesync(ctx);
  assert.equal(findings[0].severity, 'warn');
  assert.match(findings[0].message, /still has 1 enabled entry/);
});

test('D005 calls a row for an uninstalled plugin stale bookkeeping', () => {
  const ctx = makeCtx({ market: { disabled: ['@michengai/dsh-codex-ui'] }, bundles: [] });
  const findings = checkMarketDesync(ctx);
  assert.equal(findings[0].severity, 'info');
  assert.match(findings[0].title, /stale/);
});

test('D005 notices a bundle that contributes nothing', () => {
  const ctx = makeCtx({ bundles: ['ghost-bundle'], installed: [] });
  const findings = checkMarketDesync(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'warn');
  assert.match(findings[0].title, /contributes no loader entries/);
});

test('D005 escalates when the declared bundle is not on disk', () => {
  const ctx = makeCtx({
    bundles: ['ghost-bundle'],
    installed: [{ name: 'ghost-bundle', dir: 'NM/ghost-bundle', link: { kind: 'absent' }, manifest: {}, version: null, dsh: {} }],
  });
  const findings = checkMarketDesync(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'error');
  assert.match(findings[0].title, /not installed/);
});

/* ---------------------------------------------------------------- D006 */
test('D006 only flags materialised directories that are meant to be managed', () => {
  const dir = (name) => ({ name, dir: `NM/${name}`, link: { kind: 'dir', target: null, real: null }, manifest: {}, version: '1.0.0', dsh: {} });
  const link = (name) => ({ name, dir: `NM/${name}`, link: { kind: 'link', target: 'G', real: 'G' }, manifest: {}, version: '1.0.0', dsh: {} });

  const managed = makeCtx({ bundles: ['dsh-pet'], installed: [dir('dsh-pet')] });
  assert.equal(checkPluginLinks(managed).length, 1);
  assert.equal(checkPluginLinks(managed)[0].severity, 'error');

  const unmanaged = makeCtx({ bundles: [], installed: [dir('leftover')] });
  assert.deepEqual(checkPluginLinks(unmanaged), []);

  const shared = makeCtx({ bundles: ['dshmarket'], installed: [dir('dshmarket')] });
  assert.deepEqual(checkPluginLinks(shared), [], 'shared-tree packages live in the app, not the profile');

  const linked = makeCtx({ bundles: ['dsh-pet'], installed: [link('dsh-pet')] });
  assert.deepEqual(checkPluginLinks(linked), []);
});

/* ---------------------------------------------------------------- D009 */
test('D009 shows which layer won', () => {
  const ctx = makeCtx({
    entries: [on('ui-sidebar', '@deepseek-ai/dsh-client-ui-sidebar')],
    patch: [{ id: 'ui-sidebar', name: null, disabled: bool(false), line: 69, file: 'p.yml' }],
    bundlePatches: new Map([
      ['@michengai/dsh-codex-ui', { bundle: '@michengai/dsh-codex-ui', file: 'b.yml', entries: [{ id: 'ui-sidebar', name: null, disabled: bool(true), line: 1, inserts: [] }] }],
    ]),
  });
  const findings = checkLayeredOverrides(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'info');
  assert.match(findings[0].message, /changes it to on/);
});

test('D009 warns when a bundle insert is shadowed by the profile patch', () => {
  const ctx = makeCtx({
    entries: [on('injected', 'pkg/injected')],
    patch: [{ id: 'injected', name: null, disabled: null, line: 3, file: 'p.yml' }],
    bundlePatches: new Map([
      [
        'pkg',
        {
          bundle: 'pkg',
          file: 'b.yml',
          entries: [
            { id: 'base', name: null, disabled: bool(true), line: 1, inserts: [{ id: 'injected', name: 'pkg/injected', line: 2 }] },
          ],
        },
      ],
    ]),
  });
  const findings = checkLayeredOverrides(ctx).filter((item) => item.severity === 'warn');
  assert.equal(findings.length, 1);
  assert.match(findings[0].title, /shadowed/);
});

/* ---------------------------------------------------------------- D008 */
test('D008 flags a declared dependency that is not in the closure', () => {
  const plugin = {
    name: 'dsh-pet',
    dir: 'NM/dsh-pet',
    link: { kind: 'link' },
    version: '0.2.12',
    dsh: {},
    manifest: { name: 'dsh-pet', version: '0.2.12', dependencies: { '@deepseek-ai/dsh-client-runtime': '^0.1.2' } },
  };
  const ctx = makeCtx({
    entries: [on('pet', 'dsh-pet', 'dsh-pet')],
    installed: [plugin],
    resolutionRoots: [],
  });
  const findings = checkDependencyClosure(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'error');
  assert.match(findings[0].message, /dsh-client-runtime/);
});

test('D008 downgrades a peer-only miss and a disabled plugin', () => {
  const base = (extra) => ({
    name: 'x',
    dir: 'NM/x',
    link: { kind: 'link' },
    version: '1.0.0',
    dsh: {},
    manifest: { name: 'x', version: '1.0.0', ...extra },
  });

  const live = makeCtx({ entries: [on('x', 'x', 'x')], installed: [base({ peerDependencies: { ghost: '*' } })] });
  assert.equal(checkDependencyClosure(live)[0].severity, 'warn');

  const disabled = makeCtx({ entries: [off('x', 'x', 'x')], installed: [base({ dependencies: { ghost: '*' } })] });
  assert.equal(checkDependencyClosure(disabled)[0].severity, 'info');
});

test('D008 is silent when the declared dependency resolves', () => {
  const ctx = makeCtx({
    entries: [on('x', 'x', 'x')],
    installed: [
      {
        name: 'x',
        dir: 'NM/x',
        link: { kind: 'link' },
        version: '1.0.0',
        dsh: {},
        // `fixtures/` exists in this repo, so it stands in for a resolvable package
        manifest: { name: 'x', version: '1.0.0', dependencies: { fixtures: '*' } },
      },
    ],
    resolutionRoots: [REPO],
  });
  assert.deepEqual(checkDependencyClosure(ctx), []);
});

test('D008 is silent for a plugin that declares nothing', () => {
  const ctx = makeCtx({
    entries: [on('x', 'x', 'x')],
    installed: [{ name: 'x', dir: 'NM/x', link: { kind: 'link' }, version: '1.0.0', dsh: {}, manifest: { name: 'x', version: '1.0.0' } }],
  });
  assert.deepEqual(checkDependencyClosure(ctx), []);
});

/* ---------------------------------------------------------------- D015 */
test('D015 warns when the profile layer was unavailable', () => {
  const ctx = makeCtx({ ctx: { availability: { profileDir: false, patchLayer: false } } });
  const findings = checkAnalysisCoverage(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'warn');
  assert.match(findings[0].message, /only the dump was analysed/);
  assert.match(findings[0].message, /would not mean this profile is healthy/);
});

test('D015 says nothing when the profile layer was read', () => {
  assert.deepEqual(checkAnalysisCoverage(makeCtx()), []);
});

test('D015 mentions a missing patch layer as info, not a fault', () => {
  const ctx = makeCtx({
    ctx: { availability: { profileDir: true, patchLayer: false }, patch: { path: null, entries: [] } },
  });
  const findings = checkAnalysisCoverage(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'info');
  assert.match(findings[0].title, /no profile patch layer/);
});

/* ---------------------------------------------------------------- D014 */
test('D014 notices a second installation the logs still point at', () => {
  const ctx = makeCtx({ ctx: { bin: resolve(REPO, 'bin', 'dsh-plugin-doctor.js'), loggedInstalls: [] } });
  assert.deepEqual(checkStaleInstalls(ctx), []);

  const withGhost = makeCtx({
    ctx: {
      bin: 'APP/node_modules/@deepseek-ai/dsh/lib/bin.js',
      logSource: 'harness.log',
      loggedInstalls: [
        { bin: 'OLD/node_modules/@deepseek-ai/dsh/lib/bin.js', exists: false, source: 'harness.log' },
        { bin: 'APP/node_modules/@deepseek-ai/dsh/lib/bin.js', exists: true, source: 'harness.log' },
      ],
    },
  });
  assert.deepEqual(checkStaleInstalls(withGhost), [], 'a vanished install is not a duplicate');

  const duplicate = makeCtx({
    ctx: {
      bin: 'APP/node_modules/@deepseek-ai/dsh/lib/bin.js',
      logSource: 'harness.log',
      loggedInstalls: [
        { bin: 'OLD/node_modules/@deepseek-ai/dsh/lib/bin.js', exists: true, source: 'harness.log' },
        { bin: 'APP/node_modules/@deepseek-ai/dsh/lib/bin.js', exists: true, source: 'harness.log' },
      ],
    },
  });
  const findings = checkStaleInstalls(duplicate);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'warn');
  assert.match(findings[0].message, /OLD/);
});

/* ------------------------------------------------------------ aggregate */
test('runChecks deduplicates, sorts by severity, and never throws', () => {
  const ctx = makeCtx({
    entries: [
      on('llm-deepseek', '@deepseek-ai/dsh-llm-deepseek'),
      on('a', '@deepseek-ai/dsh-session-title-x', '@deepseek-ai/dsh-base'),
      on('b', 'other/session-title', 'other'),
    ],
    patch: [
      { id: 'llm-deepseek', name: 'wrong', disabled: null, line: 30, file: 'p.yml' },
      { id: 'ghost', name: null, disabled: bool(true), line: 1, file: 'p.yml' },
    ],
  });
  const findings = runChecks(ctx);
  assert.ok(findings.length >= 3, `got ${findings.length}`);
  assert.equal(findings[0].severity, 'error');
  assert.equal(findings.at(-1).severity, 'info');

  const keys = findings.map((item) => item.key);
  assert.equal(new Set(keys).size, keys.length, 'keys must be unique');

  const counts = summarize(findings);
  assert.equal(counts.error + counts.warn + counts.info, findings.length);
});

test('runChecks survives a context that makes a check throw', () => {
  const ctx = makeCtx();
  ctx.patch = null; // deliberately hostile
  const findings = runChecks(ctx);
  assert.ok(findings.some((item) => item.code === 'D000'), 'a crashing check must be reported, not fatal');
});
