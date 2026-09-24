/**
 * we-need-anchor / compact-reanchor — 压缩之后自动重新锚定。
 *
 * ── 为什么需要它 ──
 *
 * 上游 `dsh-anchored-standard` 的 issue #52 明确报告：
 * **「开启子 Agent 或压缩后增智失效，we need 会重新变为 Let me」**。
 *
 * 本机实测（模拟压缩后的上下文，n=6/条件）：
 *
 *   | 条件                       | 「我们」绝对次数 | 思维链长度 | 密度  |
 *   |----------------------------|---------------|-----------|-------|
 *   | A 压缩前（基线）             |     4.8       |    499    | 10.1  |
 *   | B 压缩后·英文摘要            |     1.5       |    136    | 12.4  |
 *   | C 压缩后·中文摘要            |     1.8       |     70    | 25.8  |
 *   | D 英文摘要 + 重整种子        |     3.0       |     80    | 43.1  |
 *   | E 中文摘要 + 重整种子        |     3.3       |     80    | 52.0  |
 *
 * 结论：
 *   · 压缩后「我们」的绝对次数掉到 1.5（基线的 1/3）——**风格确实被冲掉了**
 *   · 重新注入种子能把绝对次数拉回 3.0~3.3（基线的 2 倍于压缩后）
 *   · 而且重整后的思维链**更短（80 vs 499）**，符合「长度是漂移根因」的规律
 *
 * ⚠️ 诚实说明：密度的高数字（43.1/52.0）部分来自"分母小"（链条短）。
 *    用**绝对次数**衡量更公允——那个口径下收益约 2×，不是 3.5×。
 *
 * ── 触发时机 ──
 *
 * 监听会话事件里的 `compaction/end`（压缩完成），随后**在下一个 pre-step
 * 注入一次重整种子**。只注入一次，避免每步刷屏。
 *
 * 不依赖 compaction 插件的内部 API——只读会话事件流，
 * 所以即使压缩实现变化，本插件也能工作（读不到事件就不触发）。
 *
 * ── 配置（agent.cordis.yml 的 compact-reanchor 行）──
 *   enabled: boolean        — false 关闭（默认 true）
 *   seed: string            — 重整用的开头句
 *   includeSubagents: boolean — 子代理是否也重整（默认 false）
 */

import { isSubagent } from './delegation.mjs'

export const name = 'compact-reanchor'

export const inject = ['agents']

const DEFAULT_SEED =
  '我们需要接着刚才的排查往下走。我们先确认当前状态。'

function freeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) freeze(value[key])
    Object.freeze(value)
  }
  return value
}

function newId() {
  return globalThis.crypto.randomUUID()
}

function eventsOf(session) {
  if (session === undefined || session === null) return []
  try {
    if (typeof session.snapshotEvents === 'function') {
      const events = session.snapshotEvents()
      return Array.isArray(events) ? events : []
    }
    if (Array.isArray(session.events)) return session.events
  } catch {
    // 会话未物化。
  }
  return []
}

/** 会话里最后一次 compaction/end 的序号；没有则返回 -1。 */
function lastCompactionSeq(session) {
  let seq = -1
  let index = -1
  for (const event of eventsOf(session)) {
    if (event === null || typeof event !== 'object') continue
    index += 1
    if (event.type === 'compaction/end') seq = index
  }
  return seq
}

export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false
  const seed = typeof config.seed === 'string' && config.seed.trim().length > 0
    ? config.seed.trim()
    : DEFAULT_SEED
  const includeSubagents = config.includeSubagents === true

  if (!enabled) return

  /**
   * 每个 agent 记「已重整到哪个压缩点」。
   * 用序号而不是布尔值：会话可能压缩多次，每次都要重整。
   */
  const anchoredUpTo = new WeakMap()

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision

    if (agent === undefined || agent === null) return decision
    if (!includeSubagents && isSubagent(agent)) return decision

    const seq = lastCompactionSeq(agent.session)
    // 没有压缩过，或这次压缩已经重整过了。
    if (seq < 0) return decision
    if (anchoredUpTo.get(agent) === seq) return decision

    anchoredUpTo.set(agent, seq)

    const text =
      '（上下文刚刚被压缩过，更早的对话已替换成摘要。' +
      '摘要可能是英文的——那只是**材料**，不是你的思考语言。\n' +
      '接下来继续用中文思考，每个句子以「我们」作主语开头。' +
      '请先用中文写下下面这句作为你下一段思考的开头，然后顺着它继续：\n' +
      `「${seed}」\n` +
      '不要解释这句话，直接以它开头继续思考。）'

    return {
      ...decision,
      messages: [
        ...decision.messages,
        freeze({
          id: newId(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: {
            kind: 'plugin',
            plugin: name,
            form: 'snapshot',
            sections: [{ name, text }],
          },
        }),
      ],
    }
  })
}
