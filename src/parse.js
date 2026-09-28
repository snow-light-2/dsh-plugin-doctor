/**
 * Line-oriented parsers for the two machine-generated formats doctor reads.
 *
 * We deliberately avoid a YAML dependency:
 *   - `dsh --profile <p> --dump-config` emits a fixed, machine-generated shape
 *   - `cordis.patch.yml` is a top-level patch array whose interesting keys are
 *     always at a known indent for a given entry
 *
 * Because both formats are generated/hand-written to a strict shape, an
 * indent-aware scan is both smaller and easier to audit than a full YAML
 * parser -- and it keeps the tool dependency-free, so it still runs when the
 * plugin tree is too broken to import anything.
 */

const SECTION_RE = /^# == (.*)$/;
const ID_RE = /^-\s*id:\s*(.+?)\s*$/;
const KEY_RE = /^([A-Za-z_$][\w$]*):\s*(.*)$/;
const PATCHED_BY = ', patched by ';

/** Strip surrounding single/double quotes and trailing inline comments. */
export function scalar(raw) {
  let value = String(raw ?? '').trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last) value = value.slice(1, -1);
  }
  return value;
}

/**
 * `disabled:` is either a literal boolean or a `!!js` expression that only the
 * harness can evaluate. We keep both, and never pretend to know the dynamic one.
 */
export function parseDisabled(raw) {
  const value = String(raw ?? '').trim();
  if (value === '') return { kind: 'bool', value: true };
  if (value === 'true') return { kind: 'bool', value: true };
  if (value === 'false') return { kind: 'bool', value: false };
  if (value.startsWith('!!js ') || value.startsWith('!!js\t')) {
    return { kind: 'js', expr: value.replace(/^!!js\s+/, '') };
  }
  return { kind: 'raw', value };
}

/**
 * Static enablement:
 *   'on'      certainly enabled
 *   'off'     certainly disabled
 *   'dynamic' decided at boot by a `!!js` expression -- callers must not assume
 */
export function enablement(disabled) {
  if (disabled === null || disabled === undefined) return 'on';
  if (disabled.kind === 'bool') return disabled.value ? 'off' : 'on';
  if (disabled.kind === 'js') return 'dynamic';
  return 'dynamic';
}

export const isOn = (disabled) => enablement(disabled) === 'on';
export const isOff = (disabled) => enablement(disabled) === 'off';

/**
 * Parse the composed loader tree produced by `dsh --dump-config`.
 *
 * Read at three indents only, which is what keeps nested content from being
 * mistaken for structure:
 *   - indent 0: a `- id:` entry header (and `# ==` section headers)
 *   - indent 2: the entry's own keys -- `name`, `disabled`, `__dshPluginOwner`
 *   - indent 4: keys *inside* `__dshPluginOwner`, i.e. which package owns this
 *     entry. Nothing deeper is interpreted, so `config.models[].id` and other
 *     nested ids can never become loader entries.
 */
export function parseDump(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const entries = [];
  const sections = [];
  let section = null;
  let entry = null;
  let mode = null;
  let folded = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    const line = i + 1;

    const mSection = SECTION_RE.exec(raw);
    if (mSection) {
      const label = mSection[1].trim();
      const at = label.indexOf(PATCHED_BY);
      // `patched by` is a comma-separated layer chain, and a layer is either a
      // bundle name (`@deepseek-ai/dsh-web-app`) or the profile patch file path.
      const patchedBy = at === -1 ? null : label.slice(at + PATCHED_BY.length).trim();
      section = {
        label,
        owner: at === -1 ? label : label.slice(0, at).trim(),
        patchedBy,
        patchedByList: patchedBy ? patchedBy.split(',').map((part) => part.trim()).filter(Boolean) : [],
        line,
      };
      sections.push(section);
      entry = null;
      mode = null;
      folded = null;
      continue;
    }

    const indent = raw.length - raw.trimStart().length;
    const body = raw.trim();

    if (indent === 0 && body.startsWith('- id:')) {
      const mId = ID_RE.exec(body);
      entry = {
        id: scalar(mId ? mId[1] : body.slice(5)),
        name: null,
        disabled: null,
        ownerInfo: null,
        line,
        section: section ? section.label : null,
        owner: section ? section.owner : null,
        patchedBy: section ? section.patchedBy : null,
        patchedByList: section ? section.patchedByList : [],
      };
      entries.push(entry);
      mode = null;
      folded = null;
      continue;
    }

    if (entry === null) continue;

    if (indent === 2) {
      const mKey = KEY_RE.exec(body);
      folded = null;
      if (!mKey) {
        mode = null;
        continue;
      }
      const [, key, value] = mKey;
      if (key === '__dshPluginOwner') {
        entry.ownerInfo = { name: null, dir: null, version: null };
        mode = 'owner';
        continue;
      }
      mode = null;
      if (key === 'name') entry.name = scalar(value);
      else if (key === 'disabled') entry.disabled = parseDisabled(value);
      continue;
    }

    if (mode !== 'owner') continue;

    if (folded !== null && indent >= 6) {
      entry.ownerInfo[folded] = scalar(body);
      folded = null;
      continue;
    }
    if (indent !== 4) continue;

    const mKey = KEY_RE.exec(body);
    if (!mKey) continue;
    const [, key, value] = mKey;
    const marker = value.trim();
    const isFolded = marker === '>-' || marker === '>' || marker === '|' || marker === '|-';
    if (key === 'packageName') entry.ownerInfo.name = scalar(value);
    else if (key === 'version') entry.ownerInfo.version = scalar(value);
    else if (key === 'packageDir') {
      if (isFolded) folded = 'dir';
      else entry.ownerInfo.dir = scalar(value);
    }
  }

  return { entries, sections };
}

