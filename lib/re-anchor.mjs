/**
 * we-need-anchor / re-anchor — 每一步重新锚定思考语言与句式。
 *
 * ── 为什么需要这个文件 ──
 *
 * 光靠 persona 治不了多轮漂移。实测（2026-09-20，真实多轮会话）：
 *   · persona 里写了「思考必须用中文、以我们需要开头」
 *   · 首轮 4 段思维链锚定成功
 *   · 但第 5 段开始，模型读了英文代码 / 英文报错 / 英文工具输出之后，
 *     直接崩成纯英文思考，「我们」密度掉到 2.5/千字符（截图基准是 7.6）
 *
 * 关键观察：那 6 段思维链**全在同一个 turn 里（step 1 → 7）**。
 * persona 只在会话开头说一次，而漂移发生在 turn 内部、每次读完工具输出之后。
 * 所以「每回合提醒一次」不够，必须**每一步都提醒**。
 *
 * ── 机制 ──
 *
 * 注册 `agent/pre-step` waterfall（与官方 time-context、本机 mom-cheer 同款），
 * 在每一步把一条 plugin 署名的 user 消息追加在用户消息之后——即模型应答前的
 * 近距离位置。消息以普通会话内容写入日志：resume 后仍在、可回放、参与 compaction。
 *
 * ⚠️ 与 mom-cheer 的关键差别：mom-cheer 只在 `step === 1` 注入（避免工具循环里
 * 堆积），而本插件**默认每一步都注入**（`minStep: 2` 跳过首步，首步已由 persona
 * 锚定）。这是刻意的：漂移发生在 step 之间，只在 step 1 注入等于没治。
 *
 * ── 2026-10-06 修正：删掉「请照这样继续」这类**祈使句尾** ──
 *
 * 起因是一起真实事故（session-c41a9661，千星2D，201 分钟、3 个 turn 被用户掐断）：
 * 那个会话的 turn 1 跑了 **133.7 分钟 / 71 步 / 一次汇报都没有**。而它的**思维链里
 * 三次写下「我应该停下来汇报」**（seq 404 / 428 / 458，还引用了"检查点已授权问用户"），
 * 三次都没停成 —— 因为它每一步应答前读到的**最后一条用户消息**，是这里注入的提醒，
 * 而旧语案里有两条以「**—— 请照这样继续。**」收尾。
 * ⇒ 那是**一条明确的"继续"指令**，正好压过模型自己"该收尾了"的判断。
 *
 * 改法（**只动文案，不动机制**：仍然是每一步注入、仍然主抓中文 + 「我们」）：
 *   ① 删掉所有祈使句尾（「请照这样继续」「请现在就用这个语域写出你的思考」）；
 *   ② 最长那条从 ~420 字压到 ~60 字，六条都变短 —— 短句更像"背景提醒"，
 *      不像"新的一轮用户发话"；
 *   ③ **反着加两条**：有结论就写出来给用户看 / 卡住超过一轮就停下汇报。
 *
 * ⚠️ **这是假设驱动的改动，不是已证实的改进。** 语言漂移的收益是实测过的
 * （「我们」密度 2.5 → 7.6 基准），这次只删措辞、没削弱频率，理论上收益不变；
 * 但"能不能让它停得下来"**只能靠 A/B 量**。口径见 项目笔记：
 *   语言漂移 → `style-metric.py`｜"每段有下一步动作" → `nextaction.py`｜
 *   停不下来/不汇报 → `session-vitals.py`（步数 · 可见字数 · 掐断率）。
 *
 * ── 配置（agent.cordis.yml 的 re-anchor 行）──
 *   lines: string[]      — 自定义提醒语；留空用内置
 *   everyNSteps: number  — 每 N 步注入一次（默认 1，即每一步）
 *   minStep: number      — 从第几步开始注入（默认 2：首步不打扰，persona 已锚定）
 *   maxPerTurn: number   — 每个 turn 最多注入几次（默认 0 = 不限制）
 *   includeSubagents: boolean — 子代理是否也注入（默认 false）
 *
 * 本文件位于 preset 目录内，只使用 Node 内建能力，不 import 任何裸包。
 * `.mjs` 后缀是必需的：preset 之上没有声明 type:module 的 package.json。
 */

import { isSubagent } from './delegation.mjs'

export const name = 're-anchor'

/** agents 注册表拥有 pre-step 处理权。 */
export const inject = ['agents']

/**
 * 内置提醒语：轮换使用，避免固定字符串被当成背景噪声。
 *
 * 每句都同时钉两件事：**语言**（中文）+ **主语**（我们）。
 * 这是实测出来的两个漂移点——模型会切换语言，也会丢掉主语。
 */
