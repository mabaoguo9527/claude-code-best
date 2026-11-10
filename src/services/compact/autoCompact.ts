import { feature } from 'bun:bundle'
import { markPostCompaction } from 'src/bootstrap/state.js'
import { getSdkBetas } from '../../bootstrap/state.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { hasExactErrorMessage } from '../../utils/errors.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { logError } from '../../utils/log.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { getMaxOutputTokensForModel } from '../api/claude.js'
import { notifyCompaction } from '../api/promptCacheBreakDetection.js'
import { setLastSummarizedMessageId } from '../SessionMemory/sessionMemoryUtils.js'
import {
  type CompactionResult,
  compactConversation,
  ERROR_MESSAGE_USER_ABORT,
  type RecompactionInfo,
} from './compact.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'
import { trySessionMemoryCompaction } from './sessionMemoryCompact.js'

// 压缩摘要请求的**输出预留上限**（不是实际输出量，是"留够这么多空间"）。
// 取值依据：BQ 统计显示压缩摘要（含 thinking）的 p99.99 是 17,387 tokens，
// 20k 是向上取整后的安全上界。
//
// 注意它只是**上限**，真正生效的预留量是 min(模型输出上限, 本值)，
// 见 getEffectiveContextWindowSize 里的计算。
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

/**
 * 计算**有效上下文窗口**：模型窗口减去为输出预留的空间。
 *
 * ## 为什么需要这个函数
 *
 * 上下文窗口（如 200k）是"输入 + 输出"的总和，不是"只能放这么多输入"。
 * 如果在 200k 处才触发压缩，压缩请求本身就没有输出空间了——摘要写不出来，
 * 于是压缩必然失败。所以所有阈值判断都要基于"扣掉输出预留之后"的窗口。
 *
 * ## 计算步骤
 *
 * ```
 * ① contextWindow = getContextWindowForModel(model)
 *    默认 200,000；[1m] 后缀或 1M beta 时 1,000,000；配置里的 max_input_tokens 优先
 * ② reservedTokensForSummary = min(模型输出上限, 20,000)
 * ③ 返回 contextWindow - reservedTokensForSummary
 * ```
 *
 * ## reservedTokensForSummary 的含义
 *
 * 为"压缩摘要这次请求需要写出的内容"预留的 token 数。取值是两者较小值：
 * - `getMaxOutputTokensForModel(model)`：当前模型配置的输出上限。默认受
 *   slot 预留优化影响降到 8,000（见 claude.ts 的 CAPPED_DEFAULT_MAX_TOKENS），
 *   用户设了 `CLAUDE_CODE_MAX_OUTPUT_TOKENS` 或 cap 关闭时会更大。
 * - `MAX_OUTPUT_TOKENS_FOR_SUMMARY`（20,000）：摘要本身的经验上界。
 *
 * 例：输出上限 8k 时预留 8k（200k → 192k）；输出上限 64k 时预留 20k（200k → 180k）。
 * **输出上限越大，预留越多**——因为模型有能力写更长，就得留更多空间给它。
 *
 * ## 环境变量覆盖
 *
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW`：**没有默认值**，不设置时不生效。
 * 设置后会取 `min(真实窗口, 该值)`，即只能把窗口**调小**，不能调大。
 * 用途：在 1M 上下文的端点上人为压低窗口，让自动压缩提前介入（省成本/提速），
 * 而不用改模型本身。
 *
 * @param model 模型标识（如 "claude-sonnet-4-5-20250929"）
 * @returns 可用于输入的有效窗口 token 数
 */
