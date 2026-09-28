import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadContext } from './context.js';
import { runChecks, summarize } from './checks.js';
import { printHeader, printFindings, printSummary, printGraph, toJson } from './report.js';
import { explainText } from './explain.js';
import { resolveHome, resolveDshBin, dshBinHelp } from './paths.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(resolve(HERE, '..', 'package.json'), 'utf8'));

const USAGE = `dsh-plugin-doctor ${PKG.version} — diagnose DSH plugin-tree conflicts

usage
  dsh-plugin-doctor capture [options]         compose the tree and save it as a dump
  dsh-plugin-doctor check   [options]         run every check and report findings
  dsh-plugin-doctor graph   [options]         print the composed loader tree
  dsh-plugin-doctor explain [file]            explain a harness log (or stdin)

options
  --home <dir>        DSH home (default: $DSH_HOME, then %APPDATA%\\dsh-desktop\\harness)
  --profile <name>    profile to inspect (default: web)
  --dump <file>       read an existing dump instead of composing one
  --dump-stderr <f>   companion stderr file from the same capture
  --dsh-bin <file>    path to @deepseek-ai/dsh/lib/bin.js
  --app <dir>         path to the DSH app directory (resources/app)
  --out <file>        capture output path (default: .dsh-doctor/dump-<profile>.txt)
  --json              machine-readable output
  --strict            treat warnings as failures
  --no-color          disable ANSI colour
  -h, --help          show this help
  -v, --version       show the version

exit codes
  0 clean (or only warnings, without --strict)
  1 findings at or above the failure threshold
  2 usage error, or the profile could not be read
`;

function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      flags._.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
        continue;
      }
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
      continue;
    }
    if (token.startsWith('-') && token.length > 1 && !/^-\d/.test(token)) {
      for (const ch of token.slice(1)) flags[ch] = true;
      continue;
    }
    flags._.push(token);
  }
  return flags;
}

const fail = (message) => {
  console.error(`dsh-plugin-doctor: ${message}`);
  return 2;
};

function resolveInputs(flags) {
  const profile = typeof flags.profile === 'string' ? flags.profile : 'web';
  const homeInfo = resolveHome(typeof flags.home === 'string' ? flags.home : undefined);
  const binInfo = resolveDshBin(typeof flags['dsh-bin'] === 'string' ? flags['dsh-bin'] : undefined, homeInfo.home);
  return { profile, homeInfo, binInfo };
}

/* --------------------------------------------------------------- capture */
function cmdCapture(flags) {
  const { profile, homeInfo, binInfo } = resolveInputs(flags);
  if (!binInfo.exists) {
    return fail(`cannot find @deepseek-ai/dsh/lib/bin.js\n${dshBinHelp(homeInfo.home)}`);
  }

  const outFile = resolve(typeof flags.out === 'string' ? flags.out : `.dsh-doctor/dump-${profile}.txt`);
  const errFile = outFile.replace(/\.txt$/, '') + '-stderr.txt';
  mkdirSync(dirname(outFile), { recursive: true });

  const result = spawnSync(process.execPath, ['--expose-internals', binInfo.bin, '--profile', profile, '--dump-config'], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, DSH_HOME: homeInfo.home },
  });

  if (result.error) return fail(`could not run the composer: ${result.error.message}`);
  writeFileSync(outFile, result.stdout ?? '', 'utf8');
  writeFileSync(errFile, result.stderr ?? '', 'utf8');

  const lines = (result.stdout ?? '').split(/\r?\n/).filter((line) => line.trim() !== '').length;
  console.log(`dump      ${outFile}`);
  console.log(`stderr    ${errFile}`);
  console.log(`entries   ${lines} non-empty lines`);
  console.log(`exit      ${result.status}`);
  console.log('');
  console.log(`next      dsh-plugin-doctor check --dump "${outFile}" --dump-stderr "${errFile}"`);
  return result.status === 0 ? 0 : 1;
}

