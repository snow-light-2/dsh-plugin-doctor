#!/usr/bin/env node
/**
 * Install this package into a DSH profile — carefully.
 *
 * Installing a plugin into DSH is the exact operation that produces the failures
 * this tool diagnoses, so the installer refuses to behave like the tools that
 * caused them. It:
 *
 *   1. refuses to run while DSH Desktop is open, because the market rewrites
 *      `dsh.profile.bundles` on boot and would race this edit;
 *   2. refuses to install into a profile that already reports errors, because
 *      stacking a change onto a broken tree destroys your ability to tell which
 *      change broke it (`--force` overrides, deliberately loudly);
 *   3. backs up every file it is about to touch, before touching it;
 *   4. verifies the result by composing the tree for real, and rolls itself back
 *      automatically if the plugin does not appear;
 *   5. never disables anything, and removes exactly what it added on --uninstall.
 *
 * Usage:
 *   node scripts/install-plugin.mjs [--profile web] [--dry-run] [--force] [--json]
 *   node scripts/install-plugin.mjs --uninstall
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadContext } from '../src/context.js';
import { runChecks, summarize } from '../src/checks.js';
import { readJson, resolveDshBin, resolveHome, resolveProfileDir } from '../src/paths.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_NAME = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name;
const BACKUP_DIR_NAME = '.dsh-doctor';

/* ------------------------------------------------------------------ argv */

function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      flags._.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split(/=(.*)/s);
    if (inline !== undefined) flags[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
    else flags[key] = true;
  }
  return flags;
}

const flags = parseFlags(process.argv.slice(2));
const asJson = flags.json === true;
const say = (...args) => {
  if (!asJson) console.log(...args);
};

/* --------------------------------------------------------- the guard rails */

/** DSH Desktop must be closed: the market rewrites dsh.profile.bundles on boot. */
function dshIsRunning() {
  if (process.platform !== 'win32') {
    const ps = spawnSync('ps', ['-A', '-o', 'comm='], { encoding: 'utf8' });
    return ps.status === 0 && /dsh-desktop|DSH Desktop/i.test(ps.stdout ?? '');
  }
  const list = spawnSync('tasklist', ['/FI', 'IMAGENAME eq DSH Desktop.exe', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return /DSH Desktop\.exe/i.test(list.stdout ?? '');
}

function fail(message, hint) {
  if (asJson) {
    console.log(JSON.stringify({ ok: false, reason: message, hint: hint ?? null }, null, 2));
  } else {
    console.error(`\n  cannot install: ${message}`);
    if (hint) console.error(`  ${hint}`);
    console.error('');
  }
  process.exit(2);
}

/* ------------------------------------------------- compose the tree for real */

function captureDump(home, profile, dshBin, scratch) {
  mkdirSync(scratch, { recursive: true });
  const out = join(scratch, `dump-${profile}.txt`);
  const err = join(scratch, `dump-${profile}.err.txt`);
  const result = spawnSync(
    process.execPath,
    ['--expose-internals', dshBin, '--profile', profile, '--dump-config'],
    {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
      windowsHide: true,
      // Without this, `--home X` would compose the tree for one DSH home and
      // then analyse the layer files of another — the exact mismatch this tool
      // reports in other people's profiles.
      env: { ...process.env, DSH_HOME: home },
    },
  );
  if (result.error) throw new Error(`could not run dsh: ${result.error.message}`);
  writeFileSync(out, result.stdout ?? Buffer.alloc(0));
  writeFileSync(err, result.stderr ?? Buffer.alloc(0));
  return { dump: out, dumpStderr: err };
}

function analyse(home, profile, dshBin, scratch) {
  const captured = captureDump(home, profile, dshBin, scratch);
  const ctx = loadContext({ home, profile, dshBin, dump: captured.dump, dumpStderr: captured.dumpStderr });
  const findings = runChecks(ctx);
  return { ctx, findings, counts: summarize(findings) };
}

/** Does the composed tree contain an enabled entry for this package? */
function pluginState(ctx) {
  const entries = ctx.dump.entries.filter(
    (e) => e.id === PACKAGE_NAME || e.name === PACKAGE_NAME || e.ownerInfo?.name === PACKAGE_NAME,
  );
  if (entries.length === 0) return { present: false, enabled: false, entries: [] };
  return {
    present: true,
    enabled: entries.some((e) => e.disabled !== true),
    entries: entries.map((e) => ({ id: e.id, name: e.name, disabled: e.disabled === true })),
  };
}

/* --------------------------------------------------------------- backups */

function scratchDir(profileDir) {
  return join(profileDir, BACKUP_DIR_NAME);
}

function newestBackup(profileDir) {
  const dir = scratchDir(profileDir);
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir)
    .filter((name) => name.startsWith('backup-'))
    .sort()
    .reverse();
  return names.length ? join(dir, names[0]) : null;
}

function backup(profileDir, files) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(scratchDir(profileDir), `backup-${stamp}`);
  mkdirSync(dir, { recursive: true });
  for (const file of files) {
    if (existsSync(file)) copyFileSync(file, join(dir, file.split(/[\\/]/).pop()));
  }
  return dir;
}

