/**
 * we-need-anchor / subagent-cap —— 给子代理设输出上限（maxTokens）。
 *
 * # 🛑 结论先说：本插件在**当前中转站上无效**（2026-09-21 实测证实）
 *
 * 实测证据（**与 DSH 无关，直接打中转站**）：
 *
 *   | 请求 | 结果 |
 *   |---|---|
 *   | `max_tokens: 1`（关思考） | **返回 6685 tokens**（finish=stop） |
 *   | `max_tokens: 16` | 2635 / 3231 tokens（换模型也一样） |
 *   | `max_completion_tokens: 100` | 4192 tokens |
 *   | `max_completion_tokens: 1200` | 最高一次 **27854 tokens** |
 *
 * **结论：某中转站 这个中转站完全无视输出上限字段。**
 * 经 DSH 抓包交叉验证：74 条响应里 **10 条超过了自己设的上限**，
 * 且 `finish_reason` 从未出现 `length`（该出现时没出现）。
 *
 * **所以本插件"值到了 wire 上"是真的**（抓包实测 32768 → 3000），
 * **但中转站不执行它**——等于没设。
 *
 * ── 处置建议 ──
 *
 * 它**无害但无用**。留着它的唯一理由：**万一将来换直连（不经中转）**，
 * 一个正确的 cap 会立刻生效——那时本插件就有用了。
 * 若你要极简，可以把 `agent.cordis.yml` 里的 `subagent-cap` 行改成 `enabled: false`。
 *
 * **⚠️ 因此"压子代理报告长度"这个目标，在当前链路上只剩软手段**
 * （`subagent-brief` 的提示词），而软手段已实测**压不住**（1110 → 1363 字）。
 * 也就是说：**这个目标目前无解**，不要再试 hard cap 类方案。
 *
 * ── 以下是原始设计意图（保留，供换直连后参考）──
 *
 * 上一棒实测（第五批）：`subagent-brief.mjs` 那套「软要求」**压不住报告长度**：
 *
 *   everyNSteps=3 → 报告 1110 字
 *   everyNSteps=1 → 报告 1363 字   ← 提醒更勤，报告反而更长
 *
 * 而且模型**知道**自己该写 ≤400 字（思维链里明说了），实际仍写 1363 字。
 * 结论：**软提示对报告长度无效**，需要硬约束（但在本机链路不可得，见上）。
 *
 * ── 硬约束怎么做：cap `maxTokens` ──
 *
 * ⚠️ **关键：`maxTokens` 不是"报告长度上限"，而是"这一次调用的输出总量上限"。**
 *
 * 本机协议是 `openai-completions`（见 `~/.dsh/settings.yaml` 的 `api:` 字段），
 * 在 pi-ai 里它的路径是：
 *
 *     buildBaseOptions: maxTokens = clampMaxTokensToContext(model, ctx, options.maxTokens)
 *                       （`pi-ai/dist/api/simple-options.js:17`）
 *     → 原样进 params.max_completion_tokens
 *                       （`pi-ai/dist/api/openai-completions.js:599-605`）
 *
 * ⚠️ **更正（2026-09-21）**：本文件初版在这里写的是错的。初版说
 * 「maxTokens 是答案空间，思考预算会额外加上去（`baseMaxTokens + thinkingBudget`）」，
 * 并引了 `simple-options.js:56-65` 的 `adjustMaxTokensForThinking`。
 * **那个加法函数只有 `bedrock` 和 `anthropic` 两条协议调用**
 * （`bedrock-converse-stream.js:401`、`anthropic-messages.js:679`），
 * **`openai-completions` 根本不 import 它**——它只用 `thinkingBudgetForLevel`
 * 去填 `thinking_token_budget` 字段（而我们没声明该字段 → 不发，抓包实测为 0）。
 *
 * **所以真实语义比我初版写的更严格，也更危险**：
 *   `maxTokens: 3000` = **思考 + 回答 的总量被卡在 3000 token**
 *   （抓包实测印证：传 3000，wire 上 `max_completion_tokens` 就是 3000，
 *     不是 3000 + 16384）
 *
 * 后果：`reasoningEffort: max` 时思考可能吃掉大部分额度，
 * **留给最终报告的就不多了** → 这正可能产生"半截报告"。
 * 这就是本插件带 `MIN_SAFE = 1000` 下限、且低于下限**拒绝而非静默改小**的原因。
 *
 * ⚠️ 因此本插件的定位是**温和收紧**，不是"精确设定报告字数"：
 * 它把上限从"模型默认（抓包实测 32768）"压到一个**具体数字**。
 * 真要精确控字数，只能靠提示词（已证明无效）或截断（会丢信息）。
 *
 * ⚠️ **效果与副作用都还没测**（见 README 第十七批的诚实标注）：
 * 已证明的只有"值确实到了 wire 上"。3000 够不够、会不会截断思考，
 * 需要专门的报告长度 + 完整性对照实验。
 *
 * ── 与 subagent-brief 的分工 ──
 *
 *   subagent-brief  管**风格和语气**（让它想写短）+ 软性字数建议
 *   本插件          管**硬上限**（物理上没有无限空间）
 * 两者互补：软要求负责"愿意短"，硬上限负责"不能无限长"。
 *
 * ── 配置（agent.cordis.yml 的 subagent-cap 行）──
 *   maxTokens: number      — 子代理单次调用的输出上限（**含思考**）。默认 4000
 *   enabled: boolean       — false 关闭（默认 true）
 *   debug: boolean         — 首次生效打日志（默认 false）
 *
 * ⚠️ 已知边界（诚实标注）：
 *   · 只作用于**子代理**（`delegationDepth > 0`），顶层会话不受影响。
 *   · 子代理**继承父会话的 maxTokens**（`dsh-subagent/lib/index.js:459-479`
 *     `resolveChildAgentOptions`），所以父会话若已设了更小的值，本插件**不会放大**它。
 *   · `maxTokens` 写进 `request/header` 后是**该会话的持久状态**，且 pi-ai 会把它
 *     标记为 `adapterDefaults.maxTokens`——下一棒重新播种时该字段**会被剥掉**
 *     （`dsh-agent-loop/lib/index.js:722` `requestProposal`），
 *     所以**每个 turn 都会重新应用**，插件必须每次请求都写（同 temperature）。
 *
 * 本文件位于 preset 目录内，只使用 Node 内建能力，不 import 任何裸包。
 */

