/**
 * we-need-anchor / subagent-brief — 让子代理「有风格 + 报告简短」。
 *
 * ── 为什么需要它（实测依据）──
 *
 * 子代理实验（n=5/条件）：
 *   | 条件                | 子代理思维链密度 | 子代理报告中文占比 |
 *   |---------------------|----------------|------------------|
 *   | A 无风格             |      3.7       |       20%        |
 *   | B 有风格(seed+提醒)   |     10.2       |       73%        |
 *   | C 有风格 + 要求中文报告 |     10.7       |       92%        |
 *
 * 2×2 受控对照（报告语言 × 报告长度，n=6/格）——父会话被影响的程度：
 *   | 变量        | 短      | 长      | 影响 |
 *   |-------------|---------|---------|------|
 *   | 报告长度     | 14.0    | 11.1    | **主因** |
 *   | 报告语言     | 中文 13.5 | 英文 11.6 | 次要，但中文更好 |
 *
 * 结论：**让子代理有风格、并且报告简短**，对父会话最有利。
 * 报告越长，父会话越懒得重新组织，直接顺着报告的语域写。
 *
 * ── fork 模式也需要本插件（实测，n=6/条件）──
 *
 * 曾假设「fork 子代理继承父会话历史，所以天然有风格」——**实测推翻了**：
 *   | 条件              | 思维链密度 | 思维链长度 |
 *   |-------------------|-----------|-----------|
 *   | spawn 无注入       |    3.7    |   1658    |
 *   | fork  无注入       |    0.4    |   6388    |  ← 最差
 *   | fork + 本插件注入   |    5.2    |   1586    |  ← 最好
 *
 * 根因：fork 继承了父会话的**长上下文**，思考长度是 spawn 的 3.9 倍；
 * 而思考越长越容易滑回英文（本项目已多次验证的铁律）。
 * 即 fork 继承的是"漂移的温床"，不是"风格"。
 *
 * 好在判定走 isSubagent()（delegationDepth），**spawn 和 fork 都会被识别**，
 * 所以本插件无需区分两种模式。
 *
 * ── 实现 ──
 *
 * 挂在 `agent/pre-step`，对**子代理**（delegation depth > 0）注入两条要求：
 *   1. 用中文「我们」语域思考（与父会话一致）
 *   2. **最终报告要简短**——这条是重点，长度才是污染父会话的主因
 *
 * ⚠️ 子代理判定必须走 `isSubagent()`（读 session header.delegationDepth）。
 *    第一版误读 `agent.delegationDepth`（该字段不存在），导致判定恒为 false，
 *    子代理一直没被正确处理——探针实测确认后修复。
 *
 * ── 配置（agent.cordis.yml 的 subagent-brief 行）──
 *   enabled: boolean        — false 关闭（默认 true）
 *   style: boolean          — 是否要求中文「我们」语域（默认 true）
 *   brief: boolean          — 是否要求报告简短（默认 true）
 *   briefChars: number      — 报告建议字数上限（默认 400）
 *   everyNSteps: number     — 每 N 步注入一次（默认 3，避免刷屏）
 */

import { isSubagent } from './delegation.mjs'

export const name = 'subagent-brief'

export const inject = ['agents']

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
  const wantStyle = config.style !== false
  const wantBrief = config.brief !== false
  const rawChars = config.briefChars
  const briefChars = Number.isSafeInteger(rawChars) && rawChars > 0 ? rawChars : 400
  const rawEvery = config.everyNSteps
  const everyNSteps = Number.isSafeInteger(rawEvery) && rawEvery > 0 ? rawEvery : 3

  if (!enabled || (!wantStyle && !wantBrief)) return

  const parts = []
  if (wantStyle) {
    parts.push(
      '你是一个子代理。请用**中文**思考，并且每一个句子都以「我们」作主语开头' +
      '（「我们需要…」「我们先看…」「我们判断…」）。不要用英文思考，' +
      '读到的英文代码/报错是材料，不是你的思考语言。',
    )
  }
  if (wantBrief) {
    parts.push(
      `你的**最终报告要简短**——建议不超过 ${briefChars} 字。` +
      '只写结论和关键证据（文件、行号、命令输出要点），不要复述推理过程、不要大段贴代码、' +
      '不要写长篇论证。父代理只想要"你发现了什么、该怎么修"，细节可以留在你自己的上下文里。',
    )
  }
  const text = '（' + parts.join('\n') + '）'

  ctx.on('agent/pre-step', async ({ turn, step, agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision

    // 只对子代理生效。
    if (!isSubagent(agent)) return decision

    // 按步数节流：首步必注入（定调），之后每 N 步一次。
    if (step !== 1 && everyNSteps > 1 && (step - 1) % everyNSteps !== 0) return decision

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
