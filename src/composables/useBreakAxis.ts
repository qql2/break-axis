/**
 * 断轴功能 Composable
 * 提供 IQR 双向断轴算法和断轴后处理管道
 */

import type {
  BreakInterval,
  BreakContext,
  BreakProcessor,
  BreakAxisConfig,
  BreakAxisResult,
  IQRBreakAxisResult,
} from '@/types/breakAxis'

/**
 * 计算 IQR 断轴区间
 */
export function calculateIQRBreakAxis(
  values: number[],
  k: number = 1.5,
  ignoreZero: boolean = true,
): IQRBreakAxisResult {
  let sorted = [...values].sort((a, b) => a - b)
  let n = sorted.length

  if (n === 0) {
    return {
      breaksUpper: [],
      breaksLower: [],
      debug: {
        Q1: 0,
        Q3: 0,
        IQR: 0,
        b_upper: 0,
        b_lower: 0,
        normalCount: 0,
        outlierCount: 0,
      },
    }
  }

  const q = (arr: number[]) => (p: number) => {
    const len = arr.length
    return arr[Math.ceil((p / 100) * len) - 1]
  }

  let Q1 = q(sorted)(25)
  let Q3 = q(sorted)(75)
  let IQR = Q3 - Q1

  // 如果IQR为0且配置了忽略0值，则用非0数据重新计算
  if (IQR === 0 && ignoreZero) {
    const nonZeroSorted = sorted.filter((v) => v !== 0)
    sorted = nonZeroSorted
    n = sorted.length
    if (n > 0) {
      Q1 = q(sorted)(25)
      Q3 = q(sorted)(75)
      IQR = Q3 - Q1
    }
  }

  const b_upper = Q3 + k * IQR
  const b_lower = Q1 - k * IQR

  const outliersUpper = sorted.filter((v) => v > b_upper)
  const outliersLower = sorted.filter((v) => v < b_lower)
  const normalValues = sorted.filter((v) => v >= b_lower && v <= b_upper)

  const breaksUpper =
    outliersUpper.length > 0
      ? [
          {
            start: b_upper,
            end: Math.max(...outliersUpper),
          },
        ]
      : []
  const breaksLower =
    outliersLower.length > 0
      ? [
          {
            start: Math.min(...outliersLower),
            end: b_lower,
          },
        ]
      : []

  return {
    breaksUpper,
    breaksLower,
    debug: {
      Q1,
      Q3,
      IQR,
      b_upper,
      b_lower,
      normalCount: normalValues.length,
      outlierCount: outliersUpper.length + outliersLower.length,
    },
  }
}

/**
 * 合并原始上下断轴为工作集
 */
function combineRawBreaks(rawUpper: BreakInterval[], rawLower: BreakInterval[]): BreakInterval[] {
  const combined: BreakInterval[] = []
  if (rawUpper.length > 0) combined.push(...rawUpper)
  if (rawLower.length > 0) combined.push(...rawLower)
  return combined
}

/**
 * 计算中心可见区间
 */
function calculateCenterVisible(breaks: BreakInterval[]): [number, number] {
  if (!breaks || breaks.length === 0) {
    return [-Infinity, Infinity]
  }

  let minStartAboveZero = Infinity
  let maxEndBelowZero = -Infinity

  for (const b of breaks) {
    if (b.start >= 0 && b.start < minStartAboveZero) {
      minStartAboveZero = b.start
    }
    if (b.end <= 0 && b.end > maxEndBelowZero) {
      maxEndBelowZero = b.end
    }
  }

  return [maxEndBelowZero, minStartAboveZero]
}

/**
 * 计算正常值边界
 */
function calculateNormalBoundary(values: number[], centerVisible: [number, number]) {
  const normalValues = values.filter((v) => v >= centerVisible[0] && v <= centerVisible[1])
  if (normalValues.length === 0) {
    return { normalMin: centerVisible[0], normalMax: centerVisible[1] }
  }
  const normalMin = Math.min(...normalValues)
  const normalMax = Math.max(...normalValues)
  return { normalMin, normalMax }
}

/**
 * 计算可见范围
 */
function computeVisibleRange(ctx: BreakContext): number {
  const totalBreakWidth = ctx.breaks.reduce((sum, b) => sum + Math.abs(b.end - b.start), 0)
  return Math.max(0, ctx.totalRange - totalBreakWidth)
}

/**
 * 断轴签名（用于检测收敛）
 */
function breaksSignature(breaks: BreakInterval[]): string {
  return JSON.stringify(breaks.map((b) => [b.start, b.end]))
}

/**
 * 创建缓冲调整处理器
 */