export function getEffectiveContextWindowSize(model: string): number {
  // 摘要输出预留：模型能写多少就留多少，但封顶 20k。
  // 见上方 MAX_OUTPUT_TOKENS_FOR_SUMMARY 的说明。
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  // 传 getSdkBetas() 是因为 1M 上下文是靠 beta 头开启的（context-1m-2025-08-07），
  // 窗口大小取决于本次请求实际带了哪些 beta。
  let contextWindow = getContextWindowForModel(model, getSdkBetas())

  // 环境变量覆盖：只能往下压，不能往上抬（Math.min）。
  // 未设置时 contextWindow 保持模型/配置给出的原值。
  const autoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (autoCompactWindow) {
    const parsed = parseInt(autoCompactWindow, 10)
    if (!isNaN(parsed) && parsed > 0) {
      contextWindow = Math.min(contextWindow, parsed)
    }
  }

  return contextWindow - reservedTokensForSummary
}

/**
 * 跨轮携带的自动压缩追踪状态，由 `queryLoop` 的 `State.autoCompactTracking` 持有。
 *
 * 之所以放在调用方而不是本模块的模块级变量里：`queryLoop` 每轮迭代都会重新
 * 解构 `state`，只有塞进 `state` 的值能跨迭代存活（`query.ts` 的
 * `state = next; continue` 模式）。
 */
export type AutoCompactTrackingState = {
  compacted: boolean
  turnCounter: number
  // Unique ID per turn
  turnId: string
  // 连续失败次数，成功即清零。用作熔断器：上下文不可恢复地超限时
  // （如 prompt_too_long）停止重试，避免每轮都打一次注定失败的压缩请求。
  // 达到 MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES（3）后直接早退。
  consecutiveFailures?: number
}

// 自动压缩阈值的**基础缓冲**：有效窗口小于 400k 时用它。
// 语义是"提前这么多就开始压"，给本轮剩余增长留出空间。
// 更大的窗口用更大的缓冲，见 getAutocompactBufferTokens。
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000

// 距离阈值还剩这么多时，UI 开始显示警告。
// 与 ERROR_THRESHOLD_BUFFER_TOKENS 同值（20k），意味着当前实现里
// warning 和 error 两个状态实际同时触发——只有颜色/措辞不同。
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000

// 距离阈值还剩这么多时，UI 显示为错误态（红色）。
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000

// **手动** /compact 的缓冲：只有自动压缩关闭时才生效。
// 语义是"给用户留 3k 空间去手动执行 /compact"，而不是卡在绝对上限上。
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

// 单轮工具结果的**保守增长估计**。
// 典型工具结果（读文件、grep、bash）平均 5-10K tokens，偶发的大文件读取
// 会冲到 20K 以上。取 15K 作为"下个回合最多能涨多少"的粗估。
// 消费方：estimateMaxTurnGrowth（预测性自动压缩用）。
const TOOL_RESULT_GROWTH_ESTIMATE = 15_000

/**
 * 按有效窗口规模返回自动压缩缓冲（三档）。
 *
 * 窗口越大缓冲越大，理由：单轮能产生的 token 与窗口规模正相关
 * （更长的模型输出 + 更大的工具结果），固定 13k 在大窗口上留不住。
 *
 * | 有效窗口 | 缓冲 | 说明 |
 * |---|---|---|
 * | ≥ 800k | 50,000 | 1M 级上下文 |
 * | ≥ 400k | 30,000 | 超大窗口 |
 * | 其他 | 13,000 | 常规 200k |
 */
export function getAutocompactBufferTokens(model: string): number {
  const effectiveWindow = getEffectiveContextWindowSize(model)
  if (effectiveWindow >= 800_000) return 50_000
  if (effectiveWindow >= 400_000) return 30_000
  return AUTOCOMPACT_BUFFER_TOKENS
}

/**
 * 估算**单个回合最多能增长多少 token**，供预测性自动压缩使用。
 *
 * = 输出预留（min(模型输出上限, 20k)）+ 工具结果增长估计（15k）
 *
 * 消费方 `query.ts:896` 附近：在发请求前估算"这轮会不会顶爆窗口"，
 * 会的话提前压缩，而不是等 API 返回 prompt-too-long 再补救。
 *
 * @see query.ts 的 predictiveThreshold 计算
 */
