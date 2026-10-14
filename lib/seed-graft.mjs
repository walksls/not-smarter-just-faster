/**
 * we-need-anchor / seed-graft — 在会话开头植入一条中文「我们」思考示范。
 *
 * ── 为什么需要它 ──
 *
 * 实测（n=8/条件，真实多轮 agent 任务，客观判据=测试是否全绿）：
 *
 *   | 条件                | 任务通过 | 中文占比 | 思维链密度 |
 *   |---------------------|---------|---------|-----------|
 *   | 基线（本预设）        |  8/8    |   53%   |    6.5    |
 *   | + 本插件（种子示范）   |  8/8    |   52%   |    9.8    |
 *   | + 本插件 + temp 0.1  |  8/8    |   59%   |   12.5    |
 *
 * 质量零损失，密度最高提升 1.93×。
 *
 * ── 机制 ──
 *
 * 模型的语言选择是「继续最近的文本」。会话开头如果只有英文工具输出，
 * 它就开始用英文想；如果开头就有一条**它自己的**中文「我们」思考，
 * 后面的思考会顺着这个语域走。这比在 system prompt 里下命令更强——
 * 因为那是"别人要求我"，而这是"我刚才就是这么想的"。
 *
 * 实测确认：模型不会察觉这是植入的（对照试验里「中文化观察层」方案
 * 会让模型怀疑上下文被伪造，本方案没有这个副作用）。
 *
 * ── 实现要点（踩过的坑）──
 *
 * 1. 挂在 `agent/pre-step`，只在 **turn === 1 && step === 1** 注入一次。
 *    注入的是 assistant 角色的消息——注意 pre-step 的 messages 是
 *    "claimed" 批次（用户消息），直接往里面塞 assistant 消息会让顺序变成
 *    [assistant, user]，模型读到的是"我先想了，然后用户才说话"，顺序错乱。
 *    ⚠️ 所以本插件改为注入**user 角色的元指令**，让模型自己产出第一条
 *    「我们」思考——这是实测有效的形式（见 exp_combo2 的 T2 实现：
 *    它在历史里放 assistant+reasoning_content，但那是**跨会话**的形式，
 *    单次会话内做不到，因为 pre-step 拿不到已写好的 assistant 消息）。
 *
 *    等等——实测里 T2 的做法正是"历史里有 assistant reasoning"，那是通过
 *    多轮累积实现的。会话第一轮没有历史，所以本插件用**元指令**达到近似效果：
 *    明确要求"你的第一段思考，先原样写下这句中文示范，再继续"。
 *
 * 2. 只在首轮注入：后续轮次已经有真实的中文思考历史，不需要再加。
 *
 * 3. 配置（agent.cordis.yml 的 seed-graft 行）：
 *      seed: string       — 🛑 **2026-10-08 起不再生效**（见下）
 *      enabled: boolean   — false 关闭（默认 true）
 *      includeSubagents   — 子代理是否也植入（默认 false）
 *
 * ── 🛑 2026-10-08：为什么不再给"可照抄的示范句" ──
 *
 * **原设计**：指令写「你的第一段内部思考请先用中文写下下面这句…「<seed>」」，
 * 靠一条具体的示范句把语域钉进中文「我们」。
 *
 * **实测的代价**（一次全机扫描（只读会话日志），只读，扫全机会话日志）：
 *   seed-graft 的示范句**被模型原样写进了给用户看的正文**——
 *   注入 86 次 / 思考里 126 次（正常）/ **正文里 79 次**，其中绝大多数是**正文第一句**，
 *   一共**漏过 74 个会话**（漏出率 ≈ 每次注入都漏）。
 *   用户看到的第一句话因此变成「我们需要先复现这个问题。我们先看一遍现场，再决定怎么做。」
 *   这种**内部脚手架套话**——是真实的质量缺陷，不是无害噪声。
 *
 * **改动**：把「抄这句话」换成「定语域」——**不再提供可照抄的字符串**，
 * 只保留真正起作用的两件事（中文 + 「我们」作主语）。句子的具体内容让模型自己按任务说。
 *
 * ⚠️ **`config.seed` 现在是死配置**：仍然会被读到、但**不再进入注入文本**。
 *    故意不改 `agent.cordis.yml`（改 yml 必须跑 `sync-agent-presets.mjs`，
 *    那脚本会写 `cordis.patch.yml` ⇒ `patchReload: live` ⇒ 有打瘸活跃会话工具面的前科：preset 段被热重载会让活跃会话的工具面当场失效）。
 *    **下一次跑同步脚本时**，请把 `seed:` 那一行连同注释一起删掉。
 *
 * ⚠️ 诚实边界：本插件原来的 A/B 比的是"给示范句 vs 什么都不给"，
 *    **没有**比"给一条不可抄的语域指令 vs 给可抄的示范句"。
 *    所以"语域指令同样有效"是**待验证**的。验证口径（重启后跑，两条都要对）：
 *      ① 跑一次全机扫描（只读会话日志）
 *         ⇒「按固定句拆分」那两行的 `正文` 一列必须 → **0**；
 *      ② 量几个新会话的「我们」密度
 *         ⇒ 密度**不能明显低于**改动前 —— 这是唯一有可能变差的地方。
 */

import { isSubagent } from './delegation.mjs'

export const name = 'seed-graft'

export const inject = ['agents']

// 🛑 2026-10-08 移除 `DEFAULT_SEED` 常量与 `config.seed` 的读取 —— 理由见文件头。
// 历史留档（**不要再加回来**）：原示范句是
//   '我们需要先复现这个问题。我们先看一遍现场，再决定怎么做。'
// 它被模型原样写进用户可见正文 79 次 / 74 个会话（实测，`seed-leak-scan.mjs`）。

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

export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false
  // ⚠️ 不读 config.seed：那条配置已停用（见文件头）。读了也给不出可照抄的句子。
  const includeSubagents = config.includeSubagents === true

  if (!enabled) return

  /** 每个 agent 只植入一次。 */
  const grafted = new WeakSet()

  ctx.on('agent/pre-step', async ({ turn, step, agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision

    // 只在会话的第一步做，且每个 agent 只做一次。
    if (turn !== 1 || step !== 1) return decision
    if (agent === undefined || agent === null) return decision
    if (grafted.has(agent)) return decision

    // ⚠️ 走 isSubagent()（session header），不要读 agent.delegationDepth（不存在）。
    if (!includeSubagents && isSubagent(agent)) return decision

    grafted.add(agent)

    const text =
      '（开始之前先定语域：你的**第一段内部思考**用中文写，' +
      '每一句以「我们」作主语，第一句直接说清你接下来要确认的第一件事。\n' +
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
