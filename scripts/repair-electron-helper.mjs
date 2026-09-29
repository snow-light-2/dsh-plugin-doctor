#!/usr/bin/env node
/**
 * Repair a downloaded Electron desktop helper.
 *
 * Plugins that draw their own desktop window — dsh-pet's pet is the one on this
 * machine — download an Electron into `$DSH_HOME/electron` on first use. Their
 * "is it installed?" check only looks for the executable. So when the Chromium
 * data files go missing, the plugin believes Electron is fine, launches it,
 * watches it die with `Invalid file descriptor to ICU data received`, retries
 * until its consecutive-crash limit trips, and stops. The feature disappears and
 * nothing reports why.
 *
 * This script checks the helper the way the runtime needs it, and when it is
 * broken moves the directory aside and re-runs the plugin's own downloader —
 * which is the only way to get it downloaded again, precisely because that
 * downloader will not act while the executable is still sitting there.
 *
 * Usage:
 *   node scripts/repair-electron-helper.mjs [--home <dshHome>] [--dry-run] [--json]
 */

import { existsSync, readdirSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { resolveHome } from '../src/paths.js';

const argv = process.argv.slice(2);
const flags = { _: [] };
for (let i = 0; i < argv.length; i += 1) {
  const raw = argv[i];
  if (!raw.startsWith('--')) {
    flags._.push(raw);
    continue;
  }
  const [key, inline] = raw.slice(2).split(/=(.*)/s);
  if (inline !== undefined) flags[key] = inline;
  else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
  else flags[key] = true;
}

const asJson = flags.json === true;
const dryRun = flags['dry-run'] === true;
const say = (...args) => {
  if (!asJson) console.log(...args);
};

const readdir = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** The same contract D016 checks: the executable plus what it reads at startup. */
function inspect(home) {
  const dir = join(home, 'electron');
  const mac = process.platform === 'darwin';
  const exe = mac
    ? join(dir, 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : join(dir, process.platform === 'win32' ? 'electron.exe' : 'electron');

  if (!existsSync(exe)) return { dir, exe, state: 'absent', missing: [], locales: 0, entries: [] };

  const required = mac
    ? [['Electron.app', 'Contents', 'Frameworks', 'Electron Framework.framework', 'Resources', 'icudtl.dat']]
    : [['icudtl.dat'], ['resources.pak'], ['snapshot_blob.bin'], ['v8_context_snapshot.bin']];
  const missing = required.filter((parts) => !existsSync(join(dir, ...parts))).map((parts) => parts.at(-1));

  const localesDir = mac
    ? join(dir, 'Electron.app', 'Contents', 'Frameworks', 'Electron Framework.framework', 'Resources')
    : join(dir, 'locales');
  const locales = readdir(localesDir).length;
  const entries = readdir(dir).filter((name) => !name.startsWith('.'));

  const state = missing.length === 0 && locales > 0 ? 'ok' : 'broken';
  return { dir, exe, state, missing, locales, entries };
}

/** The plugin's own downloader, wherever it landed in a profile. */
function findDownloader(home) {
  const profilesDir = join(home, 'profiles');
  for (const profile of readdir(profilesDir)) {
    const nodeModules = join(profilesDir, profile, 'node_modules');
    const packages = [];
    for (const entry of readdir(nodeModules)) {
      if (entry.startsWith('@')) {
        for (const inner of readdir(join(nodeModules, entry))) packages.push(join(nodeModules, entry, inner));
      } else if (entry !== '.bin' && entry !== '.pnpm') {
        packages.push(join(nodeModules, entry));
      }
    }
    for (const dir of packages) {
      const script = join(dir, 'scripts', 'ensure-electron.mjs');
      if (existsSync(script)) return script;
    }
  }
  return null;
}

function main() {
  const home = resolveHome(typeof flags.home === 'string' ? flags.home : undefined).home;
  const found = inspect(home);

  say(`home       ${home}`);
  say(`helper     ${found.dir}`);
  say(`state      ${found.state}`);

  if (found.state === 'absent') {
    say('\n  No Electron helper here, so no plugin is using one. Nothing to do.');
    if (asJson) console.log(JSON.stringify({ ok: true, home, state: found.state }, null, 2));
    return 0;
  }

  if (found.state === 'ok') {
    say(`  locales    ${found.locales}`);
    say('\n  The helper is complete. The desktop window is failing for some other reason;');
    say('  check the harness log for the line that names it.');
    if (asJson) console.log(JSON.stringify({ ok: true, home, state: found.state, locales: found.locales }, null, 2));
    return 0;
  }

  say(`  missing    ${found.missing.join(', ')}${found.locales === 0 ? ', locales/' : ''}`);
  say(`  entries    ${found.entries.length} (${found.entries.slice(0, 10).join(', ')})`);
  say('\n  This is why the window never appears: Electron cannot start without those files.');

  const downloader = findDownloader(home);
  if (!downloader) {
    say('\n  Could not find a plugin downloader (scripts/ensure-electron.mjs) in any profile.');
    say(`  Move ${found.dir} aside yourself, then restart DSH to trigger a fresh download.`);
    if (asJson) console.log(JSON.stringify({ ok: false, home, state: found.state, reason: 'no downloader' }, null, 2));
    return 2;
  }
  say(`  downloader ${downloader}`);

  if (dryRun) {
    say(`\n  --dry-run: would rename ${found.dir} aside and re-run the downloader.`);
    if (asJson) console.log(JSON.stringify({ ok: true, dryRun: true, home, state: found.state }, null, 2));
    return 0;
  }

  // The downloader refuses to act while an executable is present, so the broken
  // copy has to move first. Renamed rather than deleted: those files are the
  // evidence of what went wrong.
  const aside = `${found.dir}.broken-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    renameSync(found.dir, aside);
  } catch (error) {
    say(`\n  Could not move the broken helper aside: ${error.message}`);
    say('  Close DSH Desktop and try again — a running helper holds the files open.');
    return 2;
  }
  say(`\n  moved aside  ${aside}`);
  say('  downloading ...');

  const run = spawnSync(process.execPath, [downloader], {
    encoding: 'utf8',
    timeout: 15 * 60 * 1000,
    windowsHide: true,
    env: { ...process.env, DSH_HOME: home },
  });
  if (run.stdout) say(run.stdout.trimEnd().split('\n').map((line) => `    ${line}`).join('\n'));
  if (run.stderr) say(run.stderr.trimEnd().split('\n').map((line) => `    ${line}`).join('\n'));

  const after = inspect(home);
  say(`\n  after      ${after.state}`);
  if (after.state === 'ok') {
    say(`  locales    ${after.locales}`);
    say('\n  Repaired. Restart DSH Desktop and the window should come back.');
    say(`  The broken copy is kept at ${aside} — delete it once you are happy.`);
    if (asJson) console.log(JSON.stringify({ ok: true, home, state: 'repaired', locales: after.locales, keptAt: aside }, null, 2));
    return 0;
  }

  say(`  still missing ${after.missing.join(', ')}${after.locales === 0 ? ', locales/' : ''}`);
  say('\n  The download did not produce a complete helper.');
  say('  That usually means something on this machine deletes Chromium data files:');
  say('  check your antivirus for a quarantine entry, and exclude this directory.');
  if (asJson) console.log(JSON.stringify({ ok: false, home, state: after.state, keptAt: aside }, null, 2));
  return 1;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`repair-electron-helper: ${error.message}`);
  process.exitCode = 2;
}
