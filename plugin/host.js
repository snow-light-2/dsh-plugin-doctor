/**
 * dsh-plugin-doctor — host half.
 *
 * Plain ESM with no DSH SDK imports, so it needs no compiler and no DSH source
 * checkout. All it does is expose the CLI's `check --json` over one HTTP route;
 * the browser half renders the result.
 *
 * Two deliberate choices, both about not becoming the problem this plugin exists
 * to diagnose:
 *
 * 1. ONE route, ONE loader entry, no patch rows that disable anything. A plugin
 *    that disables other entries to make room for itself is exactly the class of
 *    bug this tool reports, so it must not be one.
 *
 * 2. The checks run in a CHILD PROCESS, not in the harness. A check reads the
 *    filesystem, spawns `dsh --dump-config`, and can block for seconds; doing
 *    that on the harness event loop would freeze the very UI that is drawing the
 *    report. It also means a check that throws takes down a subprocess rather
 *    than the harness.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-plugin-doctor';

/** Only the web server is needed; everything else is a child process. */
export const inject = ['webServer'];

const BASE_ROUTE = '/dsh-plugin-doctor';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'dsh-plugin-doctor.js');

/** A report is a few seconds of work; serving it twice in a row is not. */
const CACHE_MS = 15_000;
const TIMEOUT_MS = 120_000;

let cache = { at: 0, body: null };

/**
 * The profile the harness was started with. The desktop passes it on argv, and
 * reading it here is more reliable than guessing: the plugin is loaded *by* that
 * profile, so the two can never disagree.
 */
function activeProfile() {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--profile' && typeof argv[i + 1] === 'string') return argv[i + 1];
    if (arg.startsWith('--profile=')) return arg.slice('--profile='.length);
  }
  return 'web';
}

function runCli(args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [CLI, ...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ok: false, reason: `could not start the doctor CLI: ${error.message}` });
      return;
    }

    const out = [];
    const err = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* the child is already gone */
      }
      resolve({ ok: false, reason: `the doctor CLI did not finish within ${TIMEOUT_MS / 1000}s` });
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: `the doctor CLI failed to run: ${error.message}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: true,
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

async function buildReport() {
  if (!existsSync(CLI)) {
    return {
      ok: false,
      reason: `the doctor CLI is missing at ${CLI}. The host half and bin/ must ship in the same package.`,
    };
  }

  // `--json` prints one object on stdout. A non-zero exit means findings were
  // reported, which is a successful run with an unhappy result — not an error.
  const result = await runCli(['check', '--json', '--profile', activeProfile()]);
  if (!result.ok) return { ok: false, reason: result.reason };

  const text = result.stdout.trim();
  if (text === '') {
    const detail = result.stderr.trim().split('\n').slice(-4).join('\n');
    return {
      ok: false,
      reason: `the doctor CLI produced no report (exit ${result.code})${detail ? `:\n${detail}` : ''}`,
    };
  }

  try {
    return { ok: true, report: JSON.parse(text) };
  } catch (error) {
    return {
      ok: false,
      reason: `the doctor CLI printed something that is not JSON: ${error.message}`,
      raw: text.slice(0, 2000),
    };
  }
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function serveReport(res, { refresh }) {
  const now = Date.now();
  if (!refresh && cache.body && now - cache.at < CACHE_MS) {
    send(res, 200, { ...cache.body, cached: true, ageMs: now - cache.at });
    return;
  }
  buildReport().then((body) => {
    if (body.ok) cache = { at: Date.now(), body };
    send(res, body.ok ? 200 : 502, { ...body, cached: false, ageMs: 0 });
  });
}

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: BASE_ROUTE,
        handler: (req, res) => {
          let url;
          try {
            url = new URL(req.url ?? '/', 'http://localhost');
          } catch {
            send(res, 400, { ok: false, reason: 'malformed request URL' });
            return;
          }

          const route = url.pathname.slice(BASE_ROUTE.length) || '/';
          if (route === '/report' || route === '/') {
            serveReport(res, { refresh: url.searchParams.get('refresh') === '1' });
            return;
          }
          if (route === '/health') {
            send(res, 200, {
              ok: true,
              cli: CLI,
              cliPresent: existsSync(CLI),
              profile: activeProfile(),
              dshHome: process.env.DSH_HOME ?? null,
            });
            return;
          }
          send(res, 404, { ok: false, reason: `no such doctor route: ${route}` });
        },
      }),
    'dsh-plugin-doctor: report route',
  );
}
