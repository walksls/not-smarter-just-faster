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
 *   seed: string            — 🛑 **2026-10-08 起不再生效**（见下）
 *   includeSubagents: boolean — 子代理是否也重整（默认 false）
 *
 * ── 🛑 2026-10-08：为什么不再给"可照抄的开头句" ──
 *
 * **原设计**：文案写「请先用中文写下下面这句作为你下一段思考的开头…「<seed>」」。
 *
 * **实测的代价**（一次全机扫描（只读会话日志），只读，扫全机会话日志）：
 *   本插件的种子句被模型**原样写进给用户看的正文** ——
 *   注入 16 次 / 思考里 31 次（正常）/ **正文里 16 次**，**漏出率 16/16 = 100%**，
 *   且都出现在正文第一句（涉及 2 个会话；同一份扫描里 `seed-graft` 漏了 79 次 / 74 个会话）。
 *   模型是**忠实执行**了"写下这句"，只是在可见通道里执行。
 *
 * ⚠️ **顺带否掉一条流传的推断**：「种子句是复读急停阀掐断的弹药」——
 *   急停阀判据是 `minRepeats: 25`（同一 ≤30 字符短单元重复 ≥25 次）且 `minShare ≥ 0.20`。
 *   24 个**真实退化块**全量重放（`tripwire-replay.mjs`，17/24 命中），**夺冠单元**是
 *   `好`×78 / `做`×28 / `写`×42 / `我们做`×89 / `Writing`×71 / `Let me write`×31 / `Emit`×51，
 *   **没有任何一块是种子句夺冠**；而种子句每次生成只出现 **1 次**，离 25 次差一个数量级
 *   ⇒ **数学上不可能触发**。所以本次改动**不是**为了消复读，是为了消正文里的脚手架套话。
 *
 * **改动**：把「抄这句话」换成「定语域」——不再提供可照抄的字符串。
 * 保留真正起作用的两件事（中文 + 「我们」作主语），句子内容让模型按任务自己说。
 *
 * ⚠️ **`config.seed` 现在是死配置**：仍会被读到、但**不再进入注入文本**。
 *    故意不改 `agent.cordis.yml`（改 yml 必须跑 `sync-agent-presets.mjs`，
 *    那脚本会写 `cordis.patch.yml` ⇒ `patchReload: live` ⇒ 有打瘸活跃会话工具面的前科：preset 段被热重载会让活跃会话的工具面当场失效）。
 *    **下一次跑同步脚本时**，请把 `seed:` 那一行连同注释一起删掉。
 *
 * ⚠️ 诚实边界：上面那张 A/B 表比的是「给种子 vs 什么都不给」，
 *    **没有**比「给一条不可抄的语域指令 vs 给可抄的开头句」。
 *    所以"语域指令同样有效"是**待验证**的，验证口径见本段末尾：
 *      ① 跑一次全机扫描（只读会话日志）
 *         ⇒「按固定句拆分」那两行的 `正文` 一列必须 → **0**；
 *      ② 量几个新会话的「我们」密度 ⇒ 「我们」密度不能明显低于改动前。
 */

import { isSubagent } from './delegation.mjs'

export const name = 'compact-reanchor'

export const inject = ['agents']

// 🛑 2026-10-08 移除 `DEFAULT_SEED` 常量与 `config.seed` 的读取 —— 理由见文件头。
// 历史留档（**不要再加回来**）：原开头句是
//   '我们需要接着刚才的排查往下走。我们先确认当前状态。'
// 它被模型原样写进用户可见正文 16 次 / 漏出率 100%（实测，`seed-leak-scan.mjs`）。

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

/**
 * 会话里**这次压缩之后**是否已经注入过重整种子。
 *
 * 🛑 2026-10-08 修 bug（真实事故：会话 a63ff73e，千星原创2D战斗）：
 *   原来用 `WeakMap<agent, seq>` 记「已重整到哪个压缩点」。那张表**只活在进程内存里**，
 *   会话一恢复 / web 一重启 / 插件一重载就空 ⇒ 只要会话里存在过压缩，
 *   下一次 pre-step 就会**再注入一次**，而文案却写着「上下文**刚刚**被压缩过」，
 *   还会**强制模型用固定句子开头**。
 *   实测该会话：压缩 4 次、注入 **7 次**（多 3 次，其中 05:09:05 那次正好落在
 *   思考链退化成复读之前）；另一个会话 `9e0eeced` 多 4 次。
 *   ⇒ 改成**无状态判定**：直接看会话事件流里「最后一次压缩之后有没有本插件的消息」。
 *   这样重启、恢复、多进程都不会重复注入。
 */
function alreadyAnchoredAfter(session, seq) {
  const events = eventsOf(session)
  for (let i = seq + 1; i < events.length; i += 1) {
    const event = events[i]
    if (event === null || typeof event !== 'object') continue
    if (event.type !== 'user/message') continue
    const kind = event.data?.source?.kind
    if (kind === `plugin:${name}`) return true
  }
  return false
}

export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false
  // ⚠️ 不读 config.seed：那条配置已停用（见文件头）。读了也给不出可照抄的句子。
  const includeSubagents = config.includeSubagents === true

  if (!enabled) return

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision

    if (agent === undefined || agent === null) return decision
    if (!includeSubagents && isSubagent(agent)) return decision

    const seq = lastCompactionSeq(agent.session)
    // 没有压缩过，或这次压缩之后已经重整过了（**无状态判定**，见上面的 bug 说明）。
    if (seq < 0) return decision
    if (alreadyAnchoredAfter(agent.session, seq)) return decision

    const text =
      '（上下文刚刚被压缩过，更早的对话已替换成摘要。' +
      '摘要可能是英文的——那只是**材料**，不是你的思考语言。\n' +
      '接下来继续用中文思考，每个句子以「我们」作主语开头；' +
      '第一句直接说清你接下来要确认的第一件事。\n' +
      '这条提醒只约束你的**思考**，不要复述它，也不要把它写进给用户看的正文。）'

    return {
      ...decision,
      messages: [
        ...decision.messages,
        freeze({
          id: newId(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: {
            kind: `plugin:${name}`,
            form: 'snapshot',
            sections: [{ name, text }],
          },
        }),
      ],
    }
  })
}