export function estimateMaxTurnGrowth(model: string): number {
  const maxOutput = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  return maxOutput + TOOL_RESULT_GROWTH_ESTIMATE
}

// 连续失败多少次后熔断。
// BQ 2026-03-10：有 1,279 个会话出现过 50+ 次连续失败（最多 3,272 次），
// 全局每天浪费约 25 万次 API 调用。取 3 是"足够试错但不会烧穿"的折中。
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

/**
 * 自动压缩阈值：token 数达到这个值就该压缩了。
 *
 * ```
 * 阈值 = 有效窗口 − 缓冲
 *      = (上下文窗口 − 输出预留) − 按窗口规模分档的缓冲
 * ```
 *
 * 以默认配置（Sonnet 4.5，200k 窗口，输出上限被 cap 到 8k）为例：
 * ```
 * 有效窗口 = 200,000 − 8,000  = 192,000
 * 缓冲     = 13,000（< 400k 档）
 * 阈值     = 192,000 − 13,000 = 179,000   ← 约占原始窗口的 89.5%
 * ```
 *
 * 换算成百分比会随模型配置浮动（83.5% ~ 94.2%），所以不要在文档里写死"90%"。
 *
 * @see getEffectiveContextWindowSize 窗口与预留的计算
 * @see getAutocompactBufferTokens 缓冲的分档规则
 */
export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)

  const autocompactThreshold =
    effectiveContextWindow - getAutocompactBufferTokens(model)

  // 环境变量覆盖（仅测试用）：按"有效窗口的百分比"算阈值，再取两者较小值。
  //
  // `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=10` 表示"到有效窗口 10% 就压缩"，
  // 用来在本地快速复现压缩流程，不必真的塞满上下文。
  //
  // 注意 Math.min 的方向：它只能把阈值**调低**，不能推迟压缩。
  // 取值区间 (0, 100]，非法值静默忽略。
  const envPercent = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  if (envPercent) {
    const parsed = parseFloat(envPercent)
    if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
      const percentageThreshold = Math.floor(
        effectiveContextWindow * (parsed / 100),
      )
      return Math.min(percentageThreshold, autocompactThreshold)
    }
  }

  return autocompactThreshold
}

/**
 * 一次算出 UI 与流程控制需要的**五个阈值状态**。
 *
 * 全部基于同一个 `tokenUsage` 快照，避免调用方各自算导致数值不一致。
 *
 * ## 五个字段的含义与关系
 *
 * ```
 *                     有效窗口
 *  ├────────────────────┼──────────┤
 *  │                    │          │
 *  │      阈值(−缓冲)   │          │
 *  │    ├───────────────┼──────────┤
 *  │    │  warning      │          │
 *  │    │  error        │          │
 *  │    │  autoCompact  │ 阻塞上限 │
 * ```
 *
 * | 字段 | 判定 | 用途 |
 * |---|---|---|
 * | `isAboveWarningThreshold` | `usage ≥ 阈值 − 20k` | UI 黄色提示 |
 * | `isAboveErrorThreshold` | `usage ≥ 阈值 − 20k` | UI 红色提示（**与 warning 同值**）|
 * | `isAboveAutoCompactThreshold` | `usage ≥ 阈值` | 触发自动压缩 |
 * | `isAtBlockingLimit` | `usage ≥ 有效窗口 − 3k` | 硬性拦截，直接报 prompt-too-long |
 * | `percentLeft` | `(阈值 − usage) / 阈值` | UI 百分比显示 |
 *
 * ## 两个容易踩的点
 *
 * 1. **自动压缩关闭时，阈值会切换成有效窗口**（`threshold` 变量）。
 *    这样 `percentLeft` 和 warning/error 仍然有意义（倒计时到窗口边界），
 *    但 `isAboveAutoCompactThreshold` 已被 `isAutoCompactEnabled()` 短路成 false。
 *
 * 2. **阻塞上限用的是有效窗口而非阈值**，只减 3k（`MANUAL_COMPACT_BUFFER_TOKENS`），
 *    目的是给用户留出手动 `/compact` 的空间。它比自动压缩阈值高出约 13k 缓冲，
 *    所以正常情况下自动压缩会先触发，阻塞上限只是兜底。
 *
 * @param tokenUsage 当前 token 数（见 tokenCountWithEstimation）
 * @param model 模型标识，用于推导窗口与缓冲
 */
