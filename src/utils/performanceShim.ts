/**
 * ============================================================================
 * performance shim —— globalThis.performance 的"内存泄漏防护垫片"
 * ============================================================================
 *
 * 【它解决什么问题】
 * Bun 的 JS 引擎是 JavaScriptCore（JSC），globalThis.performance 是 JSC 的
 * 原生实现。原生对象把 mark / measure / resource timing 的记录存在一个
 * C++ Vector 里——致命特性：调 clearMarks() 也不会收缩，只进不出。
 * 长会话（daemon、/loop 这类一跑几小时的场景）会累积几百 MB 的死内存。
 *
 * 【垫片策略：把 performance 拆成两半】
 *   performance.now()  → 留在原生对象上。高频调用、零内存成本，
 *                        React reconciler / OTel / Langfuse 只用它计时
 *   mark / measure / …  → 重定向到普通 JS Map。会累积的数据放进
 *                        GC 可回收的 JS 内存，不再进 C++ Vector
 *
 * 【为什么必须是 cli.tsx 的第一个 import】
 * 见文件最后一行：import 本文件的瞬间就自动完成安装（副作用）。
 * 如果 React / OTel 先被加载，它们会捕获原生 performance 的引用，
 * 垫片就形同虚设了。
 *
 * （附：cli.tsx 里写的是 `import '../utils/performanceShim.js'`，后缀 .js
 *   指向的却是本 .ts 文件——这是 Bun 的 ESM 约定，.js 后缀映射到同名 .ts 源码。）
 */

// 先保存原生 performance 的引用：无泄漏风险的操作（now/timeOrigin/toJSON）
// 继续委托给原生实现，只有会累积的操作才走 JS Map
const original = globalThis.performance

// JS 后备存储——纯 JS 对象，GC 可回收，clear 即真正释放
const marks = new Map<string, number>()
const measures = new Map<
  string,
  { name: string; startTime: number; duration: number }
>()

// now()：直接委托原生。最高频的调用路径，垫片不引入任何额外成本
function now(): number {
  return original.now()
}

// mark(name)：记录一个时间点。
// 返回值是手工拼的最小 PerformanceMark 形状——React/OTel 只用 mark() 的
// 副作用，不消费返回值，所以不需要完整实现原生对象
function mark(name: string): PerformanceMark {
  marks.set(name, now())
  return {
    name,
    entryType: 'mark',
    startTime: marks.get(name)!,
    duration: 0,
  } as PerformanceMark
}

// measure()：计算并记录一段时长。支持三种入参形态，全部归一化成
// { startTime, duration } 存进 Map：
//   ① measure(name, startMark, endMark)   —— 两个标记名字符串
//   ② measure(name, { start, end })       —— 选项对象（时间戳）
//   ③ measure(name)                       —— 从 0 到现在
// 查不到标记时不报错，取当前时间兜底（和原生"宽容"语义一致）
function measure(
  name: string,
  startMarkOrOptions?: string | MeasureOptions,
  endMark?: string,
): void {
  let startTime: number
  let duration: number

  if (typeof startMarkOrOptions === 'string') {
    const start = marks.get(startMarkOrOptions)
    const end = endMark ? marks.get(endMark) : now()
    startTime = start ?? now()
    duration = (end ?? now()) - startTime
  } else if (startMarkOrOptions && typeof startMarkOrOptions === 'object') {
    startTime = startMarkOrOptions.start ?? 0
    duration = (startMarkOrOptions.end ?? now()) - startTime
  } else {
    startTime = 0
    duration = now()
  }

  measures.set(name, { name, startTime, duration })
}

interface MeasureOptions {
  start?: number
  end?: number
  detail?: unknown
}

interface PerformanceEntryLike {
  readonly name: string
  readonly entryType: string
  readonly startTime: number
  readonly duration: number
}

