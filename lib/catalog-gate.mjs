/**
 * we-need-anchor / catalog-gate — 首轮不注入技能目录，晋升后再放行。
 *
 * ── 为什么需要它（实测依据）──
 *
 * 真实会话实测（n=6/条件）：
 *   | 条件                        | 密度  | 以「我们」开头 |
 *   |-----------------------------|-------|--------------|
 *   | 无注入（干净基线）            | 14.9  |     61%      |
 *   | 完整 AGENTS.md（31KB）        | 16.6  |     55%      |
 *   | AGENTS.md + 技能目录          | 14.2  |     47%      | ← 最差
 *
 * → **技能目录（skill-catalog）是实测确认的漂移帮凶**。
 *   上游 issue #6 早在 v4-pro 时代就报过「有技能目录则锚定 0/9」，
 *   本机 v4.1-flash 上复现了同方向的效果（不过程度较轻）。
 *
 * 用户的真实使用数据（扫描 60 个历史会话）：
 *   · 调用过 skill 工具的会话：**4 个**（6.7%）
 *   · 总调用 6 次，全部是 `cordis-plugin-development` / `editing-cordis-compositions`
 *     （写 DSH 插件时用的），与千星沙箱无关
 *   → **`miliastra-knowledge` 在 60 个会话里零次使用**
 *
 * 所以在本 preset 里默认关闭技能目录注入是安全的：
 * 需要千星沙箱时换回标准模式即可（技能本身没有删除，只是这个模式不注入）。
 *
 * ── 机制（关键：只拦 catalog，不拦 invocation）──
 *
 * 技能有两条不同的注入路径，`source.kind` 不同：
 *   · `skill-catalog`     —— 自动注入的「有哪些技能」清单（**本插件拦这个**）
 *   · `skill-invocation`  —— 用户主动 `@技能` 时注入的完整内容（**放行**）
 *
 * 所以即使用户在会话里直接点名一个技能，它仍然能正常工作——
 * 被拦掉的只是那份自动清单。
 *
 * 晋升信号与 anchor-gate 一致：会话出现持久的 `tool/call` 或 `assistant/message`。
 * 晋升后目录恢复注入，模型照常能看到技能。
 *
 * ── ⚠️ 注册顺序是关键（踩过）──
 *
 * `dsh-tool-skill` 的 catalog 注入也是挂在 `agent/pre-step`，且它在自己的
 * `next()` **之后**才 `[...decision.messages, catalog]` 追加。
 * waterfall 的后置变换按**注册逆序**生效（后注册的先跑、更靠内层）。
 *
 * 所以：如果本插件"正常顺序"注册，会跑在 tool-skill **内层**——
 * 等本插件拿到 decision 时，catalog 还没被追加，**过滤不到**。
 *
 * 解法：用 `{ prepend: true }` 注册，让本插件成为**最外层**变换，
 * 这样它在 tool-skill 追加完 catalog 之后才执行过滤。
 * （上游 dsh-anchored-standard 的 issue #6/#10 记录过同一个坑。）
 *
 * ── 配置（agent.cordis.yml 的 catalog-gate 行）──
 *   enabled: boolean          — false 关闭（默认 true）
 *   promoteOn: 'either' | 'tool-call' | 'assistant-message'  — 晋升信号（默认 either）
 *   keepInvocation: boolean   — 用户主动 @技能 是否放行（默认 true，强烈建议保持）
 */

export const name = 'catalog-gate'

export const inject = ['agents']

/** 已经晋升过的 agent。 */
const promoted = new WeakSet()

function eventsOf(session) {
  if (session === undefined || session === null) return []
  try {
    if (typeof session.snapshotEvents === 'function') {
      const events = session.snapshotEvents()
      return Array.isArray(events) ? events : []
    }
    if (Array.isArray(session.events)) return session.events
  } catch {
    // 会话未物化：当作没有事件。
  }
  return []
}

/** 晋升信号：与 anchor-gate 同一套语义（默认 either）。 */
function hasPromotionSignal(session, mode) {
  for (const event of eventsOf(session)) {
    if (event === null || typeof event !== 'object') continue
    if (mode === 'tool-call' && event.type === 'tool/call') return true
    if (mode === 'assistant-message' && event.type === 'assistant/message') return true
    if (mode === 'either' && (event.type === 'tool/call' || event.type === 'assistant/message')) return true
  }
  return false
}

/** 一条消息是不是自动注入的技能目录。 */
function isSkillCatalog(message) {
  const source = message?.source
  return source !== null && typeof source === 'object' && source.kind === 'skill-catalog'
}

export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false
  const keepInvocation = config.keepInvocation !== false
  const rawMode = config.promoteOn
  const promoteOn = rawMode === 'tool-call' || rawMode === 'assistant-message' ? rawMode : 'either'

  if (!enabled) return

  // ⚠️ prepend: true 是必需的，见文件头「注册顺序是关键」。
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision

    const messages = decision.messages
    if (!Array.isArray(messages) || messages.length === 0) return decision

    // 已经晋升：原样放行。
    if (agent !== undefined && agent !== null && promoted.has(agent)) return decision

    if (agent !== undefined && agent !== null && hasPromotionSignal(agent.session, promoteOn)) {
      promoted.add(agent)
      return decision
    }

    // 锚定阶段：过滤掉自动注入的技能目录。
    const kept = messages.filter((message) => !isSkillCatalog(message))
    if (kept.length === messages.length) return decision

    // 用户主动 @技能 的内容保留（kind 是 skill-invocation，本来就不同，
    // 这里只是显式说明：keepInvocation=false 时才需要额外处理）。
    if (!keepInvocation) {
      const withoutInvocation = kept.filter((m) => m?.source?.kind !== 'skill-invocation')
      return { ...decision, messages: withoutInvocation }
    }

    return { ...decision, messages: kept }
  }, { prepend: true })
}
