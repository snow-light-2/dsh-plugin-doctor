import { existsSync, readdirSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';

import { parseDump, parsePatch, parseDumpWarnings, enablement, isOn } from './parse.js';
import {
  resolveHome,
  resolveProfileDir,
  resolveDshBin,
  appDirFromBin,
  readJson,
  readText,
  loggedInstalls,
} from './paths.js';

const SHARED_TREE_KEEP = new Set(['dshmarket', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);

/**
 * How a directory is materialised.
 *   'link' -- a symlink or an NTFS junction; required for generation switching
 *   'dir'  -- a real directory (pnpm may do this for local `file:` installs)
 *   'missing' -- the link exists but its target does not
 */
export function linkKind(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return { kind: 'absent', target: null, real: null };
  }
  if (stat.isSymbolicLink()) {
    let target = null;
    try {
      target = readlinkSync(path);
    } catch {
      target = null;
    }
    let real = null;
    try {
      real = realpathSync(path);
    } catch {
      return { kind: 'missing', target, real: null };
    }
    return { kind: 'link', target, real };
  }
  if (stat.isDirectory()) return { kind: 'dir', target: null, real: path };
  return { kind: 'other', target: null, real: path };
}

function packageDirs(nodeModulesDir) {
  const out = [];
  let top;
  try {
    top = readdirSync(nodeModulesDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dirent of top) {
    if (dirent.name.startsWith('.')) continue;
    if (dirent.name.startsWith('@')) {
      const scopeDir = join(nodeModulesDir, dirent.name);
      let scoped;
      try {
        scoped = readdirSync(scopeDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const inner of scoped) out.push({ name: `${dirent.name}/${inner.name}`, dir: join(scopeDir, inner.name) });
      continue;
    }
    out.push({ name: dirent.name, dir: join(nodeModulesDir, dirent.name) });
  }
  return out;
}

/** Read every package installed in a node_modules directory, with its link kind. */
export function listInstalled(nodeModulesDir) {
  const list = [];
  for (const { name, dir } of packageDirs(nodeModulesDir)) {
    const link = linkKind(dir);
    const manifest = readJson(join(dir, 'package.json'));
    list.push({
      name,
      dir,
      link,
      manifest: manifest.ok ? manifest.value : null,
      manifestError: manifest.ok ? null : manifest.error,
      version: manifest.ok && typeof manifest.value.version === 'string' ? manifest.value.version : null,
      dsh: manifest.ok && manifest.value.dsh && typeof manifest.value.dsh === 'object' ? manifest.value.dsh : null,
    });
  }
  return list;
}

/** `main`, or the `.` export, or the two conventional fallbacks. */
export function entryFile(pkgDir, manifest) {
  const candidates = [];
  const exp = manifest?.exports;
  if (typeof exp === 'string') candidates.push(exp);
  else if (exp && typeof exp === 'object') {
    const dot = exp['.'];
    if (typeof dot === 'string') candidates.push(dot);
    else if (dot && typeof dot === 'object') {
      for (const key of ['default', 'import', 'require']) {
        if (typeof dot[key] === 'string') { candidates.push(dot[key]); break; }
      }
    }
  }
  if (typeof manifest?.main === 'string' && manifest.main !== '') candidates.push(manifest.main);
  candidates.push('lib/index.js', 'index.js', 'dist/index.js');
  for (const candidate of candidates) {
    const file = resolve(pkgDir, candidate);
    if (existsSync(file)) return file;
  }
  return null;
}

function packageRootOf(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Does `spec` resolve from any of these node_modules roots? */
export function resolvesFrom(spec, roots) {
  const root = packageRootOf(spec);
  for (const base of roots) {
    if (!base) continue;
    if (existsSync(join(base, root, 'package.json'))) return true;
    if (existsSync(join(base, root))) return true;
  }
  return false;
}

export function relativeTo(from, to) {
  if (!from || !to) return to ?? from ?? '';
  const rel = join(from, '..');
  return to.startsWith(rel) ? to.slice(rel.length).replace(/^[\\/]/, '') : to;
}

/**
 * Assemble everything the checks need. Read-only: this function never writes.
 */
export function loadContext(options = {}) {
  const profile = options.profile ?? 'web';
  const homeInfo = resolveHome(options.home);
  const home = homeInfo.home;
  const profileDir = resolveProfileDir(home, profile);

  const dumpInfo = readText(options.dump);
  if (!dumpInfo.ok) {
    const error = new Error(
      options.dump
        ? `cannot read dump file: ${options.dump} (${dumpInfo.error})`
        : 'no dump supplied; run `dsh-plugin-doctor capture` first or pass --dump <file>',
    );
    error.code = 'ENODUMP';
    throw error;
  }

  const dump = parseDump(dumpInfo.value);
  const warningsText = options.dumpStderr ? readText(options.dumpStderr) : { ok: false };
  const warnings = warningsText.ok ? parseDumpWarnings(warningsText.value) : [];

  const patchFile = options.patch ?? join(profileDir, 'cordis.patch.yml');
  const patchText = readText(patchFile);
  const patch = patchText.ok ? parsePatch(patchText.value, patchFile) : { entries: [] };

  const manifestInfo = readJson(join(profileDir, 'package.json'));
  const manifest = manifestInfo.ok ? manifestInfo.value : null;
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
  const dependencies = manifest?.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {};

  const marketInfo = readJson(join(profileDir, '.dsh-market', 'state.json'));
  const market = marketInfo.ok ? marketInfo.value : null;

  const nodeModulesDir = join(profileDir, 'node_modules');
  const installed = listInstalled(nodeModulesDir);
  const installedByName = new Map(installed.map((pkg) => [pkg.name, pkg]));

  const binInfo = resolveDshBin(options.dshBin, home);
  const appDir = options.app ?? appDirFromBin(binInfo.bin);
  const appNodeModules = appDir ? join(appDir, 'node_modules') : null;
  const installs = existsSync(home) ? loggedInstalls(home) : [];

  // Which package each entry actually loads, straight from the composed tree:
  // the only trustworthy answer when several copies exist on disk.
  const loadedDirs = new Map();
  for (const entry of dump.entries) {
    const info = entry.ownerInfo;
    if (!info?.name) continue;
    const known = loadedDirs.get(info.name);
    if (!known || !known.dir) loadedDirs.set(info.name, { dir: info.dir ?? null, version: info.version ?? null });
  }

  // Layer 1: each bundle's own patch, which the profile patch may later override.
  const bundlePatches = new Map();
  for (const bundle of bundles) {
    const pkg = installedByName.get(bundle);
    const dir = pkg?.dir ?? (appNodeModules ? join(appNodeModules, bundle) : null);
    const patchRel = pkg?.dsh?.bundle?.patch;
    if (!dir || !patchRel) continue;
    const file = resolve(dir, patchRel);
    const text = readText(file);
    if (!text.ok) continue;
    bundlePatches.set(bundle, { bundle, file, entries: parsePatch(text.value, file).entries });
  }

  const recoveryInfo = readJson(join(home, 'recovery', 'plugin-removals.json'));
  const recovery = recoveryInfo.ok ? recoveryInfo.value : null;

  // The harness family version is the only version the composed tree exposes
  // offline; fall back to the app manifest when a dump is not available.
  let hostVersion = null;
  const base = loadedDirs.get('@deepseek-ai/dsh-base');
  if (base?.version) hostVersion = base.version;
  if (!hostVersion && appDir) {
    const core = readJson(join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
    if (core.ok) hostVersion = core.value.version ?? null;
  }

  const enabled = dump.entries.filter((entry) => isOn(entry.disabled));
  const dynamic = dump.entries.filter((entry) => enablement(entry.disabled) === 'dynamic');

  return {
    options,
    home,
    homeInfo,
    profile,
    profileDir,
    nodeModulesDir,
    appDir,
    appNodeModules,
    bin: binInfo.bin,
    binSource: binInfo.source,
    loggedInstalls: installs,
    logSource: [...installs].sort((a, b) => b.lastIndex - a.lastIndex)[0]?.source ?? null,
    dumpPath: options.dump,
    dumpRaw: dumpInfo.value,
    dump: { entries: dump.entries, sections: dump.sections },
    dumpWarnings: warnings,
    patchFile: patchText.ok ? patchFile : null,
    patch: { path: patchText.ok ? patchFile : null, entries: patch.entries, error: patchText.ok ? null : patchText.error },
    manifest,
    manifestPath: join(profileDir, 'package.json'),
    bundles,
    dependencies,
    market,
    marketPath: join(profileDir, '.dsh-market', 'state.json'),
    installed,
    installedByName,
    loadedDirs,
    bundlePatches,
    recovery,
    recoveryPath: join(home, 'recovery', 'plugin-removals.json'),
    hostVersion,
    nodeVersion: process.version,
    enabled,
    dynamic,
    resolutionRoots: [nodeModulesDir, appNodeModules].filter(Boolean),
    sharedTreeKeep: SHARED_TREE_KEEP,
  };
}

export { isOn, enablement, isAbsolute };
