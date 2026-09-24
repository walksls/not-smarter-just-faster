/**
 * we-need-anchor / delegation — 统一的「子代理判定」助手。
 *
 * ── 为什么单独一个文件 ──
 *
 * 三个插件都要判断「当前 agent 是不是子代理」，而这件事**踩过坑**：
 *
 * ❌ 错误写法（我第一版写的，实测无效）：
 *      agent.delegationDepth
 *    → agent 对象上**根本没有**这个字段（实测 hasAgentDelegationDepth=false）。
 *    后果：判断恒为 false，即"永远不是子代理"，
 *    于是子代理**一直在被锚定插件处理**——而它本该豁免。
 *
 * ✅ 正确写法（实测确认）：
 *      agent.session.header.delegationDepth
 *    → delegationDepth 是 **session header** 的字段（dsh-session 校验它必须是非负安全整数）。
 *    顶层会话 header 里**没有**该字段；子代理会话由 delegation 层写入。
 *
 * 另外 `agent.delegationDepth` 在旧版本可能存在，所以取两个路径的"较大值"，
 * 这样新旧版本都能正确判定。
 */

/**
 * 判断一个 agent 是否为子代理（delegation depth > 0）。
 *
 * @param agent - pre-step / assemble 上下文里的 agent 对象
 * @returns 子代理返回 true；顶层会话返回 false
 */
export function isSubagent(agent) {
  if (agent === undefined || agent === null) return false

  // 路径 1：session header（本机 0.1.5-rc.2 实测的正确位置）
  let headerDepth
  try {
    headerDepth = agent.session?.header?.delegationDepth
  } catch {
    headerDepth = undefined
  }

  // 路径 2：agent 自身的字段（老版本可能用这个）
  const agentDepth = agent.delegationDepth

  const toNumber = (value) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined
    return value
  }

  const a = toNumber(headerDepth)
  const b = toNumber(agentDepth)
  const depth = Math.max(a ?? 0, b ?? 0)
  return depth > 0
}