export function calculateTokenWarningState(
  tokenUsage: number,
  model: string,
): {
  percentLeft: number
  isAboveWarningThreshold: boolean
  isAboveErrorThreshold: boolean
  isAboveAutoCompactThreshold: boolean
  isAtBlockingLimit: boolean
} {
  const autoCompactThreshold = getAutoCompactThreshold(model)
  // 自动压缩关闭时用有效窗口作为"倒计时终点"，
  // 否则百分比会一直朝一个永远不会发生的事件倒数。
  const threshold = isAutoCompactEnabled()
    ? autoCompactThreshold
    : getEffectiveContextWindowSize(model)

  const percentLeft = Math.max(
    0,
    Math.round(((threshold - tokenUsage) / threshold) * 100),
  )

  const warningThreshold = threshold - WARNING_THRESHOLD_BUFFER_TOKENS
  const errorThreshold = threshold - ERROR_THRESHOLD_BUFFER_TOKENS

  const isAboveWarningThreshold = tokenUsage >= warningThreshold
  const isAboveErrorThreshold = tokenUsage >= errorThreshold

  const isAboveAutoCompactThreshold =
    isAutoCompactEnabled() && tokenUsage >= autoCompactThreshold

  // 阻塞上限 = 有效窗口 − 3k，为手动 /compact 留出空间。
  // 它高于自动压缩阈值，正常情况下自动压缩会先救场，这里是最后一道兜底。
  const actualContextWindow = getEffectiveContextWindowSize(model)
  const defaultBlockingLimit =
    actualContextWindow - MANUAL_COMPACT_BUFFER_TOKENS

  // 测试用覆盖：强行指定阻塞上限，便于在不塞满上下文的前提下验证拦截路径。
  const blockingLimitOverride = process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE
  const parsedOverride = blockingLimitOverride
    ? parseInt(blockingLimitOverride, 10)
    : NaN
  const blockingLimit =
    !isNaN(parsedOverride) && parsedOverride > 0
      ? parsedOverride
      : defaultBlockingLimit

  const isAtBlockingLimit = tokenUsage >= blockingLimit

  return {
    percentLeft,
    isAboveWarningThreshold,
    isAboveErrorThreshold,
    isAboveAutoCompactThreshold,
    isAtBlockingLimit,
  }
}

/**
 * 自动压缩是否启用。**默认启用**（`config.autoCompactEnabled` 默认为 true）。
 *
 * 三道关闭闸，按顺序检查：
 *
 * | 开关 | 影响范围 | 说明 |
 * |---|---|---|
 * | `DISABLE_COMPACT` | **全部压缩** | 连手动 `/compact` 一起关掉，总开关 |
 * | `DISABLE_AUTO_COMPACT` | 仅自动压缩 | 手动 `/compact` 仍然可用 |
 * | 用户配置 `autoCompactEnabled` | 仅自动压缩 | 通过设置界面/配置文件关闭 |
 *
 * 三者是"或"关系，任一为真即关闭。
 *
 * 注意：`shouldAutoCompact()` 里还有额外的**模式互斥**判断
 * （REACTIVE_COMPACT / CONTEXT_COLLAPSE 开启时抑制本机制），
 * 那些不在这个函数里——这样 `reactiveCompact` 仍能把它当作
 * "413 兜底是否可用"来查询，语义更清晰。
 */
