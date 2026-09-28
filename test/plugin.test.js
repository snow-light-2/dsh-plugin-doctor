/**
 * The plugin halves are the part of this package that DSH loads, so they get
 * tested the way DSH loads them: the client through a stand-in
 * `window.__ModuleLoader__`, the host against a stand-in context.
 *
 * The checks that matter here are structural, and they are exactly the checks
 * this tool performs on other plugins: does the client register one seat in a
 * *list* slot, does it leave single-owner slots alone, does the host expose only
 * routes it owns, and does the bundle patch insert without disabling anything.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A relative specifier, not `import(resolve(...))`: on Windows the default ESM
// loader rejects a bare `E:\...` path with ERR_UNSUPPORTED_ESM_URL_SCHEME.
import * as host from '../plugin/host.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(resolve(ROOT, ...parts), 'utf8');

/* ----------------------------------------------------------- client half */

function loadClient() {
  let captured = null;
  const styleNodes = [];

  const fakeDocument = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: (node) => styleNodes.push(node) },
  };

  // Only the React surface the component actually touches.
  const identity = (type, props, ...children) => ({ type, props, children });
  const fakeReact = {
    createElement: identity,
    Fragment: Symbol('Fragment'),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
  };

  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = { __ModuleLoader__: { load: (definition) => { captured = definition; } } };
  globalThis.document = fakeDocument;

  try {
    // The bundle is evaluated for its registration side effect only.
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', read('plugin', 'client.js'))(
      globalThis.window,
      globalThis.document,
    );
  } finally {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
  }

  assert.ok(captured, 'the bundle never called window.__ModuleLoader__.load');
  const require = (name) => {
    assert.equal(name, 'react', `the bundle required "${name}", which is not guaranteed to exist`);
    return fakeReact;
  };
  return { exports: captured.factory(require), id: captured.id, styleNodes, identity };
}

test('the client bundle registers one entry in a list slot and nothing else', () => {
  const { exports, id, styleNodes } = loadClient();
  assert.equal(id, 'dsh-plugin-doctor');
  assert.deepEqual(exports.inject, ['slots'], 'only the slots service is needed');
  assert.equal(typeof exports.apply, 'function');

  const registrations = [];
  const injected = [];
  const ctx = {
    slots: {
      inject(name, fn) {
        injected.push(name);
        // The registration lives inside a generator so cordis can dispose it.
        const iterator = fn();
        let step = iterator.next();
        while (!step.done) step = iterator.next();
      },
      register(fields, component) {
        registrations.push({ fields, component });
        return () => {};
      },
    },
  };
  exports.apply(ctx);

  assert.deepEqual(injected, ['sidebar.footer.action']);
  assert.equal(registrations.length, 1, 'exactly one seat');
  const [{ fields, component }] = registrations;
  assert.equal(fields.name, 'sidebar.footer.action');
  assert.ok(fields.id, 'a list slot needs an id to tell entries apart');
  assert.equal(typeof fields.order, 'number');
  assert.equal(typeof component, 'function');

  // The style tag is the one intended module-level side effect.
  assert.equal(styleNodes.length, 1);
  assert.match(styleNodes[0].textContent, /dshdoc-panel/);
});

test('the client bundle stays off single-owner slots', () => {
  const source = read('plugin', 'client.js');
  // `sidebar.settings` is kind:"single" and already has an owner; `shell.overlay`
  // is where another plugin on this machine seats itself. Neither may be claimed.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /slots\.(inject|register)\(\s*["']sidebar\.settings["']/);
  assert.doesNotMatch(code, /slots\.(inject|register)\(\s*["']shell\.overlay["']/);
});

/* ------------------------------------------------------------- host half */

function loadHost() {
  const registrations = [];
  const effects = [];
  const ctx = {
    effect(fn, label) {
      effects.push(label);
      return fn();
    },
    webServer: {
      register(route) {
        registrations.push(route);
        return () => {};
      },
    },
  };
  return { ctx, registrations, effects };
}

function fakeResponse() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(text) {
      this.body = text;
    },
  };
}

test('the host half exposes one route and answers only its own paths', () => {
  assert.equal(host.name, 'dsh-plugin-doctor');
  assert.deepEqual(host.inject, ['webServer']);

  const { ctx, registrations, effects } = loadHost();
  const disposer = host.apply(ctx);
  assert.equal(registrations.length, 1, 'the host must claim exactly one route');
  assert.equal(registrations[0].kind, 'prefix');
  assert.equal(registrations[0].path, '/dsh-plugin-doctor');
  assert.equal(typeof registrations[0].handler, 'function');
  assert.equal(typeof disposer, 'undefined', 'ctx.effect owns disposal, not apply');
  assert.deepEqual(effects, ['dsh-plugin-doctor: report route']);
});

test('the host route answers unknown paths with 404, not a report', () => {
  const { ctx, registrations } = loadHost();
  host.apply(ctx);
  const handler = registrations[0].handler;

  const missing = fakeResponse();
  handler({ url: '/dsh-plugin-doctor/nope' }, missing);
  assert.equal(missing.status, 404);
  assert.equal(JSON.parse(missing.body).ok, false);

  const health = fakeResponse();
  handler({ url: '/dsh-plugin-doctor/health' }, health);
  assert.equal(health.status, 200);
  const body = JSON.parse(health.body);
  assert.equal(body.ok, true);
  assert.match(body.profile, /^\S+$/, 'the profile must be resolved, not blank');
  assert.equal(typeof body.cliPresent, 'boolean');

  // A malformed URL is rejected rather than crashing the handler.
  const bad = fakeResponse();
  handler({ url: 'http://[not a url' }, bad);
  assert.equal(bad.status, 400);
});

/* --------------------------------------------------------- bundle patch */

test('the bundle patch inserts itself without disabling anything', () => {
  const patch = read('cordis.patch.yml');
  assert.match(patch, /^-\s*insert:/m);
  assert.match(patch, /name:\s*dsh-plugin-doctor/);
  assert.doesNotMatch(patch, /^\s*disabled:\s*true\s*$/m, 'this plugin must not switch others off');
  assert.doesNotMatch(patch, /^\s*-\s*id:\s*u[is]-/m, 'it must not touch host entries');
});

test('the manifest tells DSH how to load both halves', () => {
  const manifest = JSON.parse(read('package.json'));
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.main, './plugin/host.js');
  assert.equal(manifest.exports['.'], './plugin/host.js');
  assert.equal(manifest.exports['./client'], './plugin/client.js');

  const dsh = manifest.dsh;
  assert.equal(dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(dsh.client.platform, 'web');
  assert.ok(dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-slots'));
  assert.match(dsh.engines.dsh, /^>=/, 'the engine range must be a range, not a pin');

  // Everything DSH reads at runtime has to survive `npm pack`.
  for (const entry of ['plugin', 'bin', 'src', 'cordis.patch.yml']) {
    assert.ok(manifest.files.includes(entry), `${entry} is missing from files[]`);
  }
});
