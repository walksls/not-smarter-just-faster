/**
 * we-need-anchor / anchor-gate — 首轮工具面锚定 + 自动放开。
 *
 * ── 这个文件解决什么问题 ──
 *
 * DeepSeek-V4.1-Flash 的「思维链风格」由 API 可见的首轮条件决定（上游
 * issue #11/#6 的受控实验，本机也复现过）：
 *   · 首轮只给 minimal 的两个工具 + 干净上下文 → 思维链是 "We need ..." 系
 *   · 首轮给标准工具面                        → 思维链是 "Let me ..." 系
 *
 * 但 minimal 预设只有 bash 一个工具，干活不够用。这个插件把两者拆开：
 *   阶段 1（首轮）：把工具面收窄到锚定对（bash + str_replace_editor），
 *                   让模型第一步走进 "We need" 轨迹；
 *   阶段 2（之后）：一旦会话出现第一个持久 tool/call，立刻恢复完整工具面。
 *
 * ── 实现要点（都踩过坑，改动前请先读）──
 *
 * 1. 钩子是 `system-prompt/assemble` 的 waterfall，签名是
 *    `(assembly, context, next) => Promise<assembly>`。
 *    ⚠️ 必须 **先 await next()** 拿到下游组装好的结果，再改它的 `tools`。
 *    先改再 next() 会被下游覆盖。
 *
 * 2. `assembly.tools` 是 `{name, description, parameters}[]`（见
 *    dsh-system-prompt/lib/index.js:322 的 schemas.map）。我们只做**白名单
 *    过滤**：保留 bootstrapTools 里点名的工具。不认识的工具一律隐掉。
 *
 * 3. 阶段判定读 `context.agent`（assembleContextFor 注入的，见
 *    dsh-agent/lib/index.js:258）。它有 `turn` / `step` / `session`。
 *    ⚠️ 不能用 turn===1 判定「首轮」——一个 turn 里模型可能先调工具、
 *    再走第二步，第二步的 turn 仍是 1 但工具必须已经放开。所以判定条件是
 *    **"会话里是否已存在持久事件"**，而不是轮次号。
 *    晋升信号 = `tool/call` **或** `assistant/message`（详见 hasPromotionSignal
 *    的注释：只认前者会把纯文本回答的会话永久锁死）。
 *
 * 4. `session.snapshotEvents()` 返回冻结副本（dsh-session 0.1.3+）。
 *    老版本用 `session.events`。两个都兼容，见 eventsOf()。
 *
 * 5. 一旦晋升就**记住**（per-agent WeakSet）。事件扫描只做一次，
 *    不在每一步重复扫全量历史。
 *
 * 6. 兜底：如果 bootstrapTools 里点名的工具在完整目录里一个都不存在
 *    （比如宿主没装 str_replace_editor），插件**放弃锚定**、直接放行全部
 *    工具，并 warn 一次。绝不能让一个 composition 漂移把会话卡死在两个工具上。
 *
 * 7. 本文件在 preset 目录内，**不能 import 任何裸包**（preset 目录下没有
 *    node_modules）。只用 Node 内建能力。
 *    `.mjs` 后缀是必需的：preset 之上没有声明 type:module 的 package.json，
 *    `.js` 会按 CommonJS 解析而无法使用 ESM 语法。
 *
 * 配置（agent.cordis.yml 的 anchor-gate 行）：
 *   bootstrapTools: string[]  — 首轮保留的工具名（默认 bash + str_replace_editor）
 *   enabled: boolean          — false 时完全不干预（默认 true）
 *   includeSubagents: boolean — 子代理是否也走锚定阶段（默认 false）
 *   debug: boolean            — true 时在 logger 里打印每次判定（默认 false）
 */

import { isSubagent } from './delegation.mjs'

export const name = 'anchor-gate'

/** agents 注册表 + logger 由宿主提供。 */
export const inject = ['agents']

const DEFAULT_BOOTSTRAP_TOOLS = ['bash', 'str_replace_editor']

/** 已经晋升过的 agent。WeakSet 不阻止回收，也不会跨会话串味。 */
const promoted = new WeakSet()

/** 已经警告过「锚定对不可用」的 agent，避免每步刷屏。 */
const warned = new WeakSet()

/**
 * 取会话事件列表，兼容新旧两代 DSH。
 *
 * dsh-session 0.1.3-alpha.1 起 `session.events` 被 `snapshotEvents()` 取代
 * （冻结副本，每次 append 失效缓存）。老版本没有该方法。
 */
