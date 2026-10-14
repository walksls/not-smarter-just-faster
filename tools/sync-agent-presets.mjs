#!/usr/bin/env node
/**
 * sync-agent-presets.mjs —— 把老式 preset 目录同步成 0.2.0-rc.2 认的声明式条目。
 *
 * 背景（2026-10-03，DSH 0.1.5-rc.2 → 0.2.0-rc.2 升级当天）：
 *   旧版由 `@deepseek-ai/dsh-agent-presets` **扫描目录** `<DSH_HOME>/.agent-presets/<id>/`，
 *   读 `agent.cordis.yml`（插件行清单）+ `preset.yml`（name/description/order）来挂载模式。
 *   新版把这个包整个删掉，换成 `dsh-agent-preset-registry`：**只认声明，不扫目录**
 *   （其 README 原话：「注册表不扫描目录，也不接受 preset 路径」）。于是用户自建模式
 *   全部消失，必须在 profile 的 `cordis.patch.yml` 里写一条
 *   `@deepseek-ai/dsh-agent-preset` 条目才行。
 *
 * 本脚本做的事：
 *   读 `<DSH_HOME>/.agent-presets/<id>/`，把每个目录转成一条声明，写进
 *   `<DSH_HOME>/profiles/web/cordis.patch.yml` 里带 BEGIN/END 标记的一段。
 *   目录仍是唯一源；改完目录跑一次本脚本，然后**重启 dsh web**。
 *
 * 🛑 为什么是"重启"而不是"刷新页面"（2026-10-03 真实事故）：
 *   这段里含 `- id: agent-preset-registry` 的覆盖。它是配置，所以改文件会触发
 *   `patchReload: live` —— 而**热重载那一条会让注册表服务被销毁重建**，于是
 *   **所有活跃会话的 preset 面工具当场消失**（bash/write/read/edit 全变
 *   `unknown tool`，子代理也一样；MCP 等宿主面工具不受影响）。
 *   实测就是这么把操作者自己的会话打瘸的，只能靠用户重启 dsh web 恢复。
 *   另外 preset 的 `lib/*.mjs` 是 ESM（按 URL 缓存），**改代码也只能靠重启生效**。
 *
 * 三处必须的改写（不改模式挂不上）：
 *   1. `name: ./lib/x.mjs` → 绝对路径。新注册表按**声明所在配置文件的目录**解析相对名，
 *      不再按 preset 目录解析。
 *   2. `!!js ... new URL('skills/', baseUrl)` → 绝对路径字面量。同理，`baseUrl` 现在是
 *      profile 目录，不是 preset 目录。
 *   3. `@deepseek-ai/dsh-workflow-worker-thread` → `@deepseek-ai/dsh-workflow-ptc`
 *      （rc.2 把该包改名了；不改则整条 preset 挂载失败）。
 *
 * 用法：
 *   node tools/sync-agent-presets.mjs                 # 写入（先自动备份，幂等）
 *   node tools/sync-agent-presets.mjs --check         # 只检查/预览，不写
 *   node tools/sync-agent-presets.mjs --force    # 宿主层已挂同名插件时仍然写入（会双实例）
 * 环境变量：DSH_HOME / PRESET_PATCH（默认 web profile）/ PRESET_DEFAULT（默认模式 id）
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = (process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh');
const PRESET_ROOT = join(HOME, '.agent-presets');
const PATCH = (process.env.PRESET_PATCH ?? '').trim() || join(HOME, 'profiles', 'web', 'cordis.patch.yml');
const DEFAULT_PRESET = (process.env.PRESET_DEFAULT ?? 'we-need').trim();
const CHECK = process.argv.includes('--check');
const FORCE = process.argv.includes('--force');

const BEGIN = '# ══════════ BEGIN generated agent presets（sync-agent-presets.mjs 生成，勿手改）══════════';
const END = '# ══════════ END generated agent presets ══════════';
/** 组成行在生成的 YAML 里的缩进：`- insert:` → 4 → 6 → `config:` 8 → `plugins:` 8 → 行 10。 */
const INDENT = ' '.repeat(10);

/** rc.2 改过名的包：老 preset 文件里的旧名 → 新名。以后升级再遇到就在这里补一行。 */
const RENAMES = [['@deepseek-ai/dsh-workflow-worker-thread', '@deepseek-ai/dsh-workflow-ptc']];

