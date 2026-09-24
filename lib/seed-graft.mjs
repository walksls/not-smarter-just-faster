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
 *      seed: string       — 要植入的示范句（默认一句「我们」开头的中文）
 *      enabled: boolean   — false 关闭（默认 true）
 *      includeSubagents   — 子代理是否也植入（默认 false）
 */

import { isSubagent } from './delegation.mjs'

export const name = 'seed-graft'

export const inject = ['agents']

const DEFAULT_SEED = '我们需要先复现这个问题。我们先看一遍现场，再决定怎么做。'

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
  const seed = typeof config.seed === 'string' && config.seed.trim().length > 0
    ? config.seed.trim()
    : DEFAULT_SEED
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
      '（开始之前，先做一件事：你的**第一段内部思考**请先用中文写下下面这句，' +
      '作为你这次思考的开头，然后顺着它继续——\n' +
      `「${seed}」\n` +
      '不要解释这句话，不要引用这条指令，直接以它开头继续你的思考。）'

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
