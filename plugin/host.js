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

/**
 * The environment the CLI child needs.
 *
 * Under `dsh web` the host half runs in a plain Node process, so `process.execPath`
 * is node itself and spawning it re-enters the CLI. The desktop build is not that:
 * its harness runs inside the Electron binary, so `process.execPath` is the GUI
 * application, and spawning it would launch a second window instead of the script.
 * Electron only acts as Node when this variable is set.
 */
function childEnv() {
  const env = { ...process.env };
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

/**
 * The harness's own `bin.js`, so the CLI does not have to rediscover it.
 *
 * The CLI locates dsh by reading the desktop's log files. That works under the
 * third-party desktop build, which writes `logs/harness.log` beside the home, but
 * the official build keeps no such log — so `loggedInstalls` came back empty, the
 * composer could not be found, and every `/report` failed with a 502 while
 * `/health` still looked fine.
 *
 * The host half is loaded *by* the harness, so it already knows the answer:
 * the launcher passes bin.js as the first script argument.
 */
function harnessBin() {
  // The plain launcher passes the harness entry as the first script argument.
  for (const arg of process.argv) {
    if (typeof arg === 'string' && /[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/.test(arg)) return arg;
  }
  // The desktop build does not: its process entry is the shell's own host CLI,
  // which drives the harness next to it. `@deepseek-ai/dsh-desktop-host/lib/cli.js`
  // therefore implies `@deepseek-ai/dsh/lib/bin.js` — replacing the package name
  // and the file name is enough.
  for (const arg of process.argv) {
    if (typeof arg !== 'string') continue;
    const shell = /^(.*)[\\/]@deepseek-ai[\\/]dsh-desktop-host[\\/]lib[\\/]cli\.js$/.exec(arg);
    if (shell) return join(shell[1], '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  }
  return undefined;
}

function runCli(args) {
  return new Promise((resolve) => {
    const bin = harnessBin();
    const finalArgs = bin && !args.includes('--dsh-bin') ? [...args, '--dsh-bin', bin] : args;
    let child;
    try {
      child = spawn(process.execPath, [CLI, ...finalArgs], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv(),
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

/**
 * Who may call these routes.
 *
 * `ctx.webServer.register` mounts a route BEFORE the harness's own auth: DSH's
 * `/api/*` answers 401 without a token, while a plugin prefix answered 200 to
 * anything that could reach the loopback interface. Binding to 127.0.0.1 keeps
 * other machines out. It does not keep out a page running in your own browser:
 *
 *   - DNS rebinding points evil.example.com at 127.0.0.1, which makes script on
 *     that page same-origin, so it can READ the response -- CORS never enters
 *     into it. Checking the Host header by name is what stops this.
 *   - An ordinary cross-site fetch cannot read the body (no CORS header is
 *     sent), but the handler still RUNS, and `/report` spawns processes. Origin
 *     and Sec-Fetch-Site stop that.
 *
 * A local script or curl sends neither header and still works: for processes
 * already on this machine, the loopback bind is the real boundary.
 */
const LOOPBACK_HOST = /^(127(?:\.\d{1,3}){3}|localhost|\[::1\]|::1)$/i;
const LOOPBACK_ORIGIN = /^https?:\/\/(127(?:\.\d{1,3}){3}|localhost|\[::1\])(:\d+)?$/i;

function hostName(raw) {
  const value = String(raw ?? '').trim();
  if (value.startsWith('[')) {
    const end = value.indexOf(']'); // [::1]:43129
    return end === -1 ? value : value.slice(0, end + 1);
  }
  const colon = value.indexOf(':');
  return colon === -1 ? value : value.slice(0, colon);
}

function isLocalRequest(req) {
  const headers = req?.headers ?? {};

  if (!LOOPBACK_HOST.test(hostName(headers.host))) return false;

  const origin = headers.origin;
  if (typeof origin === 'string' && origin !== '' && !LOOPBACK_ORIGIN.test(origin)) return false;

  const site = headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== '' && site !== 'same-origin' && site !== 'none') return false;

  return true;
}

/** Concurrency guard: N callers must not spawn N check processes. */
let inFlight = null;

function serveReport(res, { refresh }) {
  const now = Date.now();
  if (!refresh && cache.body && now - cache.at < CACHE_MS) {
    send(res, 200, { ...cache.body, cached: true, ageMs: now - cache.at });
    return;
  }

  if (!inFlight) {
    inFlight = buildReport()
      .then((body) => {
        if (body.ok) cache = { at: Date.now(), body };
        return body;
      })
      .finally(() => {
        inFlight = null;
      });
  }

  inFlight.then((body) => {
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
          if (!isLocalRequest(req)) {
            send(res, 403, {
              ok: false,
              reason: 'this route answers only same-origin requests arriving over the loopback interface',
            });
            return;
          }

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
              // Whatever this build exposes as the running script, so a failing
              // /report can be told apart from an unlocatable harness.
              argv1: process.argv[1] ?? null,
              harnessBin: harnessBin() ?? null,
              electron: process.versions.electron ?? null,
              runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
            });
            return;
          }
          send(res, 404, { ok: false, reason: `no such doctor route: ${route}` });
        },
      }),
    'dsh-plugin-doctor: report route',
  );
}