export function isAutoCompactEnabled(): boolean {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return false
  }
  // 只关自动压缩，保留手动 /compact 的能力
  if (isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)) {
    return false
  }
  // 用户在设置里关掉的情况
  const userConfig = getGlobalConfig()
  return userConfig.autoCompactEnabled
}

export async function shouldAutoCompact(
  messages: Message[],
  model: string,
  querySource?: QuerySource,
  // Snip removes messages but the surviving assistant's usage still reflects
  // pre-snip context, so tokenCountWithEstimation can't see the savings.
  // Subtract the rough-delta that snip already computed.
  snipTokensFreed = 0,
): Promise<boolean> {
  // Recursion guards. session_memory and compact are forked agents that
  // would deadlock.
  if (querySource === 'session_memory' || querySource === 'compact') {
    return false
  }
  // marble_origami is the ctx-agent — if ITS context blows up and
  // autocompact fires, runPostCompactCleanup calls resetContextCollapse()
  // which destroys the MAIN thread's committed log (module-level state
  // shared across forks). Inside feature() so the string DCEs from
  // external builds (it's in excluded-strings.txt).
  if (feature('CONTEXT_COLLAPSE')) {
    if (querySource === 'marble_origami') {
      return false
    }
  }

  if (!isAutoCompactEnabled()) {
    return false
  }

  // Reactive-only mode: suppress proactive autocompact, let reactive compact
  // catch the API's prompt-too-long. feature() wrapper keeps the flag string
  // out of external builds (REACTIVE_COMPACT is ant-only).
  // Note: returning false here also means autoCompactIfNeeded never reaches
  // trySessionMemoryCompaction in the query loop — the /compact call site
  // still tries session memory first. Revisit if reactive-only graduates.
  if (feature('REACTIVE_COMPACT')) {
    if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false)) {
      return false
    }
  }

  // Context-collapse mode: same suppression. Collapse IS the context
  // management system when it's on — the 90% commit / 95% blocking-spawn
  // flow owns the headroom problem. Autocompact firing at effective-13k
  // (~93% of effective) sits right between collapse's commit-start (90%)
  // and blocking (95%), so it would race collapse and usually win, nuking
  // granular context that collapse was about to save. Gating here rather
  // than in isAutoCompactEnabled() keeps reactiveCompact alive as the 413
  // fallback (it consults isAutoCompactEnabled directly) and leaves
  // sessionMemory + manual /compact working.
  //
  // Consult isContextCollapseEnabled (not the raw gate) so the
  // CLAUDE_CONTEXT_COLLAPSE env override is honored here too. require()
  // inside the block breaks the init-time cycle (this file exports
  // getEffectiveContextWindowSize which collapse's index imports).
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isContextCollapseEnabled } =
      require('../contextCollapse/index.js') as typeof import('../contextCollapse/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (isContextCollapseEnabled()) {
      return false
    }
  }

  const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
  const threshold = getAutoCompactThreshold(model)
  const effectiveWindow = getEffectiveContextWindowSize(model)

  logForDebugging(
    `autocompact: tokens=${tokenCount} threshold=${threshold} effectiveWindow=${effectiveWindow}${snipTokensFreed > 0 ? ` snipFreed=${snipTokensFreed}` : ''}`,
  )

  const { isAboveAutoCompactThreshold } = calculateTokenWarningState(
    tokenCount,
    model,
  )

  return isAboveAutoCompactThreshold
}

