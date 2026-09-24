/**
 * we-need-anchor / temperature — 给每一次模型请求钉一个固定的采样温度。
 *
 * ── 为什么做它（以及一个必须说清的更正）──
 *
 * 起因：第 4 批实验里 T1（temperature=0.1）叠加 T2（种子示范）曾测出 **1.93×**
 * 密度、中文占比 59%、质量 8/8 无损。当时 README 写「DSH 没暴露 temperature，
 * 想用得改宿主，收益不抵复杂度」——那句话**是错的**：`agent/request` waterfall
 * 的返回对象就是请求 config 本身，顶层写 `temperature` 即可，不需要动宿主或适配器。
 *
 * ⚠️ **但 1.93× 这个收益，2026-09-21 用真实多轮 n=30/臂 复现失败了**：
 *   · 任务通过率 30/30 vs 30/30（无差异）
 *   · 中文占比 0.92×（略降，p=0.22 不显著）——与「中文 59%」方向相反
 *   · 「我们」绝对次数 20.17 vs 19.60（p=0.56 不显著）
 *   · 「我们」密度 1.25×（p=0.039）——**但这是长度假象**：思考字符数 1309 vs 1666
 *     （0.79×，p=0.024），分子（次数）没动、分母（长度）变小，密度就机械上升
 *   · 工具调用 1.17×（p=0.007，唯一稳健的负面信号）；CNY 成本中性（0.98×）
 *
 * 所以现在挂它的理由**不是**「提升风格」，而是两件事：
 *   1. 机制上它确实够得着（这一条成立，插件本身正确）；
 *   2. 它**能把思考压短约 21%**（p=0.024），代价是多 17% 工具调用。
 * **不要**再把它当成风格杠杆。想定论需要「去掉 re-anchor 的 2×2」实验（约 120 次会话）。
 * 完整数据表见 README「1.93× 没能复现」专节。
 *
 * ── 挂载层级：顶层，不是 header.config（已查源码逐跳确认，不是猜）──
 *
 *   agent/request waterfall 返回的对象 = proposedConfig（顶层 config）
 *     → llm.prepareCall(proposedConfig)                    dsh-agent-loop/lib/index.js:1153
 *     → resolveCallWithInfo(config)                        dsh-llm/lib/index.js:2111
 *          ↑ 只 spread，不丢字段：resolveCallWithInfo 只可能覆盖 maxTokens /
 *            reasoningEffort 两个字段（:2112-2138），temperature 原样穿过
 *     → preparedCall.stream(request)                        dsh-agent-loop/lib/index.js:1036
 *          ↑ request = { ...header.config, messages, tools, sessionId, signal }
 *            （buildRequest，:1240 附近）——所以 temperature 也进了 request
 *     → callConfigEquals(options, resolvedConfig)           dsh-llm/lib/index.js:2166
 *          ↑ :353 明确比较 .temperature，两边都来自同一 config → 相等，不抛
 *     → adapterCall.stream(options) → pi-ai streamSimple    dsh-llm-pi-ai/lib/index.js:1869
 *          ↑ `...options.temperature === void 0 ? {} : { temperature: options.temperature }`
 *     → wire 上的 params.temperature                        pi-ai/dist/api/openai-completions.js:608
 *
 * **所以：返回对象就是 config 本身，`temperature` 写在顶层。**
 * （`header.config` 是同一对象的持久投影：buildRequest → canonicalHeader 把它
 *  写进 `request/header` 事件，这正是下面「怎么验证」要看的地方。）
 *
 * ── 三个已验证的配套事实 ──
 *
 * 1. **中转站真的收这个字段**：某中转站 用 openai-completions 协议，
 *    temperature 是标准字段。实测直连 POST（带 temperature:0.1）返回 HTTP 200。
 * 2. **会话格式允许它持久化**：`request/header` 的 config 允许 temperature
 *    （`dsh-session-format-v0-to-v1/lib/index.js:1111`，校验只要求「有限数字」）。
 * 3. **它是幂等的，不会造成 header 抖动**：agent-loop 在 turn 2+ 会从已持久化的
 *    header 重新播种 config（`prepareRequest`，:1136-1142）。我们每次都写同一个值，
 *    `headerEquals` 判定不变 → **不会反复追加 `request/header` 事件**（无日志膨胀）。
 *
 * ⚠️ 与其它插件的根本差别：**其它插件「注入一次」，本插件必须每次请求都写。**
 *    temperature 是逐次调用的参数、不在对话历史里，所以没有 WeakSet、
 *    没有 turn/step 门控——每一个 `agent/request` 都要设。
 *
 * ── 配置（agent.cordis.yml 的 temperature 行）──
 *   value: number          — 目标温度，必须是 [0, 2] 内的有限数字（默认 0.1）
 *   enabled: boolean       — false 关闭（默认 true）
 *   includeSubagents: boolean — 子代理是否也设（默认 true，与 seed-graft /
 *                              re-anchor / anchor-gate 的风格取向一致：
 *                              子代理报告的语域会回流到父会话）
 *   debug: boolean         — 首次生效时打一条日志（默认 false）
 *
 * ⚠️ 已知边界（诚实标注，别当成 bug）：
 *   · temperature 一旦写进某个会话的 `request/header` 就成了**该会话的持久状态**
 *     （agent-loop 播种时只剥 reasoningEffort/maxTokens 两个「适配器默认」标记，
 *     不剥 temperature）。所以**对已存在的会话关掉本插件，温度不会自己退回去**——
 *     要彻底复位得开新会话。这是宿主行为，不是本插件能改的。
 *   · 值超出 [0,2] 时**不设**并告警一次（不静默钳制——宁可退回厂商默认，
 *     也不假装你配的值生效了）。
 *
 * 本文件位于 preset 目录内，只使用 Node 内建能力，不 import 任何裸包。
 * `.mjs` 后缀是必需的：preset 之上没有声明 type:module 的 package.json。
 */

