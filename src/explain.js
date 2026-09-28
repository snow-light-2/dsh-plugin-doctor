/**
 * `explain` turns a raw DSH log into a cause-and-remedy sentence.
 *
 * Every signature here was observed on a real machine; each one records what the
 * harness printed, what it actually means, and which `check` code covers it.
 * A signature may supply `describe(groups)` when the correct reading depends on
 * the captured values -- exit codes in particular must never be guessed at.
 */

/** Windows NTSTATUS codes the desktop reports when the harness process ends. */
const EXIT_CODES = {
  '3221226505': {
    hex: '0xC0000409',
    name: 'STATUS_STACK_BUFFER_OVERRUN',
    title: 'the harness died from a fail-fast abort',
    why: 'the runtime detected an unrecoverable error (this code is what V8 raises for an unhandled fatal exception) and terminated the process immediately.',
    fix: 'scroll up: the real cause is the last `DSH entry failed:` or `plugin tree failed` line printed before it.',
  },
  '1073807364': {
    hex: '0x40010004',
    name: 'STATUS_CONTROL_C_EXIT',
    title: 'the harness was terminated, not crashed',
    why: 'this code means a console control event ended the process: Ctrl+C, the console window closing, or the parent shutting the child down during a restart.',
    fix: 'nothing to fix if the desktop was restarting or closing at that moment; if not, check what closed the console.',
  },
  '1': {
    hex: '0x1',
    name: 'generic failure',
    title: 'the harness exited with a generic failure',
    why: 'the process reported failure without a specific status code.',
    fix: 'read the last few lines above it.',
  },
};

function describeExitCode(groups) {
  const known = EXIT_CODES[groups[0]];
  if (known) return { title: known.title, why: known.why, fix: known.fix };
  const hex = groups[1] ?? '';
  if (/^0xC0000/i.test(hex)) {
    return { title: 'the harness died from a fail-fast abort', why: 'an 0xC0000xxx status is a Windows fail-fast class abort.', fix: 'scroll up: the real cause is the last error line above it.' };
  }
  if (/^0x4001000/i.test(hex)) {
    return { title: 'the harness was terminated, not crashed', why: 'a 0x4001000x status is a console control event: an external shutdown rather than a fault.', fix: 'ignore it if the desktop was restarting at that moment.' };
  }
  return {
    title: 'the harness process exited with an unrecognised status',
    why: `status ${groups[0]}${hex ? ` (${hex})` : ''} is not a code this version recognises, so no cause is claimed.`,
    fix: 'search for the status code together with the last `DSH entry failed:` line.',
  };
}