/**
 * 自动压缩的**执行入口**：上下文逼近阈值时，把历史压缩成摘要后继续本轮请求。
 *
 * ## 它在整条压缩链上的位置
 *
 * 一个回合里上下文管理的顺序是固定的（见 `src/query.ts`）：
 * `snip`（裁剪旧历史）→ `microcompact`（清工具结果）→ `contextCollapse`（折叠投影）
 * → **autocompact**（本函数）。前面的步骤若已把 token 压到阈值以下，本函数是空操作。
 *
 * 有两个调用点：
 * - `query.ts:715` — 主判定，按 `shouldAutoCompact()` 的结果决定要不要压
 * - `query.ts:938` — 预测性提前压缩，估算"本轮增长会不会顶爆窗口"，用途是抢在
 *   请求发出前腾出空间，避免撞上 API 的 prompt-too-long
 *
 * ## 注意：阈值计算不在这个函数里
 *
 * 是否该压由 `shouldAutoCompact()`（本文件 :189）决定，本函数只负责"执行"。
 * 那个函数里除了 token 计数，还有三类容易忽略的拦截：
 * 递归守卫（`session_memory` / `compact` 是 fork 出来的 agent，再压缩会死锁）、
 * 用户开关、以及与 `REACTIVE_COMPACT` / `CONTEXT_COLLAPSE` 两种模式的互斥。
 *
 * ## 两条压缩路径（先 A 后 B，A 命中就不再走 B）
 *
 * - **路径 A**：`trySessionMemoryCompaction()` —— 记忆型压缩，裁剪消息但保留细粒度上下文。
 *   命中即返回，不走整段摘要。
 * - **路径 B**：`compactConversation()` —— 传统全量摘要，用一次模型调用把历史总结掉。
 *
 * ## 熔断器（横向状态由调用方持有）
 *
 * 本函数无状态：失败时只把"连续失败次数"放在返回值里交给调用方，
 * 由 `query.ts:799` 写回 `tracking`。累计到 `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES`（3）
 * 后，下次进来会走早退②，不再对不可恢复的超限上下文反复打 API。
 * 之所以放在调用方而不是函数内，是因为 `query` 每次循环都会重新展开变量，
 * 只有 `tracking` 能跨迭代存活。
 *
 * @param messages 当前待发往模型的消息列表（已过 snip / microcompact / collapse）
 * @param toolUseContext 工具上下文，提供 `agentId`、主循环模型名等
 * @param cacheSafeParams 缓存安全参数（systemPrompt、userContext 等），供 fork 出摘要 agent 复用
 * @param querySource 调用来源标识，用于拒绝在 fork 出来的子 agent 里递归压缩
 * @param tracking 跨回合的压缩追踪状态；`consecutiveFailures` 是熔断计数
 * @param snipTokensFreed snip 已释放的 token 数（仅靠 usage 估算看不到这部分省下来的量）
 * @returns `wasCompacted` 是否真的压了；`compactionResult` 压缩产物；
 *   `consecutiveFailures` 失败时的最新计数，供调用方写回 tracking
 */