function createBufferAdjustProcessor(bufferRatio: number = 0.2): BreakProcessor {
  return (ctx) => {
    if (ctx.breaks.length === 0) return ctx

    const normalMin = ctx.debug.normalMin
    const normalMax = ctx.debug.normalMax
    const normalRange = normalMax - normalMin

    if (normalRange <= 0) return ctx

    const buffer = normalRange * bufferRatio

    const adjusted = ctx.breaks.map((b) => {
      const isUpperBreak = b.start >= ctx.debug.b_upper
      const isLowerBreak = b.end <= ctx.debug.b_lower

      if (isUpperBreak) {
        const targetStart = normalMax + buffer
        if (Math.abs(b.start - targetStart) > 1e-6) {
          return { start: targetStart, end: b.end }
        }
      } else if (isLowerBreak) {
        const targetEnd = normalMin - buffer
        if (Math.abs(b.end - targetEnd) > 1e-6) {
          return { start: b.start, end: targetEnd }
        }
      }

      return b
    })

    return { ...ctx, breaks: adjusted }
  }
}

/**
 * 四舍五入到整数边界并移除非法区间
 */
const roundAndValidate: BreakProcessor = (ctx) => {
  const rounded = ctx.breaks.map((b) => {
    if (b.start < b.end) {
      return { start: Math.ceil(b.start), end: Math.ceil(b.end) }
    } else if (b.start > b.end) {
      return { start: Math.floor(b.start), end: Math.floor(b.end) }
    }
    return { start: b.start, end: b.end }
  })
  return { ...ctx, breaks: rounded }
}

/**
 * 创建最小宽度过滤处理器
 */
function createMinWidthFilterProcessor(minWidthRatio: number = 0.1): BreakProcessor {
  return (ctx) => {
    if (!ctx.visibleRange) return ctx
    const threshold = ctx.visibleRange * minWidthRatio
    const filtered = ctx.breaks.filter((b) => Math.abs(b.end - b.start) >= threshold)
    return { ...ctx, breaks: filtered }
  }
}

/**
 * 断轴后处理管道（带反馈循环，直到收敛）
 */
function processBreaksWithFeedback(
  initial: BreakContext,
  processors: BreakProcessor[],
  maxIters: number = 5,
): BreakContext {
  let lastSig = ''
  let ctx = initial

  for (let i = 0; i < maxIters; i++) {
    const centerVisible = calculateCenterVisible(ctx.breaks)
    const visibleRange = computeVisibleRange(ctx)
    ctx = { ...ctx, visibleRange, centerVisible }

    const { normalMin, normalMax } = calculateNormalBoundary(ctx.numericValues, ctx.centerVisible)
    ctx = { ...ctx, debug: { ...ctx.debug, normalMin, normalMax } }

    // 应用所有处理器
    for (const processor of processors) {
      ctx = processor(ctx)
    }

    const sig = breaksSignature(ctx.breaks)
    if (sig === lastSig) break
    lastSig = sig
  }

  return ctx
}

/**
 * 计算断轴
 * @param values 数值数组
 * @param config 断轴配置
 * @returns 断轴结果，如果未启用或数据不足则返回 null
 */
export function calculateBreakAxis(
  values: number[],
  config: BreakAxisConfig,
): BreakAxisResult | null {
  if (!config.enabled) return null

  // 数据量检查
  if (values.length < 4) return null

  const numericValues = values.filter((v) => typeof v === 'number' && !Number.isNaN(v))
  if (numericValues.length < 4) return null

  const minVal = Math.min(...numericValues)
  const maxVal = Math.max(...numericValues)
  const totalRange = maxVal - minVal

  if (totalRange <= 0) return null

  // 计算 IQR 断轴
  const { breaksUpper, breaksLower, debug } = calculateIQRBreakAxis(
    numericValues,
    config.k ?? 1.5,
    config.ignoreZero ?? true,
  )

  const breaks = combineRawBreaks(breaksUpper, breaksLower)
  if (breaks.length === 0) return null

  const centerVisible = calculateCenterVisible(breaks)
  const { normalMin, normalMax } = calculateNormalBoundary(numericValues, centerVisible)

  // 构建初始上下文
  const initialCtx: BreakContext = {
    numericValues,
    centerVisible,
    rawUpper: breaksUpper,
    rawLower: breaksLower,
    breaks,
    debug: {
      ...debug,
      normalMin,
      normalMax,
    },
    totalRange,
    minVal,
    maxVal,
    k: config.k ?? 1.5,
  }

  // 构建处理器管道
  const processors: BreakProcessor[] = [
    createBufferAdjustProcessor(config.bufferRatio ?? 0.2),
    roundAndValidate,
    createMinWidthFilterProcessor(config.minWidthRatio ?? 0.1),
  ]

  // 执行处理管道
  const processed = processBreaksWithFeedback(initialCtx, processors)

  return {
    breaks: processed.breaks,
    debug: processed.debug,
  }
}

/**
 * 断轴功能 Hook
 * 提供便捷的计算方法
 */
export function useBreakAxis() {
  return {
    calculateBreakAxis,
    calculateIQRBreakAxis,
  }
}