export const name = 'temperature'

/** agents 注册表拥有 agent/request 处理权。 */
export const inject = ['agents']

const DEFAULT_VALUE = 0.1
const MIN_VALUE = 0
const MAX_VALUE = 2

function makeLogger(ctx) {
  const log = ctx?.logger
  return {
    info: (msg) => { try { log?.info?.(msg) } catch {} },
    warn: (msg) => { try { log?.warn?.(msg) } catch {} },
  }
}

/**
 * 解析配置里的温度值。
 * @returns {{ok: true, value: number} | {ok: false, reason: string}}
 */
function resolveValue(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: DEFAULT_VALUE }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { ok: false, reason: `temperature 配置必须是数字，实际是 ${JSON.stringify(raw)}` }
  }
  if (raw < MIN_VALUE || raw > MAX_VALUE) {
    return { ok: false, reason: `temperature 配置 ${raw} 超出允许区间 [${MIN_VALUE}, ${MAX_VALUE}]` }
  }
  return { ok: true, value: raw }
}

// ── 子代理判定：与其它插件共用同一个助手（⚠️ 不要读 agent.delegationDepth，
//    那个字段在 agent 对象上不存在，会让判定恒为 false——踩过，见 delegation.mjs）。
import { isSubagent } from './delegation.mjs'

export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false
  const debug = config.debug === true
  const includeSubagents = config.includeSubagents !== false

  const resolved = resolveValue(config.value)
  const logger = makeLogger(ctx)

  if (!enabled) return

  if (!resolved.ok) {
    // ⚠️ 配置错了就是错了：不设温度、明确告警，绝不静默用一个「猜的值」。
    logger.warn(`[${name}] ${resolved.reason}；已放弃设置 temperature（本插件本次不生效）。`)
    return
  }

  const target = resolved.value

  /** 每个 agent 只打一次生效日志，避免每步刷屏。 */
  const announced = new WeakSet()

  ctx.on('agent/request', async ({ agent, signal }, next) => {
    const proposed = await next()

    // 请求已取消，或下游没给出可用 config：原样放行。
    if (signal?.aborted) return proposed
    if (proposed === null || typeof proposed !== 'object') return proposed

    if (!includeSubagents && isSubagent(agent)) return proposed

    if (debug && agent !== undefined && agent !== null && !announced.has(agent)) {
      announced.add(agent)
      logger.info(
        `[${name}] temperature=${target} 已写入每次请求` +
        `（provider=${proposed.provider ?? '?'} model=${proposed.model ?? '?'}` +
        `${isSubagent(agent) ? '，子代理' : ''}）`,
      )
    }

    // 顶层，与下游返回的 provider/model/reasoningEffort 并列——
    // 这个对象会被 prepareCall → 适配器 → wire 原样带走（注释顶部有逐跳行号）。
    return { ...proposed, temperature: target }
  })
}