export async function autoCompactIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource?: QuerySource,
  tracking?: AutoCompactTrackingState,
  snipTokensFreed?: number,
): Promise<{
  wasCompacted: boolean
  compactionResult?: CompactionResult
  consecutiveFailures?: number
}> {
  // 早退①：环境变量硬关闭。DISABLE_COMPACT 同时关掉手动 /compact 和自动压缩，
  // 是"彻底不要压缩"的总开关（区别于 DISABLE_AUTO_COMPACT 只关自动那一种）。
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return { wasCompacted: false }
  }

  // 早退②：熔断器。连续失败已达上限就不再尝试。
  // 没有这道闸，上下文不可恢复地超限时（如 prompt_too_long），
  // 每个回合都会打一次注定失败的压缩请求，纯属空烧 API。
  if (
    tracking?.consecutiveFailures !== undefined &&
    tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
  ) {
    return { wasCompacted: false }
  }

  // 真正的阈值判定交给 shouldAutoCompact：其中包含递归守卫、用户开关、
  // 与 REACTIVE_COMPACT / CONTEXT_COLLAPSE 的互斥，以及 snip 释放量的折算。
  const model = toolUseContext.options.mainLoopModel
  const shouldCompact = await shouldAutoCompact(
    messages,
    model,
    querySource,
    snipTokensFreed,
  )

  // 没到阈值（或模式互斥）就直接返回，压缩是纯开销，不该白白触发。
  if (!shouldCompact) {
    return { wasCompacted: false }
  }

  // 记录"这是第几次压缩"，供摘要 prompt 与埋点区分首压和连环压。
  // isRecompactionInChain 为真表示上一次压缩之后又被压了一次（说明摘要本身
  // 没把上下文压下去，或者用户很快又堆满了）。
  const recompactionInfo: RecompactionInfo = {
    isRecompactionInChain: tracking?.compacted === true,
    turnsSincePreviousCompact: tracking?.turnCounter ?? -1,
    previousCompactTurnId: tracking?.turnId,
    autoCompactThreshold: getAutoCompactThreshold(model),
    querySource,
  }

  // 路径 A：先试实验性的 session memory 压缩。
  // 它按 session 记忆裁剪消息，代价低于整段摘要，也更能保住细粒度上下文。
  // 返回 null 表示没有可用的记忆或条件不满足，落到路径 B。
  const sessionMemoryResult = await trySessionMemoryCompaction(
    messages,
    toolUseContext.agentId,
    recompactionInfo.autoCompactThreshold,
  )
  if (sessionMemoryResult) {
    // 记忆型压缩会裁剪消息，旧的"最后摘要消息 UUID"在 REPL 替换消息后不再存在，
    // 必须清掉，否则后续增量摘要会指向一条已消失的消息。
    setLastSummarizedMessageId(undefined)
    // 重置 microcompact / 折叠 / 记忆文件缓存等模块级状态。
    // 只有主线程压缩才重置折叠，子 agent 共享进程级状态，重置会误伤主线程。
    runPostCompactCleanup(querySource)
    // 重置 prompt cache 读取基线，避免压缩后的用量骤降被判定为"缓存断裂"。
    // compactConversation 内部会自己做这一步，而 SM-compact 不会——
    // BQ 2026-03-01：漏掉这里让 20% 的 tengu_prompt_cache_break 事件变成误报。
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      notifyCompaction(querySource ?? 'compact', toolUseContext.agentId)
    }
    // 打上"刚压缩过"的标记，供下游（如本回合的上下文组装）消费一次。
    markPostCompaction()
    return {
      // 注意：这里不返回 consecutiveFailures，等于重置熔断计数（成功即清零语义）。
      wasCompacted: true,
      compactionResult: sessionMemoryResult,
    }
  }

  // 路径 B：传统全量摘要。
  try {
    const compactionResult = await compactConversation(
      messages,
      toolUseContext,
      cacheSafeParams,
      true, // 自动压缩不给用户弹交互式追问，避免卡住回合
      undefined, // 自动压缩不附加用户自定义指令
      true, // isAutoCompact：走自动压缩分支（与手动 /compact 区分）
      recompactionInfo,
    )

    // 全量压缩会整段替换消息数组，旧的摘要 UUID 必然失效，同样要清。
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)

    return {
      wasCompacted: true,
      compactionResult,
      // 成功即清零熔断计数，让下一次真正超限时还能重新尝试。
      consecutiveFailures: 0,
    }
  } catch (error) {
    // 用户主动中止不算错误，不写错误日志（否则中止会被当成故障报上来）。
    if (!hasExactErrorMessage(error, ERROR_MESSAGE_USER_ABORT)) {
      logError(error)
    }
    // 累加连续失败计数并回传，由调用方写进 tracking（本函数无状态）。
    // 下一个回合循环迭代读到的就是这个更大的计数，达到上限后走早退②。
    const prevFailures = tracking?.consecutiveFailures ?? 0
    const nextFailures = prevFailures + 1
    if (nextFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      logForDebugging(
        `autocompact: circuit breaker tripped after ${nextFailures} consecutive failures — skipping future attempts this session`,
        { level: 'warn' },
      )
    }
    return { wasCompacted: false, consecutiveFailures: nextFailures }
  }
}