const problems = [];
const notes = [];
const say = (msg) => process.stdout.write(`${msg}\n`);

/** 最小的 `key: value` 解析器：preset.yml 只有 name/description/order 三行简单标量。 */
function readMeta(dir, id) {
  const file = join(dir, 'preset.yml');
  if (!existsSync(file)) return {};
  const meta = {};
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (line === '' || line.startsWith('#')) continue;
    const at = line.indexOf(':');
    if (at < 0) {
      problems.push(`${id}/preset.yml: 看不懂这一行（只支持单行 key: value）：${line}`);
      continue;
    }
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if (value.startsWith('"') || value.startsWith("'")) value = value.slice(1, -1);
    if (key === 'order') {
      const n = Number(value);
      if (!Number.isFinite(n)) problems.push(`${id}/preset.yml: order 不是数字：${value}`);
      else meta.order = n;
    } else if (key === 'name') meta.name = value;
    else if (key === 'description') meta.description = value;
  }
  return meta;
}

/** 把一份老式 composition 的原文改写成新版可用的形式，返回行数组。 */
function rewriteComposition(text, dir, id) {
  const out = [];
  const abs = (rel) => join(dir, rel);
  for (const line of text.split('\n')) {
    let next = line;
    // 1) 相对插件名 → 绝对路径
    const rel = /^(\s*-?\s*name:\s*)(\.\.?\/\S+)\s*$/.exec(next);
    if (rel) next = `${rel[1]}${abs(rel[2])}`;
    // 2) skills 的 !!js 表达式 → 绝对路径字面量
    next = next.replace(
      /!!js\s+"process\.getBuiltinModule\('node:url'\)\.fileURLToPath\(new URL\('([^']+)',\s*baseUrl\)\)"/g,
      (_m, p) => `'${abs(p)}'`,
    );
    // 3) rc.2 改名的包
    for (const [from, to] of RENAMES) next = next.split(from).join(to);
    out.push(next);
  }
  const joined = out.join('\n');
  if (/new URL\([^)]*baseUrl\)/.test(joined)) problems.push(`${id}: 仍有依赖 baseUrl 的表达式没改写，见上方 grep`);
  if (/^(\s*-?\s*name:\s*)\.\.?\//m.test(joined)) problems.push(`${id}: 仍有相对插件名没改写`);
  return out;
}

/**
 * 🛑 宿主层冲突检查（2026-10-15 加）：同一个 `.mjs` 如果已经被 BEGIN/END 之外的行挂载，
 * preset 段里再启用一份就是**双实例** —— 两个插件各跑一遍（对 thinking-guard 是折叠两次，
 * 对 escape-valve 是 cancel 两次）。只检测、只报告，不改任何东西。
 * 判据：路径相同 且 preset 段这条不是显式 `enabled: false`（显式关掉 = 刻意保留的对照组，不算冲突）。
 */
function findHostConflicts(block, patchText) {
  const b = patchText.indexOf(BEGIN);
  const e = b >= 0 ? patchText.indexOf(END, b) : -1;
  const outside = b >= 0 && e > b ? patchText.slice(0, b) + patchText.slice(e) : patchText;
  const hostPaths = new Set(
    [...outside.matchAll(/^\s*-?\s*name:\s*(\S*\.mjs)\s*$/gm)].map((m) => m[1]),
  );
  if (hostPaths.size === 0) return [];
  const out = [];
  let cur = null;
  for (const line of block.split('\n')) {
    if (/^ {10}- id: \S/.test(line)) {
      cur = { id: line.trim().replace(/^-\s*id:\s*/, ''), path: undefined, off: false };
      out.push(cur);
      continue;
    }
    if (cur === null) continue;
    if (cur.path === undefined) {
      const nm = /^\s*-?\s*name:\s*(\S*\.mjs)\s*$/.exec(line);
      if (nm !== null) cur.path = nm[1];
    }
    if (/^\s*enabled:\s*false\s*$/.test(line)) cur.off = true;
  }
  return out.filter((x) => x.path !== undefined && !x.off && hostPaths.has(x.path));
}

