/**
 * dsh-plugin-doctor — client half.
 *
 * Hand-written in the browser module format DSH loads (`window.__ModuleLoader__
 * .load({id, factory})`), so this package still needs no bundler and no build
 * step: the file you read is the file the browser runs.
 *
 * What it registers, and what it deliberately does not:
 *
 *   registers   ONE seat in `sidebar.footer.action` (a list slot, so it can
 *               coexist with anything else seated there)
 *   does NOT    touch `sidebar.settings` (a single-owner slot that already has
 *               an owner), `shell.overlay`, or any entry's `disabled:` state
 *
 * A tool that reports plugins for crowding each other out has no business
 * crowding anything out. One button, one panel, no interference.
 *
 * The panel is drawn with `position: fixed` from inside the footer button rather
 * than through an overlay slot, for the same reason: one registration, total.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-doctor',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    /** Service names, matching `dsh.client.inject` in package.json. */
    const inject = ['slots'];

    const BASE = '/dsh-plugin-doctor';

    const SEVERITY = {
      error: { label: '错误', glyph: '✕' },
      warn: { label: '警告', glyph: '!' },
      info: { label: '提示', glyph: 'i' },
    };
    const ORDER = ['error', 'warn', 'info'];

    /* ------------------------------------------------------------- styles */
    // Injected once, at materialization — which is where the module system
    // expects side effects to live.
    const STYLE_ID = 'dsh-plugin-doctor-style';
    if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
.dshdoc-btn{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;
  padding:6px 8px;border:0;border-radius:8px;background:transparent;color:inherit;
  font:inherit;font-size:12px;line-height:1;cursor:pointer;opacity:.72}
.dshdoc-btn:hover{opacity:1;background:rgba(127,127,127,.14)}
.dshdoc-btn[data-open="1"]{opacity:1;background:rgba(127,127,127,.18)}
.dshdoc-glyph{font-size:13px;line-height:1}
.dshdoc-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto}

.dshdoc-panel{position:fixed;left:12px;bottom:56px;z-index:2147483000;
  display:flex;flex-direction:column;width:min(440px,calc(100vw - 24px));max-height:min(72vh,720px);
  border:1px solid rgba(127,127,127,.30);border-radius:12px;overflow:hidden;
  background:var(--dsh-surface,#1b1b1f);color:var(--dsh-text,#e8e8ea);
  box-shadow:0 12px 40px rgba(0,0,0,.42);font-size:12px;line-height:1.5}
.dshdoc-head{display:flex;align-items:center;gap:8px;padding:10px 12px;
  border-bottom:1px solid rgba(127,127,127,.22)}
.dshdoc-title{font-weight:600;font-size:13px}
.dshdoc-spacer{flex:1}
.dshdoc-icon{border:0;border-radius:6px;background:transparent;color:inherit;
  font:inherit;cursor:pointer;padding:3px 7px;opacity:.7}
.dshdoc-icon:hover{opacity:1;background:rgba(127,127,127,.18)}
.dshdoc-icon[disabled]{opacity:.35;cursor:default}

.dshdoc-sum{padding:8px 12px;border-bottom:1px solid rgba(127,127,127,.16);
  display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.dshdoc-count{display:inline-flex;align-items:center;gap:5px}
.dshdoc-meta{padding:7px 12px;border-bottom:1px solid rgba(127,127,127,.16);
  display:grid;grid-template-columns:auto 1fr;gap:2px 10px;opacity:.62;font-size:11px}
.dshdoc-meta b{font-weight:500;opacity:.72}

.dshdoc-body{overflow:auto;padding:4px 0 8px}
.dshdoc-group{padding:8px 12px 2px;font-size:11px;letter-spacing:.06em;
  text-transform:uppercase;opacity:.5}
.dshdoc-item{margin:6px 12px;padding:8px 10px;border-radius:8px;
  border:1px solid rgba(127,127,127,.20);background:rgba(127,127,127,.06)}
.dshdoc-item-top{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap}
.dshdoc-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:10px;padding:1px 5px;border-radius:4px;background:rgba(127,127,127,.20)}
.dshdoc-name{font-weight:600}
.dshdoc-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:10px;opacity:.55;word-break:break-all}
.dshdoc-msg{margin-top:5px;white-space:pre-wrap;word-break:break-word}
.dshdoc-fix{margin-top:5px;padding-left:8px;border-left:2px solid rgba(127,127,127,.34);
  opacity:.85;white-space:pre-wrap;word-break:break-word}
.dshdoc-fix b{font-weight:600;opacity:.75}
.dshdoc-note{padding:14px 12px;opacity:.75;white-space:pre-wrap;word-break:break-word}
.dshdoc-foot{padding:8px 12px;border-top:1px solid rgba(127,127,127,.18);
  display:flex;gap:8px;align-items:center}