/* ----------------------------------------------------------------- check */
function loadForRead(flags) {
  const { profile, homeInfo, binInfo } = resolveInputs(flags);
  let dumpPath = typeof flags.dump === 'string' ? resolve(flags.dump) : null;
  let stderrPath = typeof flags['dump-stderr'] === 'string' ? resolve(flags['dump-stderr']) : null;
  let captured = false;

  if (!dumpPath) {
    if (!binInfo.exists) return { error: 'no --dump given and the composer could not be located' };
    const target = resolve(`.dsh-doctor/dump-${profile}.txt`);
    mkdirSync(dirname(target), { recursive: true });
    const result = spawnSync(process.execPath, ['--expose-internals', binInfo.bin, '--profile', profile, '--dump-config'], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      env: { ...process.env, DSH_HOME: homeInfo.home },
    });
    if (result.error) return { error: `could not run the composer: ${result.error.message}` };
    writeFileSync(target, result.stdout ?? '', 'utf8');
    writeFileSync(target.replace(/\.txt$/, '') + '-stderr.txt', result.stderr ?? '', 'utf8');
    dumpPath = target;
    stderrPath = target.replace(/\.txt$/, '') + '-stderr.txt';
    captured = true;
  }

  try {
    const ctx = loadContext({
      home: flags.home,
      profile,
      dump: dumpPath,
      dumpStderr: stderrPath ?? undefined,
      patch: typeof flags.patch === 'string' ? resolve(flags.patch) : undefined,
      dshBin: typeof flags['dsh-bin'] === 'string' ? flags['dsh-bin'] : undefined,
      app: typeof flags.app === 'string' ? flags.app : undefined,
    });
    ctx.version = PKG.version;
    ctx.captured = captured;
    return { ctx };
  } catch (error) {
    return { error: error.message };
  }
}

function cmdCheck(flags) {
  const { ctx, error } = loadForRead(flags);
  if (error) return fail(error);

  const findings = runChecks(ctx);
  const counts = summarize(findings);
  const threshold = flags.strict ? ['error', 'warn'] : ['error'];
  const failed = findings.some((item) => threshold.includes(item.severity));

  if (flags.json) {
    console.log(JSON.stringify(toJson(ctx, findings, counts), null, 2));
  } else {
    printHeader(ctx);
    printFindings(findings, ctx);
    printSummary(counts);
    if (failed) console.log(`         ${ctx.captured ? 'dump was captured live; ' : ''}re-run with --json to attach to a bug report`);
  }
  return failed ? 1 : 0;
}

/* ----------------------------------------------------------------- graph */
function cmdGraph(flags) {
  const { ctx, error } = loadForRead(flags);
  if (error) return fail(error);
  if (flags.json) {
    console.log(JSON.stringify({ tree: ctx.dump, bundles: ctx.bundles, patch: ctx.patch }, null, 2));
    return 0;
  }
  printGraph(ctx);
  return 0;
}

/* --------------------------------------------------------------- explain */
function cmdExplain(flags) {
  const file = flags._[0];
  let text;
  if (file && file !== '-') {
    try {
      text = readFileSync(resolve(file), 'utf8');
    } catch (error) {
      return fail(`cannot read ${file}: ${error.message}`);
    }
  } else {
    try {
      text = readFileSync(0, 'utf8');
    } catch (error) {
      return fail(`cannot read stdin: ${error.message}`);
    }
  }

  const { lines, hits } = explainText(text);
  if (flags.json) {
    console.log(JSON.stringify({ lines, hits }, null, 2));
    return hits.length > 0 ? 1 : 0;
  }

  console.log(`scanned  ${lines} lines`);
  if (hits.length === 0) {
    console.log('matched  nothing — no known failure signature in this log');
    return 0;
  }
  const total = hits.reduce((sum, hit) => sum + hit.occurrences, 0);
  console.log(`matched  ${hits.length} distinct signature${hits.length === 1 ? '' : 's'} in ${total} line${total === 1 ? '' : 's'}`);
  console.log('');
  for (const [index, hit] of hits.entries()) {
    const times = hit.occurrences > 1 ? `  x${hit.occurrences}, last at line ${hit.line}` : '';
    console.log(`${String(index + 1).padStart(2)}. line ${hit.firstLine}  ${hit.title}${hit.code ? `  [${hit.code}]` : ''}${times}`);
    console.log(`    saw   ${hit.match}`);
    if (hit.groups.length) console.log(`    at    ${hit.groups.join('  |  ')}`);
    console.log(`    why   ${hit.why}`);
    console.log(`    fix   ${hit.fix}`);
    console.log('');
  }
  return 1;
}

/* ------------------------------------------------------------------ main */
export async function main(argv) {
  const flags = parseArgs(argv);
  if (flags.help || flags.h || flags._.length === 0) {
    console.log(USAGE);
    return flags._.length === 0 && !flags.help && !flags.h ? 2 : 0;
  }
  if (flags.version || flags.v) {
    console.log(PKG.version);
    return 0;
  }

  const command = flags._.shift();
  switch (command) {
    case 'capture':
      return cmdCapture(flags);
    case 'check':
      return cmdCheck(flags);
    case 'graph':
      return cmdGraph(flags);
    case 'explain':
      return cmdExplain(flags);
    default:
      console.error(`dsh-plugin-doctor: unknown command "${command}"\n`);
      console.log(USAGE);
      return 2;
  }
}
