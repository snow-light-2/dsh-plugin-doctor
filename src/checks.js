import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { enablement, isOn, isOff } from './parse.js';
import { satisfies, compareVersions } from './semver.js';
import { resolvesFrom } from './context.js';
import { readJson } from './paths.js';

const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 };

const finding = (code, severity, title, message, extra = {}) => ({
  code,
  severity,
  title,
  message,
  where: extra.where ?? null,
  fix: extra.fix ?? null,
  key: extra.key ?? `${code}:${extra.where?.line ?? ''}:${message}`,
  ...extra,
});

/**
 * Singleton registries: services where a second registration is fatal rather
 * than merely redundant. Each entry documents the observable failure, because
 * the whole point of this tool is to turn a crash into a sentence.
 */
const SINGLETON_FAMILIES = [
  {
    id: 'session-title',
    // The service package `@deepseek-ai/dsh-session-title` owns the registry and
    // is expected to stay on; the contenders are the *provider* plugins, whose
    // package names all carry a `session-title` segment after the service name.
    match: (entry) => /session-title/.test(entry.name ?? '') && entry.name !== '@deepseek-ai/dsh-session-title',
    why:
      'the session-title service accepts exactly one provider; a second registration throws ' +
      '`session-title provider "<id>" is already registered` and the whole plugin tree fails to load',
  },
];

/* ------------------------------------------------------------------ D001 */
function checkPatchNameMismatch(ctx) {
  const byId = new Map();
  for (const entry of ctx.dump.entries) if (!byId.has(entry.id)) byId.set(entry.id, entry);
  const out = [];
  const seen = new Set();

  for (const entry of ctx.patch.entries) {
    if (entry.name === null) continue;
    const target = byId.get(entry.id);
    if (!target || !target.name) continue;
    if (target.name === entry.name) continue;
    const key = `D001:${entry.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(
      finding('D001', 'error', 'patch entry is silently skipped (name mismatch)', `patch entry "${entry.id}" declares name "${entry.name}", but the composed tree defines "${target.name}".`, {
        key,
        where: { file: entry.file ?? ctx.patch.path, line: entry.line },
        expected: target.name,
        got: entry.name,
        id: entry.id,
        fix: `set \`name: "${target.name}"\` on the \`- id: ${entry.id}\` entry (or drop the \`name:\` line entirely) — until then its \`config:\` block is never applied`,
      }),
    );
  }

  // DSH's own stderr diagnostics cover mismatch cases the static pass cannot see.
  for (const warning of ctx.dumpWarnings) {
    if (warning.code !== 'D001') continue;
    const key = `D001:${warning.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(
      finding('D001', 'error', 'patch entry is silently skipped (name mismatch)', warning.message, {
        key,
        where: { file: warning.file, line: null },
        id: warning.id,
        fix: `declare \`name: "${warning.expected}"\` for entry "${warning.id}"`,
      }),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ D002 */
function checkPatchOrphans(ctx) {
  const ids = new Set(ctx.dump.entries.map((entry) => entry.id));
  const out = [];
  const seen = new Set();

  const report = (id, file, line) => {
    const key = `D002:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    const entry = ctx.patch.entries.find((candidate) => candidate.id === id);
    const guardOnly = entry ? isOff(entry.disabled) : false;
    out.push(
      finding(
        'D002',
        guardOnly ? 'info' : 'warn',
        guardOnly ? 'defensive patch entry (no-op by design)' : 'patch entry targets a missing id',
        guardOnly
          ? `patch entry "${id}" only sets \`disabled: true\`, and no bundle defines that id right now. That is the correct way to pre-emptively block a plugin, so this is informational.`
          : `patch entry "${id}" targets an id that no bundle defines, so the entry does nothing at all.`,
        {
          key,
          where: { file, line },
          id,
          fix: guardOnly ? null : 'remove the entry, or fix the id if it is a typo',
        },
      ),
    );
  };

  for (const entry of ctx.patch.entries) if (!ids.has(entry.id)) report(entry.id, entry.file ?? ctx.patch.path, entry.line);
  for (const warning of ctx.dumpWarnings) if (warning.code === 'D002') report(warning.id, warning.file, null);
  return out;
}