.dshdoc-foot .dshdoc-spacer{flex:1}
.dshdoc-when{opacity:.5;font-size:11px}
`;
      document.head.appendChild(style);
    }

    /* ------------------------------------------------------------- pieces */

    function Dot({ severity }) {
      const color = severity === 'error' ? '#ff6b6b' : severity === 'warn' ? '#ffb454' : '#5aa9e6';
      return h('span', { className: 'dshdoc-dot', style: { background: color } });
    }

    function Finding({ item }) {
      const path = item.file ? `${item.file}${item.line ? `:${item.line}` : ''}` : null;
      return h(
        'div',
        { className: 'dshdoc-item' },
        h(
          'div',
          { className: 'dshdoc-item-top' },
          h(Dot, { severity: item.severity }),
          h('span', { className: 'dshdoc-code' }, item.code),
          h('span', { className: 'dshdoc-name' }, item.title),
        ),
        path ? h('div', { className: 'dshdoc-path' }, path) : null,
        h('div', { className: 'dshdoc-msg' }, item.message),
        item.fix ? h('div', { className: 'dshdoc-fix' }, h('b', null, '建议  '), item.fix) : null,
      );
    }

    function ReportBody({ state }) {
      if (state.status === 'loading') return h('div', { className: 'dshdoc-note' }, '正在检查…');
      if (state.status === 'failed') {
        return h('div', { className: 'dshdoc-note' }, `检查未完成\n\n${state.reason}`);
      }

      const report = state.report;
      const counts = report.counts ?? {};
      const findings = report.findings ?? [];

      const summary = ORDER.filter((severity) => (counts[severity] ?? 0) > 0).map((severity) =>
        h(
          'span',
          { className: 'dshdoc-count', key: severity },
          h(Dot, { severity }),
          `${SEVERITY[severity].label} ${counts[severity]}`,
        ),
      );

      const groups = ORDER.map((severity) => {
        const rows = findings.filter((item) => item.severity === severity);
        if (rows.length === 0) return null;
        return h(
          'div',
          { key: severity },
          h('div', { className: 'dshdoc-group' }, `${SEVERITY[severity].label} · ${rows.length}`),
          rows.map((item, index) => h(Finding, { item, key: `${item.code}-${index}` })),
        );
      });

      const tree = report.tree ?? {};
      const analysis = report.analysis ?? {};

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'dshdoc-sum' },
          summary.length
            ? summary
            : h('span', { className: 'dshdoc-count' }, h(Dot, { severity: 'info' }), '没有问题'),
        ),
        h(
          'div',
          { className: 'dshdoc-meta' },
          h('b', null, 'profile'),
          h('span', null, report.profile ?? '—'),
          h('b', null, 'harness'),
          h('span', null, report.hostVersion ?? '—'),
          h('b', null, '插件树'),
          h('span', null, `${tree.entries ?? 0} 条目 / ${tree.sections ?? 0} 段 / ${tree.enabled ?? 0} 启用`),
          h('b', null, '分析层'),
          h(
            'span',
            null,
            analysis.profileDir === false ? '缺少 profile 目录（仅离线分析）' : '完整',
          ),
        ),
        findings.length === 0
          ? h('div', { className: 'dshdoc-note' }, '没有发现问题。')
          : h('div', { className: 'dshdoc-body' }, groups),
      );
    }

    /* ------------------------------------------------------------ the seat */

    function DoctorAction() {
      const [open, setOpen] = useState(false);
      const [state, setState] = useState({ status: 'idle' });
      const [copied, setCopied] = useState(false);
      const alive = useRef(true);

      useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      const load = useCallback((refresh) => {
        setState({ status: 'loading' });
        fetch(`${BASE}/report${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' })
          .then((response) => response.json())
          .then((body) => {
            if (!alive.current) return;
            if (body && body.ok) setState({ status: 'ready', report: body.report, ageMs: body.ageMs });
            else setState({ status: 'failed', reason: (body && body.reason) || '未知错误' });
          })
          .catch((error) => {
            if (alive.current) setState({ status: 'failed', reason: String(error) });
          });
      }, []);

      const toggle = () => {
        const next = !open;
        setOpen(next);
        if (next && state.status === 'idle') load(false);
      };

      // Close on Escape, but only while open.
      useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [open]);

      const counts = state.report?.counts ?? {};
      let badge = null;
      if (state.status === 'ready') {
        const severity = ORDER.find((item) => (counts[item] ?? 0) > 0);
        if (severity) badge = h(Dot, { severity });
      }

      const copy = () => {
        const text = JSON.stringify(state.report ?? { error: state.reason }, null, 2);
        navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => setCopied(false),
        );
      };

      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            className: 'dshdoc-btn',
            type: 'button',
            title: 'DSH 插件体检',
            'data-open': open ? '1' : '0',
            onClick: toggle,
          },
          h('span', { className: 'dshdoc-glyph' }, '🩺'),
          h('span', null, '诊断'),
          badge,
        ),
        open
          ? h(
              'div',
              { className: 'dshdoc-panel', role: 'dialog', 'aria-label': 'DSH 插件体检' },
              h(
                'div',
                { className: 'dshdoc-head' },
                h('span', { className: 'dshdoc-title' }, 'DSH 插件体检'),
                h('span', { className: 'dshdoc-spacer' }),
                h(
                  'button',
                  {
                    className: 'dshdoc-icon',
                    type: 'button',
                    onClick: copy,
                    disabled: state.status !== 'ready',
                    title: '复制 JSON 报告',
                  },
                  copied ? '已复制' : '复制',
                ),
                h(
                  'button',
                  {
                    className: 'dshdoc-icon',
                    type: 'button',
                    onClick: () => load(true),
                    disabled: state.status === 'loading',
                    title: '重新检查',
                  },
                  '重新检查',
                ),
                h(
                  'button',
                  { className: 'dshdoc-icon', type: 'button', onClick: () => setOpen(false), title: '关闭' },
                  '✕',
                ),
              ),
              h(ReportBody, { state }),
              h(
                'div',
                { className: 'dshdoc-foot' },
                h('span', { className: 'dshdoc-when' }, 'dsh-plugin-doctor'),
                h('span', { className: 'dshdoc-spacer' }),
                h(
                  'span',
                  { className: 'dshdoc-when' },
                  state.report?.dumpPath ? '检查为只读，不改动任何文件' : '',
                ),
              ),
            )
          : null,
      );
    }

    /* -------------------------------------------------------------- apply */

    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', function* () {
        yield ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'plugin-doctor', order: 60 },
          DoctorAction,
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
