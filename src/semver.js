/**
 * A deliberately small semver subset: just enough to answer
 * "does this plugin's `dsh.engines.dsh` range accept the installed harness?".
 *
 * Supported: `||` alternatives, whitespace-separated comparators, the operators
 * `>= > <= < = ^ ~`, and `*`/`x` wildcards. Prerelease ordering follows
 * semver 2.0.0 (a prerelease sorts before its release).
 *
 * Unsupported constructs make `satisfies` return `undefined` ("unknown")
 * rather than a wrong `false`, so callers can report honestly instead of
 * inventing a mismatch.
 */

const CORE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(raw) {
  const m = CORE.exec(String(raw ?? '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +(m[2] ?? 0), patch: +(m[3] ?? 0), prerelease: m[4] ? m[4].split('.') : [] };
}

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (+x !== +y) return +x < +y ? -1 : 1;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (va[key] !== vb[key]) return va[key] < vb[key] ? -1 : 1;
  }
  return comparePrerelease(va.prerelease, vb.prerelease);
}

/** Compare `candidate` against one range comparator. `null` means "unsupported". */
function cmp(candidate, op, target) {
  if (op === '^' || op === '~') {
    const base = parseVersion(target);
    if (!base) return null;
    const lower = `${base.major}.${base.minor}.${base.patch}`;
    const upper =
      op === '^'
        ? base.major > 0
          ? `${base.major + 1}.0.0`
          : base.minor > 0
            ? `0.${base.minor + 1}.0`
            : `0.0.${base.patch + 1}`
        : `${base.major}.${base.minor + 1}.0`;
    const lo = compareVersions(candidate, lower);
    const hi = compareVersions(candidate, upper);
    if (lo === null || hi === null) return null;
    return lo >= 0 && hi < 0;
  }

  const c = compareVersions(candidate, target);
  if (c === null) return null;
  switch (op) {
    case '>=': return c >= 0;
    case '>': return c > 0;
    case '<=': return c <= 0;
    case '<': return c < 0;
    case '=':
    case '': return c === 0;
    default: return null;
  }
}

/** @returns {boolean|undefined} true/false, or undefined when the range is unsupported. */
export function satisfies(version, range) {
  const text = String(range ?? '').trim();
  if (text === '' || text === '*' || text === 'x' || text === 'latest') return true;
  const parts = text.split('||').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return true;

  for (const clause of parts) {
    let ok = true;
    for (const token of clause.split(/\s+/)) {
      if (token === '') continue;
      const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(token);
      if (!m) return undefined;
      const op = m[1] ?? '';
      const ver = m[2].trim();
      if (/^[xX*]$/.test(ver)) continue;
      const result = cmp(version, op === '' ? '=' : op, ver);
      if (result === null) return undefined;
      if (!result) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}
