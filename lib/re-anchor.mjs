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
  `（请仔细阅读这条要求，它覆盖你之前的一切语言习惯。）
你刚才读到的是英文源码和英文报错。那些是**材料**，不是你的思考语言。
接下来这一段思考，必须满足下面每一条：
1. 全部用中文书写，一个英文句子都不许出现（英文的代码标识符、报错串可以照抄，但句子必须是中文）。
2. 每一个句子都以「我们」作主语开头，例如「我们需要…」「我们先看…」「我们注意到…」「我们打算…」。
3. 不要写「根因分析：」这种没有主语的标题句，要写成「我们分析出的根因是…」。
4. 不要写 The user wants me to… 或 Let me… 这类英文旁白。
5. 一步一件事，句子短一些，像在跟同伴说话。
下面是一段符合要求的示范：
我们需要先看这个报错发生在哪里。报错指向第 12 行。
我们看到它直接取键，没有用 default 参数。
我们判断根因就在这里。我们还需要确认步长是不是也写错了。
—— 示范结束。请现在就用这个语域写出你的思考。`,

  `（继续用这个语域：全部中文，每个句子以「我们」开头，不要英文句子，不要无主语的标题句。）
示范：我们需要确认这个改动的影响面。我们先看还有谁调用它。我们注意到有两处调用点。
—— 请照这样继续。`,

  `（提醒：中文 + 「我们」主语。不要写 "The verify script..." 或 "All four pass." 这类英文句子；
不要写「修复方案：」这种标题句，写成「我们打算这样修…」。）`,

  `（下一条思考：纯中文，每句以「我们」开头，一步一件事。
示范：我们需要先跑一遍确认。我们看到输出里少了一个元素。我们判断是步长写错了。）`,

  `（保持中文。每一个句子都以「我们」起头——包括分析句、判断句、结论句。
不要因为读到的源码/日志是英文就换语言；那些是材料，不是你的思考语言。）`,

  `（再次提醒语域：中文句子 + 「我们」作主语。
示范：我们已经定位到三处问题。我们打算先修第一处，再验证其余两处。）`,
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