/* ------------------------------------------------------------------ D003 */
function dirKey(dir) {
  return typeof dir === 'string' && dir !== '' ? resolve(dir).replace(/[\\/]+$/, '').toLowerCase() : null;
}

/**
 * One package legitimately contributes several entries with different config
 * (the host loads four agent presets from `@deepseek-ai/dsh-agent-preset`), so
 * a repeated package *name* is normal. What is not normal is the same package
 * name resolving to two different install directories.
 */
function checkDuplicatePackage(ctx) {
  const byName = new Map();
  for (const entry of ctx.enabled) {
    const name = entry.ownerInfo?.name;
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(entry);
  }

  const out = [];
  for (const [name, entries] of byName) {
    const dirs = new Map();
    for (const entry of entries) {
      const key = dirKey(entry.ownerInfo?.dir);
      if (key && !dirs.has(key)) dirs.set(key, entry);
    }
    if (dirs.size < 2) continue;

    const versions = [...new Set(entries.map((entry) => entry.ownerInfo?.version).filter(Boolean))];
    out.push(
      finding('D003', 'error', 'one package is loaded from two installs', `package "${name}" is enabled from ${dirs.size} different directories${versions.length > 1 ? ` at versions ${versions.join(', ')}` : ''}: ${entries.map((entry) => `"${entry.id}"`).join(', ')}.`, {
        key: `D003:${name}`,
        where: { file: ctx.patch.path, line: null },
        ids: entries.map((entry) => entry.id),
        dirs: [...dirs.keys()],
        fix: 'disable the entries that load from the copy you do not want; two installs of one package make upgrades look ineffective and can register the same service twice',
      }),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ D004 */
function checkSingletonFamilies(ctx) {
  const out = [];
  const families = [...SINGLETON_FAMILIES, ...(ctx.options.singletons ?? [])];
  for (const family of families) {
    const members = ctx.enabled.filter((entry) => (family.match ? family.match(entry) : family.ids?.includes(entry.id)));
    if (members.length < 2) continue;
    const stock = members.filter((entry) => /^@deepseek-ai\//.test(entry.owner ?? ''));
    const third = members.filter((entry) => !/^@deepseek-ai\//.test(entry.owner ?? ''));
    out.push(
      finding('D004', 'error', `singleton conflict: ${family.id}`, `${members.length} enabled entries compete for the "${family.id}" singleton: ${members.map((e) => `"${e.id}" (owner: ${e.owner ?? 'unknown'})`).join(', ')}.`, {
        key: `D004:${family.id}`,
        where: { file: ctx.patch.path, line: null },
        ids: members.map((e) => e.id),
        why: family.why,
        fix: stock.length && third.length
          ? `decide which side owns ${family.id} and disable the other; a third-party bundle that patches out the stock owner must be disabled as a whole (${third.map((e) => e.owner).join(', ')}), not entry by entry`
          : 'disable every competitor but one',
      }),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ D005 */
function checkMarketDesync(ctx) {
  const out = [];
  const disabled = Array.isArray(ctx.market?.disabled) ? ctx.market.disabled : [];

  for (const name of disabled) {
    const inBundles = ctx.bundles.includes(name);
    const installed = ctx.installedByName.get(name);
    const owned = ctx.dump.entries.filter((entry) => entry.owner === name);
    const enabledOwned = owned.filter((entry) => isOn(entry.disabled));

    if (enabledOwned.length > 0) {
      out.push(
        finding('D005', 'warn', 'market state and composed tree disagree', `the market marks "${name}" as off, yet the composed tree still has ${enabledOwned.length} enabled entr${enabledOwned.length === 1 ? 'y' : 'ies'} owned by it (${enabledOwned.map((e) => `"${e.id}"`).join(', ')}).`, {
          key: `D005:on:${name}`,
          where: { file: ctx.marketPath, line: null },
          fix: 'the profile patch re-enables what the market disabled; either drop the override or remove the market entry — otherwise every boot rewrites the bundle list',
        }),
      );
      continue;
    }

    if (!inBundles && !installed) {
      out.push(
        finding('D005', 'info', 'stale market entry', `the market still lists "${name}" as off, but it is neither in \`dsh.profile.bundles\` nor installed. The row is harmless bookkeeping.`, {
          key: `D005:stale:${name}`,
          where: { file: ctx.marketPath, line: null },
        }),
      );
    }
  }

  for (const bundle of ctx.bundles) {
    const owned = ctx.dump.entries.filter((entry) => entry.owner === bundle);
    if (owned.length > 0) continue;
    const pkg = ctx.installedByName.get(bundle);
    const dir = pkg?.dir ?? (ctx.appNodeModules ? join(ctx.appNodeModules, bundle) : null);
    if (dir && !existsSync(dir)) {
      out.push(
        finding('D005', 'error', 'bundle is declared but not installed', `"${bundle}" is listed in \`dsh.profile.bundles\` but its package directory does not exist.`, {
          key: `D005:missing:${bundle}`,
          where: { file: ctx.manifestPath, line: null },
          fix: 'remove the bundle from `dsh.profile.bundles` or reinstall it',
        }),
      );
      continue;
    }
    out.push(
      finding('D005', 'warn', 'bundle contributes no loader entries', `"${bundle}" is listed in \`dsh.profile.bundles\` but the composed tree has no entry owned by it.`, {
        key: `D005:empty:${bundle}`,
        where: { file: ctx.manifestPath, line: null },
        fix: 'check the package\'s `dsh.bundle.patch` file and its `cordis.yml`',
      }),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ D006 */
function checkPluginLinks(ctx) {
  const out = [];
  for (const pkg of ctx.installed) {
    const managed = ctx.bundles.includes(pkg.name) || Object.hasOwn(ctx.dependencies, pkg.name);
    if (pkg.link.kind === 'dir' && managed && !ctx.sharedTreeKeep.has(pkg.name)) {
      out.push(
        finding('D006', 'error', 'plugin directory is not a link', `"${pkg.name}" is installed as a real directory instead of a link. Generation switching cannot move it, and a plain copy of the profile will duplicate the whole plugin.`, {
          key: `D006:${pkg.name}`,
          where: { file: pkg.dir, line: null },
          fix: `reinstall it through the market or \`pnpm\`, or replace the directory with a junction to the generation under profiles\\.generations\\live\\`,
        }),
      );
    }
    if (pkg.link.kind === 'missing') {
      out.push(
        finding('D006', 'error', 'plugin link target is gone', `"${pkg.name}" is a link pointing at ${pkg.link.target ?? 'an unknown path'}, which does not exist.`, {
          key: `D006:missing:${pkg.name}`,
          where: { file: pkg.dir, line: null },
          fix: 'reinstall the plugin, or remove the dangling link',
        }),
      );
    }
  }
  return out;
}

/* ------------------------------------------------------------------ D007 */
function checkEngines(ctx) {
  const out = [];
  if (!ctx.hostVersion) return out;
  for (const pkg of ctx.installed) {
    const range = pkg.dsh?.engines?.dsh;
    if (typeof range !== 'string' || range.trim() === '') continue;
    const result = satisfies(ctx.hostVersion, range);
    if (result !== false) continue;
    const owned = ctx.dump.entries.filter((entry) => entry.owner === pkg.name);
    const live = owned.filter((entry) => isOn(entry.disabled)).length > 0;
    out.push(
      finding('D007', live ? 'error' : 'info', 'plugin does not support this harness', `"${pkg.name}@${pkg.version}" requires \`dsh.engines.dsh\` ${range}, but the installed harness is ${ctx.hostVersion}.`, {
        key: `D007:${pkg.name}`,
        where: { file: join(pkg.dir, 'package.json'), line: null },
        fix: live
          ? 'disable it in the profile patch; the market refuses to install a plugin whose engine range excludes this harness'
          : null,
      }),
    );
  }
  for (const [name, loaded] of ctx.loadedDirs) {
    if (!loaded.version || !ctx.hostVersion) continue;
    const pkg = ctx.installedByName.get(name);
    if (!pkg) continue;
    const declared = pkg.dsh?.engines?.dsh;
    if (typeof declared !== 'string') continue;
    const owned = ctx.dump.entries.filter((entry) => entry.owner === name && isOn(entry.disabled));
    if (owned.length === 0) continue;
    const result = satisfies(loaded.version, declared);
    if (result !== false) continue;
    out.push(
      finding('D007', 'error', 'loaded plugin version violates its own engine range', `"${name}@${loaded.version}" is loaded but declares \`dsh.engines.dsh\` ${declared} (harness ${ctx.hostVersion}).`, {
        key: `D007:loaded:${name}`,
        where: { file: loaded.dir, line: null },
      }),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ D008 */
/**
 * Only *declared* dependencies and peers are checked, never source imports:
 * scanning a minified bundle for `require("...")` produces nothing but noise,
 * while the closure question -- "can this package's declared graph resolve from
 * the profile?" -- is exactly what the desktop's own peer validation asks.
 */
function checkDependencyClosure(ctx) {
  const out = [];
  for (const pkg of ctx.installed) {
    const owned = ctx.dump.entries.filter((entry) => entry.owner === pkg.name);
    if (owned.length === 0) continue;
    const live = owned.some((entry) => isOn(entry.disabled));
    const manifest = pkg.manifest ?? {};

    const groups = [
      { field: 'dependencies', severity: live ? 'error' : 'info' },
      { field: 'peerDependencies', severity: live ? 'warn' : 'info' },
      { field: 'optionalDependencies', severity: 'info' },
    ];

    const missing = [];
    for (const { field, severity } of groups) {
      const declared = manifest[field];
      if (!declared || typeof declared !== 'object') continue;
      for (const name of Object.keys(declared)) {
        if (resolvesFrom(name, [join(pkg.dir, 'node_modules'), ...ctx.resolutionRoots])) continue;
        missing.push({ name, field, severity });
      }
    }
    if (missing.length === 0) continue;

    const worst = missing.some((item) => item.severity === 'error')
      ? 'error'
      : missing.some((item) => item.severity === 'warn')
        ? 'warn'
        : 'info';

    const byField = new Map();
    for (const item of missing) {
      if (!byField.has(item.field)) byField.set(item.field, []);
      byField.get(item.field).push(item.name);
    }

    out.push(
      finding('D008', worst, 'dependency cannot resolve from the profile closure', `"${pkg.name}@${pkg.version ?? '?'}" declares ${[...byField].map(([field, names]) => `${field} ${names.map((n) => `"${n}"`).join(', ')}`).join('; ')}, and none of them resolve from the profile, the plugin's own node_modules, or the app tree.`, {
        key: `D008:${pkg.name}`,
        where: { file: join(pkg.dir, 'package.json'), line: null },
        fix: live
          ? 'the profile install closure is incomplete for this plugin: reinstall it so its dependencies land in the profile, pin them with pnpm overrides, or disable it'
          : null,
      }),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ D009 */
function checkLayeredOverrides(ctx) {
  const out = [];
  if (ctx.patch.entries.length === 0) return out;
  const byId = new Map(ctx.patch.entries.map((entry) => [entry.id, entry]));

  for (const [bundle, layer] of ctx.bundlePatches) {
    for (const entry of layer.entries) {
      const override = byId.get(entry.id);
      if (!override) continue;
      const before = enablement(entry.disabled);
      const after = enablement(override.disabled);
      if (before === after) continue;
      out.push(
        finding('D009', 'info', 'profile patch overrides a bundle layer', `bundle "${bundle}" sets entry "${entry.id}" to ${before}, and the profile patch changes it to ${after}. Profile is the last layer, so ${after} wins.`, {
          key: `D009:${bundle}:${entry.id}`,
          where: { file: override.file ?? ctx.patch.path, line: override.line },
          fix: null,
        }),
      );
    }
    for (const entry of layer.entries) {
      for (const inserted of entry.inserts ?? []) {
        const override = byId.get(inserted.id);
        if (!override) continue;
        if (enablement(override.disabled) === 'off') continue;
        out.push(
          finding('D009', 'warn', 'inserted entry is shadowed', `bundle "${bundle}" inserts entry "${inserted.id}" (${inserted.name ?? 'no name'}), but the profile patch also declares "${inserted.id}". Two definitions for one id means whichever layer wins is an implementation detail.`, {
            key: `D009:insert:${bundle}:${inserted.id}`,
            where: { file: override.file ?? ctx.patch.path, line: override.line },
          }),
        );
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ D010 */
function checkRecovery(ctx) {
  const out = [];
  const removals = ctx.recovery?.removals;
  if (!removals || typeof removals !== 'object') return out;
  for (const [id, record] of Object.entries(removals)) {
    const status = String(record?.status ?? 'unknown');
    if (status === 'removed' && record?.bootVerifiedAt) continue;
    out.push(
      finding('D010', 'warn', 'plugin removal is unfinished', `removal "${id}" of "${record?.pluginName ?? 'unknown'}" is in status "${status}"${record?.failures?.length ? ` with ${record.failures.length} failure(s)` : ''}. While a removal is unverified the desktop defers profile package maintenance.`, {
        key: `D010:${id}`,
        where: { file: ctx.recoveryPath, line: null },
        fix: status === 'removed' ? 'restart DSH once so the removal can be verified' : 'let DSH finish the removal, or restore from the recorded backup',
      }),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ D011 */
function checkShadowedInstalls(ctx) {
  const out = [];
  for (const pkg of ctx.installed) {
    const loaded = ctx.loadedDirs.get(pkg.name);
    if (!loaded?.dir) continue;
    if (resolve(loaded.dir) === resolve(pkg.dir)) continue;
    if (ctx.sharedTreeKeep.has(pkg.name)) {
      out.push(
        finding('D011', 'warn', 'profile copy of a shared package is unused', `"${pkg.name}@${pkg.version ?? '?'}" exists in the profile's node_modules, but the loaded copy is the app's ${loaded.version ?? '?'} at ${loaded.dir}. DSH keeps this package in the shared tree, so the profile copy never loads.`, {
          key: `D011:${pkg.name}`,
          where: { file: pkg.dir, line: null },
          fix: 'safe to delete the profile copy; upgrading it will not change what runs',
        }),
      );
      continue;
    }
    const cmp = pkg.version && loaded.version ? compareVersions(pkg.version, loaded.version) : null;
    out.push(
      finding('D011', 'warn', 'installed plugin is shadowed by another copy', `"${pkg.name}" is installed at ${pkg.dir} (v${pkg.version ?? '?'}) but the composed tree loads v${loaded.version ?? '?'} from ${loaded.dir}${cmp === 0 ? ' (same version, different directory)' : ''}.`, {
        key: `D011:${pkg.name}`,
        where: { file: pkg.dir, line: null },
        fix: 'two copies make upgrades look ineffective; keep the one the tree loads',
      }),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ D012 */
function checkProfileScratch(ctx) {
  const out = [];
  let names;
  try {
    names = readdirSync(ctx.profileDir);
  } catch {
    return out;
  }
  const temp = names.filter((name) => /\.tmp\.\d+\.\w+$/.test(name));
  if (temp.length > 0) {
    out.push(
      finding('D012', 'info', 'leftover atomic-write scratch files', `${temp.length} scratch file(s) in the profile directory: ${temp.map((n) => `"${n}"`).join(', ')}. A .tmp file next to a config usually means a write was interrupted.`, {
        key: 'D012:tmp',
        where: { file: ctx.profileDir, line: null },
        fix: 'compare against the live file and delete once you are happy',
      }),
    );
  }
  const backups = names.filter((name) => /\.bak[-.]/.test(name));
  if (backups.length >= 5) {
    out.push(
      finding('D012', 'info', 'backup pile has grown', `${backups.length} backup files sit beside the live profile configs.`, {
        key: 'D012:bak',
        where: { file: ctx.profileDir, line: null },
        fix: 'keep the newest per incident and delete the rest',
      }),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ D013 */
function checkClientInject(ctx) {
  const out = [];
  for (const pkg of ctx.installed) {
    const inject = pkg.dsh?.client?.inject;
    if (!Array.isArray(inject) || inject.length === 0) continue;
    const owned = ctx.dump.entries.filter((entry) => entry.owner === pkg.name);
    if (owned.length === 0) continue;
    const missing = inject.filter((spec) => !resolvesFrom(spec, ctx.resolutionRoots));
    if (missing.length === 0) continue;
    out.push(
      finding('D013', 'info', 'client inject target is not an installed package', `"${pkg.name}" lists ${missing.map((s) => `"${s}"`).join(', ')} in \`dsh.client.inject\`, and no such package exists in the profile or the app.`, {
        key: `D013:${pkg.name}`,
        where: { file: join(pkg.dir, 'package.json'), line: null },
        why: 'inject targets are usually service names provided by another client plugin at runtime, so this is a hint rather than a fault',
      }),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ D014 */
function checkStaleInstalls(ctx) {
  const present = (ctx.loggedInstalls ?? []).filter((item) => item.exists);
  if (present.length < 2) return [];
  const current = ctx.bin ? resolve(ctx.bin) : null;
  const others = present.filter((item) => resolve(item.bin) !== current);
  if (others.length === 0) return [];

  const describe = (item) => {
    const root = resolve(item.bin, '..', '..', '..', '..', '..');
    const manifest = readJson(join(root, 'package.json'));
    const version = manifest.ok && manifest.value.version ? `v${manifest.value.version}` : 'version unknown';
    return `${root} (${version})`;
  };

  return [
    finding('D014', 'warn', 'more than one DSH installation is present on disk', `the harness logs record ${present.length} different entry points; the one in use is ${current ?? 'unknown'}. These still exist on disk and are no longer launched: ${others.map(describe).join(', ')}.`, {
      key: 'D014',
      where: { file: ctx.logSource ?? null, line: null },
      fix: 'a stale install is a second copy of the whole app (resources, node_modules, asar). Delete the ones you no longer launch, and check that your shortcut points at the live one — diagnosing the wrong copy reports the wrong harness version',
    }),
  ];
}

export const CHECKS = [
  checkPatchNameMismatch,
  checkPatchOrphans,
  checkDuplicatePackage,
  checkSingletonFamilies,
  checkMarketDesync,
  checkPluginLinks,
  checkEngines,
  checkDependencyClosure,
  checkLayeredOverrides,
  checkRecovery,
  checkShadowedInstalls,
  checkProfileScratch,
  checkClientInject,
  checkStaleInstalls,
  checkAnalysisCoverage,
];

export {
  checkPatchNameMismatch,
  checkPatchOrphans,
  checkDuplicatePackage,
  checkSingletonFamilies,
  checkMarketDesync,
  checkPluginLinks,
  checkEngines,
  checkDependencyClosure,
  checkLayeredOverrides,
  checkRecovery,
  checkShadowedInstalls,
  checkProfileScratch,
  checkClientInject,
  checkStaleInstalls,
  checkAnalysisCoverage,
};

/* ------------------------------------------------------------------ D015 */
/**
 * The worst failure mode for a diagnostic tool is a false clean bill of health,
 * so a degraded run announces itself as a finding instead of only as a header.
 */
function checkAnalysisCoverage(ctx) {
  const coverage = ctx.availability ?? {};
  if (!coverage.profileDir) {
    return [
      finding('D015', 'warn', 'analysis ran without the profile layer', `the profile directory does not exist, so only the dump was analysed: ${ctx.profileDir}. Every check that reads the profile — installed packages, link kinds, engine ranges, market state, storage hygiene — was skipped, so "no problems found" would not mean this profile is healthy.`, {
        key: 'D015:profile-dir',
        where: { file: ctx.profileDir, line: null },
        fix: 'point --home/--profile at the real installation, or run `check` without --dump so the tree is composed from the live install',
      }),
    ];
  }
  if (!coverage.patchLayer) {
    return [
      finding('D015', 'info', 'no profile patch layer', `there is no readable cordis.patch.yml at ${ctx.patch.path ?? join(ctx.profileDir, 'cordis.patch.yml')}, so nothing can override a bundle layer.`, {
        key: 'D015:patch-layer',
        where: { file: ctx.patch.path ?? ctx.profileDir, line: null },
      }),
    ];
  }
  return [];
}

export function runChecks(ctx) {
  const findings = [];
  for (const check of CHECKS) {
    let produced;
    try {
      produced = check(ctx);
    } catch (error) {
      produced = [
        finding('D000', 'warn', 'a check crashed', `${check.name} threw: ${error.message}`, {
          key: `D000:${check.name}`,
          fix: 'this is a doctor bug — please report it with the --json output',
        }),
      ];
    }
    findings.push(...produced);
  }

  const deduped = new Map();
  for (const item of findings) if (!deduped.has(item.key)) deduped.set(item.key, item);

  return [...deduped.values()].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.code.localeCompare(b.code) ||
      (a.where?.line ?? 0) - (b.where?.line ?? 0),
  );
}

export function summarize(findings) {
  const counts = { error: 0, warn: 0, info: 0 };
  for (const item of findings) counts[item.severity] = (counts[item.severity] ?? 0) + 1;
  return counts;
}