// 查询接口：不维护额外索引，从两个 Map 现查现组装（调用频率低，不值得换空间）
function getEntriesByType(type: string): PerformanceEntryLike[] {
  if (type === 'mark') {
    return [...marks.entries()].map(([name, startTime]) => ({
      name,
      entryType: 'mark',
      startTime,
      duration: 0,
    }))
  }
  if (type === 'measure') {
    return [...measures.values()].map(m => ({
      name: m.name,
      entryType: 'measure',
      startTime: m.startTime,
      duration: m.duration,
    }))
  }
  return []
}

function getEntriesByName(name: string, type?: string): PerformanceEntryLike[] {
  const entries = getEntriesByType(type ?? 'mark').concat(
    type === undefined ? getEntriesByType('measure') : [],
  )
  return entries.filter(e => e.name === name)
}

// clear*：这就是垫片的核心收益——
// 原生实现的 clearMarks() 只是逻辑清除，C++ Vector 容量永不收缩；
// 这里的 Map.delete/clear 是真释放，GC 随时可回收
function clearMarks(name?: string): void {
  if (name !== undefined) {
    marks.delete(name)
  } else {
    marks.clear()
  }
}

function clearMeasures(name?: string): void {
  if (name !== undefined) {
    measures.delete(name)
  } else {
    measures.clear()
  }
}

// ============================================================================
// 组装垫片对象
// ============================================================================
// 关键约束：必须是一个**普通对象**，绝不能继承 Performance.prototype——
// JSC 原生 getter（onresourcetimingbufferfull / timeOrigin / toJSON）会校验
// `this` 是真正的 JSC Performance 实例，继承原型链调用时会直接抛 TypeError。
// 所以这里用平面对象 + 手动委托。
const shim = {
  now,
  mark,
  measure: measure as typeof performance.measure,
  getEntriesByType: getEntriesByType as typeof performance.getEntriesByType,
  getEntriesByName: getEntriesByName as typeof performance.getEntriesByName,
  clearMarks: clearMarks as typeof performance.clearMarks,
  clearMeasures: clearMeasures as typeof performance.clearMeasures,
  // 这两个 resource timing 相关操作没有 JS Map 对应物，直接 no-op
  clearResourceTimings: (() => {}) as typeof performance.clearResourceTimings,
  setResourceTimingBufferSize:
    (() => {}) as typeof performance.setResourceTimingBufferSize,
  // 兼容性大坑：Node v22 的 undici（fetch 内部实现）每次 fetch 完都会调
  // performance.markResourceTiming——缺这个方法会直接
  // TypeError: markResourceTiming is not a function。所以必须是空函数占位
  markResourceTiming: (() => {}) as () => void,
  // 只读属性委托给原生（自身不持有，不产生累积）
  get timeOrigin() {
    return original.timeOrigin
  },
  get onresourcetimingbufferfull() {
    return (original as unknown as typeof performance)
      .onresourcetimingbufferfull
  },
  set onresourcetimingbufferfull(_v: any) {
    // 写入直接丢弃（no-op）——防止第三方代码往原生对象塞东西造成累积
  },
  toJSON() {
    return original.toJSON()
  },
} as unknown as typeof performance

/**
 * 把垫片安装到 globalThis.performance 上。
 * 幂等（重复调用安全）；必须在 React / OTel import 之前执行，
 * 否则它们会把原生引用缓存进模块级变量，替换就晚了。
 */
export function installPerformanceShim(): void {
  // 用哨兵变量防重复安装。行首那个分号不是手滑：
  // 本仓库 .ts 是"按需分号"风格，上一行没有分号，下一行以 ( 开头
  // 必须自己带前导分号，否则会被解析成函数调用
  if ((globalThis as Record<string, unknown>).__performanceShimInstalled) return
  ;(globalThis as Record<string, unknown>).__performanceShimInstalled = true
  globalThis.performance = shim
}

// import 即安装（副作用）：这保证了"第一个 import"的时序要求天然成立
installPerformanceShim()