/* ------------------------------------------------------------------ links */

function linkKind(path) {
  try {
    return lstatSync(path).isSymbolicLink() ? 'link' : 'directory';
  } catch {
    return 'missing';
  }
}

function rollback(profileDir, backupDir, linkPath, createdLink) {
  const restored = [];
  if (backupDir && existsSync(backupDir)) {
    for (const name of readdirSync(backupDir)) {
      const target = join(profileDir, name);
      copyFileSync(join(backupDir, name), target);
      restored.push(name);
    }
  }
  if (createdLink && existsSync(linkPath)) {
    rmSync(linkPath, { recursive: true, force: true });
  }
  return restored;
}

/* ------------------------------------------------------------------- main */

async function install() {
  const homeInfo = resolveHome(flags.home);
  const home = homeInfo.home;
  const profile = typeof flags.profile === 'string' ? flags.profile : 'web';
  const profileDir = resolveProfileDir(home, profile);
  const scratch = join(ROOT, BACKUP_DIR_NAME);
  const dryRun = flags['dry-run'] === true;
  const force = flags.force === true;

  if (!existsSync(profileDir)) fail(`no such profile: ${profileDir}`, 'pass --profile <name>');

  const binInfo = resolveDshBin(typeof flags['dsh-bin'] === 'string' ? flags['dsh-bin'] : undefined, home);
  if (!binInfo.bin) fail('could not locate the DSH harness entry point', 'pass --dsh-bin <path>');

  const manifestFile = join(profileDir, 'package.json');
  const patchFile = join(profileDir, 'cordis.patch.yml');
  // Through readJson, not JSON.parse: a profile manifest written by PowerShell
  // carries a UTF-8 BOM, and a bare JSON.parse throws on it.
  const manifestRead = readJson(manifestFile);
  if (!manifestRead.ok) fail(`cannot read ${manifestFile}: ${manifestRead.error}`);
  const manifestInfo = manifestRead.value;
  const bundles = manifestInfo?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) fail(`${manifestFile} has no dsh.profile.bundles array`);

  const linkPath = join(profileDir, 'node_modules', PACKAGE_NAME);
  const kind = linkKind(linkPath);

  // Refuse to write while DSH runs: the market rewrites this exact array on boot.
  if (dshIsRunning() && !dryRun) {
    fail(
      'DSH Desktop is running',
      'quit it completely first (the market rewrites dsh.profile.bundles on boot and would race this edit)',
    );
  }

  if (kind === 'directory') {
    fail(
      `${linkPath} is a real directory, not a link`,
      'that is the D006 condition this tool reports; remove it before installing',
    );
  }

  const alreadyListed = bundles.includes(PACKAGE_NAME);
  say(`profile    ${profileDir}`);
  say(`package    ${PACKAGE_NAME}  ->  ${ROOT}`);
  say(`bundles    ${alreadyListed ? 'already listed' : 'will be added'}`);
  say(`link       ${kind === 'link' ? 'already present' : 'will be created'}`);
  say(`harness    ${binInfo.bin}`);
  say('');

  /* 1. pre-flight: never stack a change onto a tree that is already broken ---- */

  say('pre-flight  composing the current tree ...');
  let before;
  try {
    before = analyse(home, profile, binInfo.bin, scratch);
  } catch (error) {
    fail(`the current tree does not compose: ${error.message}`);
  }

  const existing = pluginState(before.ctx);
  say(
    `            ${before.ctx.dump.entries.length} entries, ` +
      `${before.counts.error} error / ${before.counts.warn} warn`,
  );

  if (existing.present && existing.enabled && alreadyListed) {
    say(`\n  ${PACKAGE_NAME} is already installed and composed.`);
    say(`  Nothing to do — restart DSH to pick up any new code.\n`);
    if (asJson) console.log(JSON.stringify({ ok: true, changed: false, profile, plugin: existing }, null, 2));
    process.exit(0);
  }

  // Pre-existing errors are always shown, whether or not they get overridden:
  // an override you cannot see is indistinguishable from having no gate at all.
  const existingErrors = before.findings.filter((f) => f.severity === 'error');
  if (existingErrors.length > 0) {
    say('');
    for (const finding of existingErrors) {
      const at = finding.file ? `  ${finding.file}${finding.line ? `:${finding.line}` : ''}` : '';
      say(`  [error] ${finding.code}  ${finding.title}${at}`);
    }
  }

  if (existingErrors.length > 0 && force) {
    say('');
    say(`  --force: continuing despite ${existingErrors.length} pre-existing error(s) above.`);
    say('  If something breaks after this install, those are the prime suspects —');
    say('  run `node bin/dsh-plugin-doctor.js check` and compare.');
  }

  if (existingErrors.length > 0 && !force) {
    const errors = existingErrors;
    const reason = `this profile already reports ${existingErrors.length} error(s)`;
    if (!dryRun) {
      fail(
        reason,
        'fix them first — installing onto a broken tree means you will not know which change broke it.\n' +
          '  override deliberately with --force',
      );
    }
    // A dry run does not impersonate a refusal: it reports the verdict this
    // install would get, so it stays usable as a pre-flight gate in CI.
    if (asJson) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            dryRun: true,
            profile,
            wouldRefuse: true,
            reason,
            errors: errors.map((f) => ({
              code: f.code,
              title: f.title,
              file: f.file ?? null,
              line: f.line ?? null,
            })),
          },
          null,
          2,
        ),
      );
    } else {
      console.log(`\n  --dry-run: this install WOULD BE REFUSED. ${reason}.`);
      console.log('  Fix them first, or pass --force to override deliberately.\n');
    }
    process.exit(2);
  }

  if (dryRun) {
    say('\n  --dry-run: no files were written.\n');
    if (asJson) console.log(JSON.stringify({ ok: true, dryRun: true, profile, wouldAdd: !alreadyListed }, null, 2));
    process.exit(0);
  }

  /* 2. back up, then write -------------------------------------------------- */

  const backupDir = backup(profileDir, [manifestFile, patchFile]);
  say(`backup      ${backupDir}`);

  let createdLink = false;
  if (kind !== 'link') {
    mkdirSync(join(profileDir, 'node_modules'), { recursive: true });
    try {
      // 'junction' is the only link type Windows allows without elevation.
      symlinkSync(ROOT, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      createdLink = true;
      say(`link        created ${linkPath}`);
    } catch (error) {
      rollback(profileDir, backupDir, linkPath, false);
      fail(`could not create the link: ${error.message}`);
    }
  }

  if (!alreadyListed) {
    manifestInfo.dsh.profile.bundles = [...bundles, PACKAGE_NAME];
    writeFileSync(manifestFile, `${JSON.stringify(manifestInfo, null, 2)}\n`);
    say(`bundles     added ${PACKAGE_NAME}`);
  }

  /* 3. verify by composing, and undo everything if the plugin is not there --- */

  say('\nverify      composing the tree again ...');
  let after;
  try {
    after = analyse(home, profile, binInfo.bin, scratch);
  } catch (error) {
    const restored = rollback(profileDir, backupDir, linkPath, createdLink);
    fail(`the tree no longer composes: ${error.message}`, `rolled back ${restored.join(', ')}`);
  }

  const state = pluginState(after.ctx);
  say(
    `            ${after.ctx.dump.entries.length} entries, ` +
      `${after.counts.error} error / ${after.counts.warn} warn`,
  );

  if (!state.present) {
    const restored = rollback(profileDir, backupDir, linkPath, createdLink);
    fail(
      'the tree composed, but the plugin did not appear in it',
      `rolled back: ${restored.join(', ')} — report this, it is a bug in DSH or in this installer`,
    );
  }
  if (!state.enabled) {
    const restored = rollback(profileDir, backupDir, linkPath, createdLink);
    fail(
      'the plugin composed but is disabled',
      `another layer is switching it off; rolled back: ${restored.join(', ')}. ` +
        'Run `dsh-plugin-doctor check` to see which layer.',
    );
  }

  // A rising error count is not automatically fatal (the profile may have had
  // unrelated drift), but it must never pass silently.
  const newErrors = after.counts.error - before.counts.error;
  if (newErrors > 0) {
    say(`\n  note: error count rose by ${newErrors} — run \`dsh-plugin-doctor check\` before restarting.`);
    for (const finding of after.findings.filter((f) => f.severity === 'error')) {
      say(`        [error] ${finding.code}  ${finding.title}`);
    }
  }

  say(`\n  installed. ${PACKAGE_NAME} now composes as:`);
  for (const entry of state.entries) say(`    ${entry.id}${entry.disabled ? '  (disabled)' : '  (on)'}`);

  if (asJson) {
    console.log(
      JSON.stringify(
        { ok: true, changed: true, profile, backup: backupDir, plugin: state, counts: after.counts },
        null,
        2,
      ),
    );
  } else {
    console.log('\n  Next: fully quit DSH Desktop and reopen it.');
    console.log('        The 诊断 button appears in the sidebar footer.');
    console.log(`        Undo with: node scripts/install-plugin.mjs --uninstall\n`);
  }
}

