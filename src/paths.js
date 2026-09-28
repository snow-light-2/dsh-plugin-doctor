import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, platform } from 'node:os';

/**
 * Decode a text buffer, honouring the BOMs a Windows shell may have written.
 * Captured logs routinely arrive as UTF-16LE when PowerShell produced them,
 * and every byte of that looks like NUL-interleaved garbage under utf8.
 */
export function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    if (swapped.length % 2 === 1) return buffer.toString('utf8');
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

export function readText(file) {
  try {
    return { ok: true, value: decodeText(readFileSync(file)) };
  } catch (error) {
    return { ok: false, error: error.code === 'ENOENT' ? 'missing' : error.message };
  }
}

/** Tolerant JSON read: BOM-stripping, never throws. */
export function readJson(file) {
  const text = readText(file);
  if (!text.ok) return text;
  try {
    return { ok: true, value: JSON.parse(text.value) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

const DESKTOP_DIR = 'dsh-desktop';

function appDataRoot() {
  if (process.env.APPDATA) return process.env.APPDATA;
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support');
  if (platform() === 'win32') return join(homedir(), 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
}

/**
 * Every DSH home this tool is willing to look at, most specific first.
 * `%APPDATA%\dsh-desktop\harness` is what DSH Desktop injects as DSH_HOME;
 * `~/.dsh` is the standalone CLI default.
 */
export function candidateHomes() {
  const list = [];
  if (process.env.DSH_HOME) list.push(resolve(process.env.DSH_HOME));
  list.push(join(appDataRoot(), DESKTOP_DIR, 'harness'));
  list.push(join(homedir(), '.dsh'));
  return [...new Set(list)];
}

export function resolveHome(explicit) {
  if (explicit) {
    const dir = resolve(explicit);
    return { home: dir, exists: existsSync(dir), source: 'argument' };
  }
  for (const dir of candidateHomes()) {
    if (existsSync(join(dir, 'profiles'))) return { home: dir, exists: true, source: 'detected' };
  }
  const [first] = candidateHomes();
  return { home: first, exists: false, source: 'fallback' };
}

export function resolveProfileDir(home, profile = 'web') {
  return join(home, 'profiles', profile);
}

const BIN_SUFFIX = join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

/** Install layouts worth probing, relative to a plausible install root. */
function binCandidates() {
  const out = [];
  if (process.env.DSH_BIN) out.push(resolve(process.env.DSH_BIN));
  const roots = [];
  if (process.env.DSH_APP_DIR) roots.push(resolve(process.env.DSH_APP_DIR));
  const local = process.env.LOCALAPPDATA;
  if (local) {
    roots.push(join(local, 'Programs', DESKTOP_DIR, 'resources', 'app'));
    roots.push(join(local, DESKTOP_DIR, 'resources', 'app'));
  }
  if (process.env.ProgramFiles) roots.push(join(process.env.ProgramFiles, 'DSH Desktop', 'resources', 'app'));
  // A standalone `dsh` install keeps the package next to its own bin.
  roots.push(join(homedir(), '.dsh', 'app'));
  for (const root of roots) out.push(join(root, BIN_SUFFIX));
  return out;
}

/**
 * DSH Desktop logs the absolute path of the harness entry it loads, which is
 * the only reliable way to find a custom install directory: Electron records
 * nothing about its own location on disk.
 */
export function logsDir(home) {
  return join(home, '..', 'logs');
}

/** Log files under the DSH user-data directory, newest first. */
export function logFiles(home) {
  const files = [];
  for (const dir of [logsDir(home), join(home, 'logs')]) {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/\.log$/i.test(name)) continue;
      const file = join(dir, name);
      try {
        files.push({ file, mtime: statSync(file).mtimeMs });
      } catch {
        /* unreadable, skip */
      }
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime).map((entry) => entry.file);
}

const LOADED_RE = /loading=(.+?[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js)/g;

/**
 * Every harness entry point the logs have ever recorded.
 *
 * A log accumulates across installations and upgrades, and one file can
 * interleave several install paths, so "the one in use" is the path with the
 * greatest last-seen position -- not the first line, and not the newest file.
 */
export function loggedInstalls(home) {
  const byPath = new Map();
  let cursor = 0;
  for (const file of logFiles(home)) {
    const text = readText(file);
    if (!text.ok) continue;
    for (const match of text.value.matchAll(LOADED_RE)) {
      cursor++;
      const bin = match[1];
      const seen = byPath.get(bin);
      byPath.set(bin, {
        bin,
        exists: existsSync(bin),
        source: file,
        firstIndex: seen ? seen.firstIndex : cursor,
        lastIndex: cursor,
      });
    }
  }
  return [...byPath.values()];
}

export function detectFromLogs(home) {
  const installs = loggedInstalls(home);
  const ranked = [...installs].sort((a, b) => b.lastIndex - a.lastIndex);
  for (const item of ranked) {
    if (item.exists) return { bin: item.bin, source: `log ${item.source}` };
  }
  for (const file of logFiles(home).slice(0, 4)) {
    const text = readText(file);
    if (!text.ok) continue;
    const patched = /\[desktop\]\s+patch\s+(.+?)[\\/]resources[\\/]dsh-desktop\.patch\.yml/.exec(text.value);
    if (patched) {
      const candidate = join(patched[1], 'resources', 'app', BIN_SUFFIX);
      if (existsSync(candidate)) return { bin: candidate, source: `log ${file}` };
    }
  }
  return null;
}

/** Optional per-machine pin: `.dsh-doctor.json` in the DSH home or the cwd. */
export function readDoctorConfig(home) {
  const candidates = [];
  if (home) candidates.push(join(home, '.dsh-doctor.json'));
  candidates.push(join(process.cwd(), '.dsh-doctor.json'));
  for (const file of candidates) {
    const parsed = readJson(file);
    if (parsed.ok && parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)) {
      return { ...parsed.value, file };
    }
  }
  return null;
}

export function resolveDshBin(explicit, home) {
  if (explicit) {
    const file = resolve(explicit);
    return { bin: file, exists: existsSync(file), source: 'argument' };
  }
  if (process.env.DSH_BIN) {
    const file = resolve(process.env.DSH_BIN);
    return { bin: file, exists: existsSync(file), source: 'DSH_BIN' };
  }

  const config = readDoctorConfig(home);
  if (typeof config?.dshBin === 'string') {
    const file = resolve(config.dshBin);
    if (existsSync(file)) return { bin: file, exists: true, source: config.file };
  }

  if (home && existsSync(home)) {
    const fromLog = detectFromLogs(home);
    if (fromLog) return { bin: fromLog.bin, exists: true, source: fromLog.source };
  }

  for (const file of binCandidates()) {
    if (existsSync(file)) return { bin: file, exists: true, source: 'detected' };
  }
  return { bin: null, exists: false, source: 'missing' };
}

/** Where a user should look, and what to pass, when detection fails. */
export function dshBinHelp(home) {
  const lines = [];
  if (home) lines.push(`  looked for logs in ${logsDir(home)}`);
  lines.push('  pass --dsh-bin <path to @deepseek-ai/dsh/lib/bin.js>');
  lines.push('  or set DSH_BIN, or add {"dshBin":"..."} to .dsh-doctor.json in the DSH home');
  return lines.join('\n');
}

/** The `resources/app` directory that owns a harness `lib/bin.js`. */
export function appDirFromBin(bin) {
  if (!bin) return null;
  // <app>/node_modules/@deepseek-ai/dsh/lib/bin.js
  return resolve(bin, '..', '..', '..', '..', '..');
}

export function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
