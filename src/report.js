import { join } from 'node:path';

const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const paint = (code, text) => (useColor() ? `\u001b[${code}m${text}\u001b[0m` : text);
const dim = (t) => paint('2', t);
const bold = (t) => paint('1', t);
const red = (t) => paint('31', t);
const yellow = (t) => paint('33', t);
const blue = (t) => paint('36', t);
const green = (t) => paint('32', t);

const SEVERITY_LABEL = {
  error: () => red('ERROR'),
  warn: () => yellow('WARN '),
  info: () => blue('INFO '),
};

const GLYPH = { error: 'x', warn: '!', info: '-', ok: 'v' };

function short(input, limit = 160) {
  const text = String(input ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function where(finding, cwd) {
  if (!finding.where?.file) return null;
  let file = finding.where.file;
  if (cwd && file.startsWith(cwd)) file = file.slice(cwd.length).replace(/^[\\/]/, '');
  return finding.where.line ? `${file}:${finding.where.line}` : file;
}

export function printHeader(ctx, out = console.log) {
  out(bold('dsh-plugin-doctor') + dim(`  ${ctx.version ?? ''}`.trimEnd()));
  out(dim('  home     ') + ctx.home);
  out(dim('  profile  ') + ctx.profile);
  out(dim('  dump     ') + `${ctx.dumpPath} ${dim(`(${ctx.dump.entries.length} entries, ${ctx.dump.sections.length} sections)`)}`);
  out(dim('  patch    ') + (ctx.patch.path ?? dim('none')));
  out(dim('  harness  ') + (ctx.hostVersion ?? dim('unknown')) + dim(`  node ${ctx.nodeVersion}`));
  out('');
}

export function printFindings(findings, ctx, out = console.log) {
  if (findings.length === 0) {
    out(green(`${GLYPH.ok} no problems found`));
    out('');
    return;
  }
  const cwd = process.cwd();
  for (const item of findings) {
    const location = where(item, cwd);
    out(`${SEVERITY_LABEL[item.severity]()} ${dim(item.code)}  ${bold(item.title)}${location ? dim(`  ${location}`) : ''}`);
    out(`        ${short(item.message, 400)}`);
    if (item.why) out(`        ${dim('why')}     ${short(item.why, 400)}`);
    if (item.fix) out(`        ${dim('fix')}     ${short(item.fix, 400)}`);
    out('');
  }
}

export function printSummary(counts, out = console.log) {
  const parts = [];
  if (counts.error) parts.push(red(`${counts.error} error${counts.error === 1 ? '' : 's'}`));
  if (counts.warn) parts.push(yellow(`${counts.warn} warning${counts.warn === 1 ? '' : 's'}`));
  if (counts.info) parts.push(blue(`${counts.info} info`));
  out(bold('summary  ') + (parts.length ? parts.join(', ') : green('clean')));
}

export function printGraph(ctx, out = console.log) {
  out(bold(`composed loader tree — profile "${ctx.profile}"`));
  out(dim(`  ${ctx.dump.entries.length} entries in ${ctx.dump.sections.length} sections`));
  out('');
  for (const section of ctx.dump.sections) {
    const entries = ctx.dump.entries.filter((entry) => entry.section === section.label);
    const on = entries.filter((entry) => entry.disabled === null || (entry.disabled.kind === 'bool' && !entry.disabled.value));
    const dynamic = entries.filter((entry) => entry.disabled?.kind === 'js');
    out(
      `${bold(section.owner)} ${dim(`(${entries.length} entries, ${on.length} on${dynamic.length ? `, ${dynamic.length} dynamic` : ''})`)}` +
        (section.patchedBy ? dim(`  patched by ${section.patchedBy.split(/[\\/]/).pop()}`) : ''),
    );
    for (const entry of entries) {
      const state =
        entry.disabled === null
          ? green('on ')
          : entry.disabled.kind === 'bool'
            ? entry.disabled.value
              ? dim('off')
              : green('on ')
            : yellow('dyn');
      out(`  ${state} ${entry.id}${entry.name && entry.name !== entry.id ? dim(`  -> ${entry.name}`) : ''}`);
    }
    out('');
  }
}

export function toJson(ctx, findings, counts) {
  return {
    tool: 'dsh-plugin-doctor',
    version: ctx.version,
    home: ctx.home,
    profile: ctx.profile,
    dumpPath: ctx.dumpPath,
    patchPath: ctx.patch.path,
    hostVersion: ctx.hostVersion,
    nodeVersion: ctx.nodeVersion,
    tree: {
      entries: ctx.dump.entries.length,
      sections: ctx.dump.sections.length,
      enabled: ctx.enabled.length,
      dynamic: ctx.dynamic.length,
      bundles: ctx.bundles,
    },
    counts,
    ok: counts.error === 0,
    findings: findings.map((item) => ({
      code: item.code,
      severity: item.severity,
      title: item.title,
      message: item.message,
      file: item.where?.file ?? null,
      line: item.where?.line ?? null,
      fix: item.fix ?? null,
      id: item.id ?? null,
    })),
  };
}

export { join };