function buildBlock(entries) {
  const head = [
    BEGIN,
    '# 由 sync-agent-presets.mjs 从 <DSH_HOME>/.agent-presets/ 生成。',
    '# 编辑模式请改那边的 agent.cordis.yml / preset.yml，然后重跑脚本；本段会被整段替换。',
    '# 生效方式：**重启 dsh web**（不是刷新页面）——理由见本脚本头部。',
  ];
  const lines = [];
  if (DEFAULT_PRESET) {
    lines.push(
      '# 默认模式（新会话用哪个）。旧版写在 settings.yaml 的 agent-presets.default，',
      '# 0.2 的迁移器找不到同 id 条目、把那段跳过了，所以在这里补回来。',
      '- id: agent-preset-registry',
      '  config:',
      `    default: ${DEFAULT_PRESET}`,
      '',
    );
  }
  for (const e of entries) {
    lines.push(
      `# ── ${e.id}：${e.name ?? '(无 name)'}${e.order === undefined ? '' : `（order ${e.order}）`} ──`,
      '- insert:',
      `    - id: preset-${e.id}`,
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      `        id: ${e.id}`,
    );
    if (e.name !== undefined) lines.push(`        name: ${JSON.stringify(e.name)}`);
    if (e.description !== undefined) lines.push(`        description: ${JSON.stringify(e.description)}`);
    if (e.order !== undefined) lines.push(`        order: ${e.order}`);
    lines.push('        plugins:');
    for (const l of e.body) lines.push(l === '' ? '' : INDENT + l);
    lines.push('');
  }
  /**
   * 源指纹 = 生成内容的哈希（不含指纹行/时间行）。
   *
   * 为什么要它：rc.2 的设置界面写任何配置都会用 YAML 库**整体重排** profile 的
   * `cordis.patch.yml`（实测 `inject: [agents]` → `inject: [ agents ]`、块标量缩进也变），
   * 于是"字节比对"会把一次正常写设置误判成"源变了" → 脚本重写一遍 →
   * 触发一次热重载（正是本脚本头部警告的那个会拆掉活跃会话工具面的动作）。
   * 指纹只随**源文件内容**变化，外部重排不影响它。
   */
  const fingerprint = createHash('sha256').update([...head, ...lines].join('\n')).digest('hex').slice(0, 16);
  return [...head, `# 源指纹：${fingerprint}`, `# 生成时间：${new Date().toISOString()}`, '', ...lines, END].join('\n');
}

// ── 收集并转换 ───────────────────────────────────────────────────────────────
if (!existsSync(PRESET_ROOT)) {
  say(`✗ 找不到 preset 目录：${PRESET_ROOT}`);
  process.exit(1);
}
const entries = [];
for (const id of readdirSync(PRESET_ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(d.name))
  .map((d) => d.name)
  .sort()) {
  const dir = join(PRESET_ROOT, id);
  const composition = join(dir, 'agent.cordis.yml');
  if (!existsSync(composition)) {
    problems.push(`${id}: 缺 agent.cordis.yml（这个目录不会被同步）`);
    continue;
  }
  const meta = readMeta(dir, id);
  entries.push({ id, ...meta, body: rewriteComposition(readFileSync(composition, 'utf8').replace(/\n+$/, ''), dir, id) });
}
entries.sort((a, b) => (a.order ?? Number.POSITIVE_INFINITY) - (b.order ?? Number.POSITIVE_INFINITY) || a.id.localeCompare(b.id));

if (!existsSync(PATCH)) {
  say(`✗ 找不到 profile 配置：${PATCH}`);
  process.exit(1);
}
const before = readFileSync(PATCH, 'utf8');
const block = buildBlock(entries);