function uninstall() {
  const homeInfo = resolveHome(flags.home);
  const profile = typeof flags.profile === 'string' ? flags.profile : 'web';
  const profileDir = resolveProfileDir(homeInfo.home, profile);

  if (!existsSync(profileDir)) fail(`no such profile: ${profileDir}`);
  if (dshIsRunning() && flags['dry-run'] !== true) fail('DSH Desktop is running', 'quit it completely first');

  const manifestFile = join(profileDir, 'package.json');
  const linkPath = join(profileDir, 'node_modules', PACKAGE_NAME);
  const removed = [];

  const manifestRead = readJson(manifestFile);
  if (!manifestRead.ok) fail(`cannot read ${manifestFile}: ${manifestRead.error}`);
  const manifest = manifestRead.value;
  const bundles = manifest?.dsh?.profile?.bundles;
  if (Array.isArray(bundles) && bundles.includes(PACKAGE_NAME)) {
    manifest.dsh.profile.bundles = bundles.filter((name) => name !== PACKAGE_NAME);
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    removed.push(`bundles entry`);
  }
  if (existsSync(linkPath)) {
    // Only ever remove a LINK. A real directory at this path means someone
    // materialised the package — the D006 condition this tool reports. Deleting
    // it recursively would destroy data this script did not create and cannot
    // restore, so it refuses and says so instead.
    if (lstatSync(linkPath).isSymbolicLink()) {
      rmSync(linkPath, { recursive: true, force: true });
      removed.push('node_modules link');
    } else {
      say(`  refusing to remove ${linkPath}:`);
      say('    it is a real directory, not a link. It may hold work of yours;');
      say('    delete it yourself if that is really what you want.');
    }
  }

  if (removed.length === 0) {
    say(`  ${PACKAGE_NAME} was not installed in ${profileDir}.`);
  } else {
    say(`  removed: ${removed.join(', ')}`);
    say('  the profile package.json and cordis.patch.yml were not otherwise touched;');
    say('  restore a backup from .dsh-doctor/ if you want the exact prior bytes.');
  }
  say('\n  Restart DSH Desktop for the removal to take effect.\n');
  if (asJson) console.log(JSON.stringify({ ok: true, profile, removed }, null, 2));
}

try {
  if (flags.uninstall === true) uninstall();
  else await install();
} catch (error) {
  if (error.code === 'ENODUMP' || error.code === 'EMPTYDUMP' || error.code === 'EBADHOME') {
    fail(error.message);
  }
  throw error;
}