const DEFAULT_LINES = [
  `（思考用中文，每句以「我们」作主语。读到的英文代码/报错是**材料**，不是思考语言。）`,

  `（保持中文 + 「我们」主语。**有结论就写出来给用户看** —— 长任务别让他一直看不见进展。）`,

  `（提醒：中文，「我们」起头，一句一件事。）`,

  `（纯中文、「我们」起头。**卡住超过一轮就停下汇报或问人**，不要靠"再试一次"硬扛。）`,

  `（中文 + 「我们」主语。读完工具输出重新起思考时，也要重新捡起「我们」。）`,

  `（再次提醒：中文，「我们」作主语。一件事做完、或需要用户拍板时，**直接给结论并汇报**。）`,
]

/** 深冻结一条消息，符合 freezeMessage 契约。 */
function freeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) freeze(value[key])
    Object.freeze(value)
  }
  return value
}

/** 生成消息 id：Node 18+ 的全局 crypto 即满足 MessageId。 */
function newId() {
  return globalThis.crypto.randomUUID()
}

export function apply(ctx, config = {}) {
  const lines = Array.isArray(config.lines) && config.lines.length > 0
    ? config.lines.filter((l) => typeof l === 'string' && l.length > 0)
    : DEFAULT_LINES
  const usable = lines.length > 0 ? lines : DEFAULT_LINES

  const rawEvery = config.everyNSteps
  const everyNSteps = Number.isSafeInteger(rawEvery) && rawEvery > 0 ? rawEvery : 1
  const rawMin = config.minStep
  const minStep = Number.isSafeInteger(rawMin) && rawMin >= 1 ? rawMin : 2
  const rawMax = config.maxPerTurn
  const maxPerTurn = Number.isSafeInteger(rawMax) && rawMax > 0 ? rawMax : 0
  const includeSubagents = config.includeSubagents === true

  /** 每个 agent 每个 turn 已注入的次数。WeakMap 不阻止回收。 */
  const perTurn = new WeakMap()

  ctx.on('agent/pre-step', async ({ turn, step, agent, signal }, next) => {
    const decision = await next()
    // 下游已拒绝，或本轮已取消：不改变决定。
    if (decision.kind === 'reject' || signal.aborted) return decision

    // 子代理默认不注入：它们是执行者，风格要求不适用于它们。
    // ⚠️ 走 isSubagent()（session header），不要读 agent.delegationDepth（不存在）。
    if (!includeSubagents && isSubagent(agent)) return decision

    if (step < minStep) return decision
    if (everyNSteps > 1 && (step - minStep) % everyNSteps !== 0) return decision

    // 每 turn 上限（0 = 不限制）
    if (maxPerTurn > 0 && agent !== undefined && agent !== null) {
      const key = turn
      const seen = perTurn.get(agent)
      if (seen !== undefined && seen.turn === key) {
        if (seen.count >= maxPerTurn) return decision
        seen.count += 1
      } else {
        perTurn.set(agent, { turn: key, count: 1 })
      }
    }

    // 轮换选句：用 (turn, step) 混合索引，保证同一会话内不重样。
    const index = (Math.max(0, turn - 1) * 7 + Math.max(0, step - 1)) % usable.length
    const text = usable[index]

    // 替换式（2026-09-20 改）—— ⚠️ 注意：这不是性能优化，别被下面的注释误导
    //
    // 【背景】曾有人（含一个 v4-pro 顾问）判断：旧写法 `[...messages, 新提醒]`
    // 会让提醒在历史里累积，导致上下文线性增长、每次付全价的未缓存输入。
    //
    // 【实测结论：那个判断不成立】三条证据：
    //   1. 真实 harness 探针：新旧两版【完全一样】，每步 pre-step 里都只有
    //      1 条 re-anchor（58~421 字符），没有增长。
    //   2. inputTokens 序列：164,145,134,126,133,124,331,133 —— 不单调上升。
    //   3. 源码机制（dsh-agent-loop/lib/index.js:889、:1028）：
    //      pre-step 的 messages = `inbox.claim()` = **本步新认领的消息**，
    //      不含历史；注入的消息虽被 session.append 记录，但**不回流**到 claim()。
    //
    // 【那它有什么用】只让 append-only 的**会话日志**少写几条，
    // 对 token 成本、上下文长度、缓存命中都【没有任何影响】。
    //
    // 【为什么还留着】无害，且日志更干净。但**不要**把它当成优化手段，
    // 更不要基于「累积」这个错误前提去做别的推论。
    //
    // 移除时只删自己注入的（按 source.plugin 判定），别人的消息一条都不动。
    const withoutOurs = decision.messages.filter(
      (message) => !(message !== null && typeof message === 'object'
        && message.source !== null && typeof message.source === 'object'
        && message.source.plugin === name),
    )

    return {
      ...decision,
      messages: [
        ...withoutOurs,
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