import { isSubagent } from './delegation.mjs'

export const name = 'subagent-cap'

/** agents 注册表拥有 agent/request 处理权。 */
export const inject = ['agents']

const DEFAULT_MAX_TOKENS = 4000
/** 下限：低于这个数会把思考本身截断，产生半截报告（比长报告更糟）。 */
const MIN_SAFE = 1000

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
  const logger = makeLogger(ctx)

  if (!enabled) return

  const raw = config.maxTokens

  // ⚠️ 分两种情况，**不要混成一个兜底**（我第一版就混了，被自己的单测抓出来）：
  //   A. 没写 / 类型不对  → 用默认值（配置缺失是正常的）
  //   B. 写了但太小      → **拒绝并告警**（这是"故意的危险值"，不能静默改成 4000，
  //                        否则用户以为生效了，实际用的是别的数）
  if (raw !== undefined && raw !== null && (!Number.isSafeInteger(raw) || raw <= 0)) {
    logger.warn(
      `[${name}] maxTokens=${JSON.stringify(raw)} 不是正整数。` +
      `已放弃设置（本插件本次不生效）——不会静默用默认值，免得你以为配置生效了。`,
    )
    return
  }

  const cap = raw === undefined || raw === null ? DEFAULT_MAX_TOKENS : raw

  if (cap < MIN_SAFE) {
    // ⚠️ 宁可拒绝，也不产生"半截报告"——那比长报告更糟（父代理会基于残缺信息决策）。
    logger.warn(
      `[${name}] maxTokens=${cap} 低于安全下限 ${MIN_SAFE}：会把思考一起截断，` +
      `产生半截报告。已放弃设置（本插件本次不生效）。若确实要这么小，请显式确认风险。`,
    )
    return
  }

  const announced = new WeakSet()

  ctx.on('agent/request', async ({ agent, signal }, next) => {
    const proposed = await next()

    if (signal?.aborted) return proposed
    if (proposed === null || typeof proposed !== 'object') return proposed

    // 只管子代理。顶层会话的输出上限是用户自己的事，本插件不干涉。
    if (!isSubagent(agent)) return proposed

    // ⚠️ 不放大父会话已有的更小限制（子代理会继承父的 maxTokens）。
    const existing = proposed.maxTokens
    if (Number.isSafeInteger(existing) && existing > 0 && existing <= cap) {
      if (debug && agent !== undefined && agent !== null && !announced.has(agent)) {
        announced.add(agent)
        logger.info(`[${name}] 子代理已有更小的 maxTokens=${existing}，不放大`)
      }
      return proposed
    }

    if (debug && agent !== undefined && agent !== null && !announced.has(agent)) {
      announced.add(agent)
      logger.info(
        `[${name}] 子代理输出上限设为 maxTokens=${cap}` +
        `（provider=${proposed.provider ?? '?'} model=${proposed.model ?? '?'}` +
        `${existing === undefined ? '，原为未限制' : `，原为 ${existing}`}）`,
      )
    }

    return { ...proposed, maxTokens: cap }
  })
}