/**
 * Parse a `cordis.patch.yml` patch array.
 *
 * Two entry shapes exist, distinguished by indent:
 *   - a top-level patch entry:  `- id:` at column 0, its keys at indent 2
 *   - an `insert:` child:       `insert:` at indent N, `- id:` at N+2, keys at N+4
 *
 * Nested `config:` lists (for example `config.models[].id`) sit deeper than
 * N+2 and are therefore never mistaken for inserted entries.
 */
export function parsePatch(text, filePath = null) {
  const lines = String(text ?? '').split(/\r?\n/);
  const entries = [];
  let current = null;
  let currentIsTop = false;
  let insertIndent = null;
  let insertOwner = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const stripped = raw.trim();
    if (stripped === '' || stripped.startsWith('#')) continue;

    const indent = raw.length - raw.trimStart().length;
    const isTop = indent === 0;
    const isInsertItem = insertIndent !== null && indent === insertIndent + 2;
    const mId = ID_RE.exec(stripped);

    if (mId && (isTop || isInsertItem)) {
      const parent = isInsertItem ? insertOwner : null;
      if (isTop) {
        insertIndent = null;
        insertOwner = null;
      }
      const created = {
        id: scalar(mId[1]),
        name: null,
        disabled: null,
        line: i + 1,
        insertedBy: parent ? parent.id : null,
        file: filePath,
      };
      if (parent) (parent.inserts ||= []).push(created);
      entries.push(created);
      current = created;
      currentIsTop = isTop;
      continue;
    }

    if (current === null) continue;
    const childIndent = currentIsTop ? 2 : insertIndent === null ? null : insertIndent + 4;
    if (childIndent === null || indent !== childIndent) continue;

    const mKey = KEY_RE.exec(stripped);
    if (!mKey) continue;
    const [, key, value] = mKey;
    if (key === 'insert' && isTop === false) {
      insertIndent = indent;
      insertOwner = current;
      continue;
    }
    if (key === 'name') current.name = scalar(value);
    else if (key === 'disabled') current.disabled = parseDisabled(value);
  }

  return { entries };
}

/** Strip PowerShell's error-record noise so a wrapped stderr can be flattened. */
export function denoiseStderr(stderr) {
  return String(stderr ?? '')
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      if (t === '') return false;
      if (t.startsWith('+')) return false;
      if (/^(所在位置|CategoryInfo|FullyQualifiedErrorId)\b/.test(t)) return false;
      if (/^node\.exe\s*:\s*$/.test(t)) return false;
      return true;
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Recover the patch diagnostics DSH prints while composing the tree.
 * They are advisory warnings on stderr, but each one silently voids a patch
 * entry -- which is precisely the kind of failure that is invisible at runtime.
 *
 * Console hosts hard-wrap long lines mid-token (`michengai-codex-ui` /
 * `-session-title`), so every literal phrase is matched with `\s*` between
 * words and every captured identifier is whitespace-stripped afterwards.
 * Patch ids and package names never contain whitespace, which makes the repair
 * exact rather than heuristic.
 */
const ident = (value) => String(value ?? '').replace(/\s+/g, '');

/** A patch file path may itself contain spaces, so recover it from the raw text. */
function recoverPath(strippedPath, flat) {
  if (!strippedPath) return null;
  const spans = [...flat.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);
  return spans.find((span) => span.replace(/\s+/g, '') === strippedPath) ?? strippedPath;
}

export function parseDumpWarnings(stderr) {
  const flat = denoiseStderr(stderr);
  // Match against a whitespace-free view: the console can break a line inside
  // any token, and a patch id or package name never contains whitespace.
  const packed = flat.replace(/\s+/g, '');
  const byKey = new Map();

  const push = (item) => {
    const key = `${item.code}:${item.id}`;
    if (!byKey.has(key)) byKey.set(key, item);
  };

  const mismatch = /dsh:\[([^\]]+)\]patch:namemismatchfor"([^"]*)"\(expected"([^"]*)",got"([^"]*)"\),skipping/g;
  for (let m = mismatch.exec(packed); m; m = mismatch.exec(packed)) {
    const id = ident(m[2]);
    const expected = ident(m[3]);
    const got = ident(m[4]);
    push({
      code: 'D001',
      severity: 'error',
      file: recoverPath(m[1], flat),
      id,
      expected,
      got,
      message: `patch entry "${id}" declares name "${got}" but the tree defines "${expected}" -- DSH skips the whole entry`,
    });
  }

  const orphan = /dsh:\[([^\]]+)\]patch:entry"([^"]*)"notfound/g;
  for (let m = orphan.exec(packed); m; m = orphan.exec(packed)) {
    const id = ident(m[2]);
    push({
      code: 'D002',
      severity: 'warn',
      file: recoverPath(m[1], flat),
      id,
      message: `patch entry "${id}" targets an id no bundle defines -- the entry is a no-op`,
    });
  }

  return [...byKey.values()];
}