function eventsOf(session) {
  if (session === undefined || session === null) return []
  try {
    if (typeof session.snapshotEvents === 'function') {
      const events = session.snapshotEvents()
      return Array.isArray(events) ? events : []
    }
    if (Array.isArray(session.events)) return session.events
  } catch {
    // 会话还没物化，或快照失败：当作"没有事件"处理。
  }
  return []
}

/**
 * 会话里是否已经出现晋升信号。
 *
 * ⚠️ 两个信号缺一不可，这是踩过的坑：
 *   · `tool/call`       —— 模型动了手，正常晋升路径。
 *   · `assistant/message` —— **纯文本回答也必须晋升**。
 * 只认 tool/call 会有一个真实的死锁：用户问一句"2+2 等于几"，模型直接文字回答、
 * 不调工具 → 永远不晋升 → 会话被永久锁在 2 个工具上，之后任何需要 web_search /
 * subagent 的任务都做不了。
 *
 * 上游 anchor-standard 的 `promoteOn: either` 就是为这个问题设的默认值。
 * 这里固定用 either 语义，不开放配置——因为它没有合理的关闭理由。
 */
function hasPromotionSignal(session) {
  for (const event of eventsOf(session)) {
    if (event === null || typeof event !== 'object') continue
    if (event.type === 'tool/call' || event.type === 'assistant/message') return true
  }
  return false
}

/** 日志安全取值：ctx.logger 在宿主里一定存在，但 preset 可能跑在裁剪过的 ctx 上。 */
function makeLogger(ctx) {
  const log = ctx?.logger
  return {
    info: (msg) => { try { log?.info?.(msg) } catch {} },
    warn: (msg) => { try { log?.warn?.(msg) } catch {} },
  }
}

export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false
  const debug = config.debug === true
  const includeSubagents = config.includeSubagents === true
  const bootstrapTools = Array.isArray(config.bootstrapTools) && config.bootstrapTools.length > 0
    ? config.bootstrapTools.filter((n) => typeof n === 'string' && n.length > 0)
    : DEFAULT_BOOTSTRAP_TOOLS
  const allowed = new Set(bootstrapTools)
  const logger = makeLogger(ctx)

  if (!enabled) return

  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    // ⚠️ 顺序关键：先让下游组装完，再改它的结果。
    const assembled = await next()
    if (assembled === null || typeof assembled !== 'object') return assembled

    const agent = context?.agent
    if (agent === undefined || agent === null) return assembled

    // 子代理默认不参与锚定：它们是执行者，首轮就该有完整工具。
    // ⚠️ 判定必须走 isSubagent()（session header），不能读 agent.delegationDepth——
    //    后者在 agent 对象上不存在，会让判定恒为 false（踩过）。
    if (!includeSubagents && isSubagent(agent)) return assembled

    // 已经晋升过：原样放行，一步都不多花。
    if (promoted.has(agent)) return assembled

    const tools = Array.isArray(assembled.tools) ? assembled.tools : null
    if (tools === null) return assembled

    // ── 晋升判定（tool/call 或首条 assistant/message，见 hasPromotionSignal）──
    if (hasPromotionSignal(agent.session)) {
      promoted.add(agent)
      if (debug) logger.info(`[${name}] 晋升：检测到持久事件，恢复完整工具面（${tools.length} 个）`)
      return assembled
    }

    // ── 锚定阶段：白名单过滤 ────────────────────────────────────────────
    const kept = tools.filter((tool) => tool !== null && typeof tool === 'object' && allowed.has(tool.name))

    // 兜底：锚定对在当前目录里一个都不存在 → 放弃锚定，放行全部。
    if (kept.length === 0) {
      if (!warned.has(agent)) {
        warned.add(agent)
        logger.warn(
          `[${name}] 锚定对 [${bootstrapTools.join(', ')}] 在当前工具目录里不存在，` +
          `已放弃锚定并放行全部 ${tools.length} 个工具。请检查 anchor-gate 行的 bootstrapTools 配置。`,
        )
      }
      promoted.add(agent)
      return assembled
    }

    if (debug) {
      logger.info(`[${name}] 锚定中：${tools.length} → ${kept.length} 个工具 [${kept.map((t) => t.name).join(', ')}]`)
    }

    return { ...assembled, tools: kept }
  })
}