/** 🛑 双实例检查：宿主层（BEGIN/END 之外）已挂的插件，preset 段里不该再启用一份。 */
const hostConflicts = findHostConflicts(block, before);
if (hostConflicts.length > 0 && !FORCE) {
  say('\n🛑 宿主层已经挂了这些插件，preset 段里再启用就成了双实例：');
  for (const c of hostConflicts) say(`  ✗ ${c.id}  →  ${c.path}`);
  say('  出路：① 把 preset 源里那条改成 `enabled: false`（宿主层已在生效，不必再挂一份）；');
  say('        ② 确认你就是要两份，加 `--force` 重跑。');
  say('  ⚠️ 这份 preset 目录若同时用于发布：别人的机器没有宿主层，需要 enabled: true。');
  say('     所以别直接改目录里的源文件，改 profile 这一份，或在发布前改回来。');
  say('  未写入（配置文件一字未动）。');
  process.exit(4);
}
if (hostConflicts.length > 0) {
  say('\n⚠️ --force：宿主层已挂，仍然写入 ⇒ 会双实例：');
  for (const c of hostConflicts) say(`  ⚠ ${c.id}  →  ${c.path}`);
}
const beginAt = before.indexOf(BEGIN);
let after;
if (beginAt >= 0) {
  const endAt = before.indexOf(END, beginAt);
  if (endAt < 0) {
    say('✗ 配置文件里有 BEGIN 标记却没有 END 标记，不敢动它。请先手工修好那一段。');
    process.exit(1);
  }
  after = before.slice(0, beginAt) + block + before.slice(endAt + END.length);
} else {
  const dupes = entries.filter((e) => new RegExp(`^\\s*-?\\s*id:\\s*preset-${e.id}\\b`, 'm').test(before));
  if (dupes.length > 0) {
    say(`✗ 配置里已经存在这些 preset 条目但没有本脚本的标记：${dupes.map((d) => d.id).join(', ')}`);
    say('  再追加会撞 id（loader 报 duplicate）。请先手工删掉那些旧条目，或把它们纳入本脚本管理。');
    process.exit(1);
  }
  after = `${before.replace(/\s*$/, '')}\n\n${block}\n`;
}

say(`preset 目录：${PRESET_ROOT}`);
for (const e of entries) {
  const rewrites = [];
  if (e.body.some((l) => l.includes(PRESET_ROOT))) rewrites.push('相对路径→绝对');
  if (e.body.some((l) => l.includes('dsh-workflow-ptc'))) rewrites.push('workflow-worker-thread→workflow-ptc');
  say(`  · ${e.id.padEnd(22)} ${String(e.body.length).padStart(4)} 行  ${e.name ?? ''}  ${rewrites.length ? `[${rewrites.join('、')}]` : ''}`);
}
for (const n of notes) say(`  ⚠ ${n}`);
if (problems.length > 0) {
  say('\n发现问题，未写入：');
  for (const p of problems) say(`  ✗ ${p}`);
  process.exit(2);
}

if (after === before) {
  say('\n配置已是最新，无需改动。');
  process.exit(0);
}
/**
 * 判等以**源指纹**为准（见 buildBlock 里的说明）：
 * 指纹一致 = 源文件没变，无论文件被 GUI 重排成什么样，都不重写、不触发热重载。
 */
const fingerprintOf = (text) => (text.match(/^# 源指纹：([0-9a-f]{16})$/m) ?? [])[1];
const current = fingerprintOf(before);
const wanted = fingerprintOf(block);
if (current !== undefined && current === wanted) {
  say('\n源指纹一致（配置已是最新）——原文件保持不动，不写入、不触发热重载。');
  if (before !== after) say('  （文件被 GUI/YAML 重排过，属正常；重排不影响语义。）');
  process.exit(0);
}
/** 老版本脚本写的段没有指纹行：退化成"忽略时间行"的文本比对。 */
const stripStamp = (text) => text.replace(/^# 生成时间：.*$/m, '');
if (current === undefined && stripStamp(after) === stripStamp(before)) {
  say('\n配置已是最新，无需改动（仅生成时间不同，保持原文件不动）。');
  process.exit(0);
}
if (CHECK) {
  say(`\n--check：配置需要更新（${before.length} → ${after.length} 字节），未写入。`);
  process.exit(3);
}

mkdirSync(join(HOME, 'backups'), { recursive: true });
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backup = join(HOME, 'backups', `cordis.patch.yml.bak-${stamp}-preset-sync`);
copyFileSync(PATCH, backup);
writeFileSync(PATCH, after);
say(`\n✓ 已写入 ${PATCH}`);
say(`  备份：${backup}`);
say('  ⚠ 生效方式：**请让用户重启 dsh web**（用你平时拉起 dsh web 的方式）。');
say('    不要指望热重载：本段含 agent-preset-registry 覆盖，热重载会拆掉所有活跃会话的工具面。');
