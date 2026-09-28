# dsh-plugin-doctor

[![test](https://github.com/snow-light-2/dsh-plugin-doctor/actions/workflows/ci.yml/badge.svg)](https://github.com/snow-light-2/dsh-plugin-doctor/actions/workflows/ci.yml)

Diagnose **DeepSeek Harness (DSH)** plugin-tree conflicts from the command line.

DSH composes a plugin tree from four layers — bundle patches, the profile patch,
the market's persisted state, and the generation projection. Any layer can
silently cancel another, and the symptom is almost never the cause: the app boots
with a missing sidebar, a plugin upgrade appears to do nothing, or the harness
dies with `0xC0000409` after printing one line nobody reads.

`dsh-plugin-doctor` reads the composed tree, the raw layer files and the harness
logs, and turns that into findings with a file, a line and a fix.

```
ERROR D001  patch entry is silently skipped (name mismatch)   cordis.patch.yml:30
        patch entry "llm-deepseek" declares name "@deepseek-ai/dsh-llm-deepseek-api-key",
        but the composed tree defines "@deepseek-ai/dsh-llm-deepseek".
        fix     set `name: "@deepseek-ai/dsh-llm-deepseek"` — until then its `config:`
                block is never applied
```

## Why it exists

Three failure modes account for most DSH plugin trouble, and all three are
invisible at runtime:

1. **A patch entry is skipped in silence.** If `- id: x` declares a `name:` that
   disagrees with the bundle that owns `x`, DSH drops the whole entry — including
   its `config:`. Nothing crashes; the setting simply does not apply.
2. **Two layers disagree.** A bundle disables an entry, the profile patch
   re-enables it, and the market rewrites `dsh.profile.bundles` on every boot.
   The profile patch is applied last, so it wins — but only if nobody else
   rewrites the input.
3. **A singleton service is registered twice.** `session-title` accepts exactly
   one provider. A third-party bundle that replaces the stock one and is enabled
   *alongside* it throws during `apply()`, which aborts the entire plugin tree
   and takes the desktop into safe mode.

## Requirements

- Node.js ≥ 18
- No dependencies. Nothing to build. It runs even when DSH itself will not boot.

## Quick start

```bash
git clone https://github.com/snow-light-2/dsh-plugin-doctor.git
cd dsh-plugin-doctor

# compose the profile tree and inspect it
node bin/dsh-plugin-doctor.js check

# what does this log actually mean?
node bin/dsh-plugin-doctor.js explain "%APPDATA%\dsh-desktop\logs\harness.log"

# print the whole tree with each entry's state
node bin/dsh-plugin-doctor.js graph
```

Or install it globally:

```bash
npm install -g dsh-plugin-doctor
dsh-plugin-doctor check
```

## Commands

| command | what it does |
| --- | --- |
| `capture` | run `dsh --profile <p> --dump-config` and save stdout + stderr as a dump |
| `check` | run every check against a dump (capturing one first if needed) |
| `graph` | print the composed loader tree, section by section, with each entry's state |
| `explain [file]` | read a harness log (or stdin) and explain each known failure signature |

### Options

```
--home <dir>        DSH home (default: $DSH_HOME, then %APPDATA%\dsh-desktop\harness, then ~/.dsh)
--profile <name>    profile to inspect (default: web)
--dump <file>       analyse an existing dump instead of composing a new one
--dump-stderr <f>   companion stderr file from the same capture
--dsh-bin <file>    path to @deepseek-ai/dsh/lib/bin.js
--app <dir>         path to the DSH app directory (resources/app)
--out <file>        capture output path (default: .dsh-doctor/dump-<profile>.txt)
--json              machine-readable output
--strict            treat warnings as failures
--no-color          disable ANSI colour
```

### Finding the installation

DSH Desktop records nothing about where it lives, so `--dsh-bin` is auto-detected
from the harness log (the newest `loading=…` line whose path still exists), then
from the usual install locations. If detection fails, the error tells you exactly
what to pass. You can also pin it once per machine:

```json
// <DSH home>/.dsh-doctor.json
{ "dshBin": "E:\\DSH Desktop\\resources\\app\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" }
```

### Exit codes

| code | meaning |
| --- | --- |
| `0` | clean (or only warnings, without `--strict`) |
| `1` | findings at or above the failure threshold — or, for `explain`, at least one known failure signature matched |
| `2` | usage error, or the profile could not be read |

`explain` returning `1` on a match is deliberate: it makes "fail the build if this
log contains a known DSH failure" a one-liner in CI.

## Checks

| code | severity | what it catches |
| --- | --- | --- |
| `D001` | error | a patch entry is skipped because its `name:` disagrees with the tree — its `config:` never applies |
| `D002` | info / warn | a patch entry targets an id no bundle defines (info when it only sets `disabled: true`, which is a deliberate guard) |
| `D003` | error | one package name is enabled from two different install directories |
| `D004` | error | two enabled entries compete for a singleton service provider |
| `D005` | warn / info | the market's persisted state and the composed tree disagree; a declared bundle contributes nothing or is not installed |
| `D006` | error | a plugin directory is a real directory instead of a link, so generation switching cannot move it |
| `D007` | error / info | `dsh.engines.dsh` excludes the installed harness |
| `D008` | error / warn / info | a declared dependency or peer cannot resolve from the profile install closure |
| `D009` | info / warn | the profile patch overrides a bundle layer, or shadows an entry a bundle inserts |
| `D010` | warn | a plugin removal never reached verified state, which blocks profile maintenance |
| `D011` | warn | a plugin is installed twice and the composed tree loads a different copy |
| `D012` | info | interrupted atomic writes, or a pile of `.bak` files beside the live config |
| `D013` | info | a `dsh.client.inject` target that is not an installed package (usually a runtime service) |
| `D014` | warn | more than one DSH installation exists on disk and the logs point at the wrong one |

Every check is read-only. `check` never writes to the profile.

## JSON output for CI

```bash
dsh-plugin-doctor check --json --strict
```

```json
{
  "tool": "dsh-plugin-doctor",
  "version": "0.1.0",
  "home": "C:\\Users\\you\\AppData\\Roaming\\dsh-desktop\\harness",
  "profile": "web",
  "hostVersion": "0.1.2-rc.1",
  "tree": { "entries": 153, "sections": 45, "enabled": 122, "dynamic": 2 },
  "counts": { "error": 2, "warn": 3, "info": 9 },
  "ok": false,
  "findings": [
    {
      "code": "D001",
      "severity": "error",
      "title": "patch entry is silently skipped (name mismatch)",
      "message": "…",
      "file": "…/cordis.patch.yml",
      "line": 30,
      "fix": "…"
    }
  ]
}
```

## How it works

- **Offline first.** `dsh --dump-config` composes the plugin tree *without
  importing any plugin*, so it works on an installation that cannot boot. The
  dump is analysed as a file, which also means `check --dump <file>` is fully
  reproducible and every fixture in `fixtures/` is a real capture from a real
  machine.
- **Line-oriented parsing, no YAML dependency.** Both formats are
  machine-generated to a fixed shape, so the parser reads a small number of known
  indents instead of pulling in a YAML library. That keeps the tool usable in the
  one situation where it matters most: a broken install with no `node_modules`.
- **Indent discipline as correctness.** The composed tree nests a `config:` block
  and an owner block inside every entry. Only indents 0, 2 and 4 are interpreted,
  so a nested `config.models[].id` can never be mistaken for a loader entry —
  there is a regression test for exactly that.
- **Exit codes are read, never guessed.** `0xC0000409` is a fail-fast abort;
  `0x40010004` is a normal termination. Conflating them sends you debugging a
  crash that never happened.
- **Logs are cumulative.** `harness.log` spans installations and upgrades, so
  "the install in use" is the path with the greatest last-seen position. Taking
  the first hit diagnoses a copy of the app you deleted months ago.

## Limitations

- `D008` checks **declared** dependencies and peers, not source imports. Scanning
  a minified bundle for `require("…")` produces nothing but noise.
- `D003` and `D011` need the per-entry `__dshPluginOwner` block, which older
  harness versions do not emit. Without it those checks stay silent rather than
  guessing.
- `!!js` expressions in `disabled:` cannot be evaluated statically. Such entries
  are reported as `dynamic` and excluded from enablement-dependent checks.
- `explain` matches known signatures only. An unfamiliar error is reported as
  unmatched instead of being forced into a category.

## Development

```bash
npm test          # node --test, no dependencies
```

CI runs the same command on Node 18, 20 and 22 across Linux and Windows, plus a
`cli` job that asserts the exit-code contract against the committed fixtures.

The suite runs against real captured artifacts in `fixtures/` — a composed tree,
a profile patch, DSH's own stderr (in UTF-16LE, exactly as PowerShell writes it),
and the market state — so parser regressions surface immediately.

## 中文速览

`dsh-plugin-doctor` 用来诊断 DSH 插件树冲突。DSH 的插件树由四层叠加而成
（bundle patch → profile patch → 市场 state → generation 投影），任何一层都能
悄悄覆盖另一层，而**症状往往不是原因**：

- 补丁条目里的 `name:` 和 bundle 里的对不上，DSH 会**整条跳过**，它下面的
  `config:` 永远不生效 —— 不报错、不崩溃，只是没作用；
- 市场把某插件标记为关闭，但 profile patch 又用 `disabled: false` 打开了它，
  每次启动市场还会重写 `dsh.profile.bundles`；
- 单例服务被注册两次（例如 `session-title`），整个插件树加载失败，
  桌面端直接进入安全模式。

常用命令：

```bash
node bin/dsh-plugin-doctor.js check      # 体检，只读，不改任何文件
node bin/dsh-plugin-doctor.js graph      # 打印合成后的插件树
node bin/dsh-plugin-doctor.js explain <日志文件>   # 解释日志里每一类报错
```

零依赖、无需构建，DSH 起不来的时候它照样能跑。

## License

MIT