export const SIGNATURES = [
  {
    id: 'tree-load-failed',
    // Greedy prefix so the *innermost* failing entry is attributed: a failure is
    // reported as `... entry include (cordis:include): ... entry X (pkg): <error>`.
    re: /plugin tree failed to load:.*failed to apply loader entry\s+(\S+)\s*\(([^)]+)\):\s*(.+)$/m,
    title: 'the plugin tree failed to load',
    why: 'the loader built the entry list, then one entry threw inside apply(). Every plugin that had not started yet is skipped, so the app looks half-built rather than broken.',
    fix: 'read the trailing error — it names the real conflict; then disable that entry in the profile patch.',
    code: null,
  },
  {
    id: 'singleton-registered',
    re: /session-title provider "([^"]+)" is already registered/,
    title: 'a singleton service was registered twice',
    why: 'session-title accepts exactly one provider. Two plugins (or a plugin plus its replacement of a stock one) both registered, which aborts the whole tree.',
    fix: 'keep exactly one session-title provider. A third-party bundle that patches out the stock one must be disabled as a whole.',
    code: 'D004',
  },
  {
    id: 'non-link-plugin',
    re: /Cannot switch a non-link plugin directory:\s*(\S+)/,
    title: 'a plugin directory is a real directory, not a link',
    why: 'generation switching moves plugins by repointing links. A materialised copy cannot be switched, so the upgrade aborts.',
    fix: 'delete the directory and reinstall the plugin so it lands as a junction into profiles\\.generations\\live\\.',
    code: 'D006',
  },
  {
    id: 'peer-closure',
    re: /generation peer validation failed:\s*(\S+)\s+does not resolve from the installation closure/,
    title: 'a plugin depends on something outside the profile install closure',
    why: 'the profile is installed as its own pnpm closure. A peer that only exists in the app tree is not reachable from it.',
    fix: 'pin the missing peer in the profile (pnpm overrides) or install a plugin build whose peers are declared dependencies.',
    code: 'D008',
  },
  {
    id: 'schema-drift',
    re: /([\w.$]+)\s+is not a function/,
    title: 'a plugin called an API the installed library no longer has',
    why: 'community plugins bundle their own copies of shared libraries (zod, cordis). When the host upgrades, a stale copy calls a method that was removed mid-chain.',
    fix: 'upgrade the offending plugin, or disable it; the crash is deterministic, so it will recur on every boot.',
    code: 'D008',
  },
  {
    id: 'safe-mode',
    re: /safe mode: third-party web profile bundles are blocked/,
    title: 'DSH Desktop entered safe mode',
    why: 'the desktop saw a failed boot and relaunched with the desktop-safe-mode profile, which loads only dsh-base and dsh-web-app so the UI stays reachable.',
    fix: 'fix the underlying conflict, then exit safe mode: DevTools/console `safe-mode:exit`, or quit the app completely and relaunch.',
    code: null,
  },
  {
    id: 'crash-code',
    re: /Harness process exited \(exit code ([0-9]+)\s*(?:\(([^)]+)\))?\)/,
    title: 'the harness process exited',
    why: 'the child process that hosts the plugin tree ended; the meaning depends entirely on the status code.',
    fix: 'check the status code and the lines above it.',
    describe: describeExitCode,
  },
  {
    id: 'engines-refused',
    re: /update-compat[^\n]*refused before installing/,
    title: 'a plugin install was refused on the engine gate',
    why: 'the market checks `dsh.engines.dsh` before installing; the plugin declares a harness range that excludes this one.',
    fix: 'do not force it. Ask the author to widen the range, or fork it and relax `dsh.engines.dsh` yourself.',
    code: 'D007',
  },
  {
    id: 'kept-off',
    re: /plugin kept off:\s*(\S+)/,
    title: 'a plugin was forced off at boot',
    why: 'the market persisted a `disabled` row and re-applies it on every boot. It also rewrites `dsh.profile.bundles`, so removing a bundle by hand does not stick.',
    fix: 'the durable override is `disabled: false` in the profile patch layer, which is applied last.',
    code: 'D005',
  },
  {
    id: 'recovery-pending',
    re: /profile package maintenance deferred while plugin removal is pending verification/,
    title: 'plugin removal is waiting for verification',
    why: 'the desktop will not touch the profile package tree until a previous removal has been proven to boot cleanly.',
    fix: 'restart DSH once with the plugin absent; the removal is marked verified and maintenance resumes.',
    code: 'D010',
  },
  {
    id: 'recovery-lock',
    re: /Profile recovery transaction is still incomplete/,
    title: 'a profile recovery transaction is holding the lock',
    why: 'a migration snapshot is mid-flight, so the normal profile stays blocked and safe mode cannot be exited.',
    fix: 'let the transaction finish (or roll back) before editing profile files.',
    code: null,
  },
  {
    id: 'patch-mismatch',
    // Console hosts hard-wrap long lines mid-token, so this one is matched
    // against a whitespace-free view of the log (see packedRe below).
    packedRe: /patch:namemismatchfor"([^"]*)"\(expected"([^"]*)",got"([^"]*)"\),skipping/,
    title: 'a patch entry was skipped',
    why: 'a patch entry declared a `name:` that disagrees with the bundle that defines the id. DSH drops the whole entry, so its `config:` never applies — silently.',
    fix: 'set `name:` to the value DSH expected, or delete the `name:` line.',
    code: 'D001',
  },
  {
    id: 'patch-orphan',
    packedRe: /patch:entry"([^"]*)"notfound/,
    title: 'a patch entry matched nothing',
    why: 'the id does not exist in the composed tree. Harmless when the entry only sets `disabled: true` (a guard), otherwise a typo.',
    fix: 'fix the id, or keep it deliberately as a guard against a plugin being reinstalled.',
    code: 'D002',
  },
  {
    id: 'slot-conflict',
    re: /slot "([^"]+)" is already (?:registered|claimed)/,
    title: 'two plugins claimed the same UI slot',
    why: 'the slot registry is keyed by name; a second registration for the same key rejects the plugin.',
    fix: 'disable one of the claimants; slot names must be inlined in `ctx.slots.register()` for the injector pre-flight to see them.',
    code: null,
  },
];

/**
 * A whitespace-free rendering of the log plus, for each packed character, the
 * line it came from. A console host can break a line inside any token, and a
 * patch id or package name never contains whitespace, so matching the packed
 * form repairs the wrapping exactly rather than heuristically.
 */
function buildPacked(lines) {
  const chars = [];
  const lineOf = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (/\s/.test(ch)) continue;
      chars.push(ch);
      lineOf.push(i + 1);
    }
  }
  return { packed: chars.join(''), lineOf };
}

/**
 * Group matches by signature so a log that repeats one problem a hundred times
 * still reads as one problem; the newest occurrence supplies the details.
 */
export function explainText(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const byId = new Map();
  const order = [];

  const record = (signature, lineNumber, groups, match) => {
    const described = typeof signature.describe === 'function' ? signature.describe(groups) : null;
    const existing = byId.get(signature.id);
    if (existing) {
      existing.occurrences += 1;
      existing.line = lineNumber;
      existing.match = match;
      existing.groups = groups;
      if (described) Object.assign(existing, described);
      else Object.assign(existing, { title: signature.title, why: signature.why, fix: signature.fix });
      return;
    }
    const hit = {
      id: signature.id,
      line: lineNumber,
      firstLine: lineNumber,
      occurrences: 1,
      title: signature.title,
      why: signature.why,
      fix: signature.fix,
      code: signature.code ?? null,
      match,
      groups,
    };
    if (described) Object.assign(hit, described);
    byId.set(signature.id, hit);
    order.push(hit);
  };

  let packedView = null;

  for (const signature of SIGNATURES) {
    if (signature.packedRe) {
      packedView ??= buildPacked(lines);
      const re = new RegExp(signature.packedRe.source, 'g');
      for (const m of packedView.packed.matchAll(re)) {
        const lineNumber = packedView.lineOf[m.index] ?? 1;
        const groups = m.slice(1).map((value) => String(value ?? '').replace(/\s+/g, ''));
        record(signature, lineNumber, groups, (lines[lineNumber - 1] ?? '').trim());
      }
      continue;
    }

    const re = signature.re;
    for (const [index, line] of lines.entries()) {
      const m = re.exec(line);
      if (!m) continue;
      record(signature, index + 1, m.slice(1).filter((value) => value !== undefined), m[0].trim());
    }
  }

  order.sort((a, b) => a.firstLine - b.firstLine);
  return { lines: lines.length, hits: order };
}

export { EXIT_CODES };
