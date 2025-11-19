/**
 * 断轴功能 Composable
 * 提供 IQR 双向断轴算法和断轴后处理管道
 * 采用纯管道模式 + 依赖注入设计
 */

import type {
  BreakInterval,
  BreakMetadata,
  BreakProcessor,
  BreakAxisConfig,
  BreakAxisResult,
  IQRBreakAxisResult,
  BreakComputeFunctions,
  BreakDebug,
} from '../types/breakAxis'

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
 * 创建计算函数工厂（依赖注入）
 */
function createComputeFunctions(): BreakComputeFunctions {
  /**
   * 计算中心可见区间
   */
  const calculateCenterVisible = (breaks: BreakInterval[]): [number, number] => {
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
   * 计算正常值边界（依赖 calculateCenterVisible）
   */
  const calculateNormalBoundary = (
    values: number[],
    centerVisible: [number, number],
  ): { normalMin: number; normalMax: number } => {
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
  const computeVisibleRange = (breaks: BreakInterval[], totalRange: number): number => {
    const totalBreakWidth = breaks.reduce((sum, b) => sum + Math.abs(b.end - b.start), 0)
    return Math.max(0, totalRange - totalBreakWidth)
  }

  return {
    calculateCenterVisible,
    calculateNormalBoundary,
    computeVisibleRange,
  }
}

/**
 * 断轴签名（用于检测收敛）
 */
function breaksSignature(breaks: BreakInterval[]): string {
  return JSON.stringify(breaks.map((b) => [b.start, b.end]))
}

/**
 * 创建缓冲调整处理器（依赖注入计算函数）
 */
function createBufferAdjustProcessor(
  computeFunctions: BreakComputeFunctions,
  bufferRatio: number = 0.2,
): BreakProcessor {
  return (breaks: BreakInterval[], metadata: BreakMetadata) => {
    if (breaks.length === 0) return breaks

    // 使用注入的计算函数
    const centerVisible = computeFunctions.calculateCenterVisible(breaks)
    const { normalMin, normalMax } = computeFunctions.calculateNormalBoundary(
      metadata.numericValues,
      centerVisible,
    )

    const normalRange = normalMax - normalMin
    if (normalRange <= 0) return breaks

    const buffer = normalRange * bufferRatio

    const adjusted = breaks.map((b) => {
      const isUpperBreak = b.start >= metadata.iqrBounds.b_upper
      const isLowerBreak = b.end <= metadata.iqrBounds.b_lower

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

    return adjusted
  }
}

/**
 * 四舍五入到整数边界并移除非法区间（纯函数，无依赖）
 */
const roundAndValidate: BreakProcessor = (breaks: BreakInterval[]) => {
  return breaks.map((b) => {
    if (Math.abs(b.start) < Math.abs(b.end)) {
      return { start: Math.ceil(b.start), end: Math.ceil(b.end) }
    } else {
      return { start: Math.floor(b.start), end: Math.floor(b.end) }
    }
  })
}

/**
 * 创建最小宽度过滤处理器（依赖注入计算函数）
 */
function createMinWidthFilterProcessor(
  computeFunctions: BreakComputeFunctions,
  minWidthRatio: number = 0.1,
): BreakProcessor {
  return (breaks: BreakInterval[], metadata: BreakMetadata) => {
    // 使用注入的计算函数
    const visibleRange = computeFunctions.computeVisibleRange(breaks, metadata.totalRange)
    const threshold = visibleRange * minWidthRatio
    return breaks.filter((b) => Math.abs(b.end - b.start) >= threshold)
  }
}

/**
 * 纯管道处理（无反馈循环）
 */
function processBreaksPipeline(
  breaks: BreakInterval[],
  metadata: BreakMetadata,
  processors: BreakProcessor[],
): BreakInterval[] {
  let result = breaks
  for (const processor of processors) {
    result = processor(result, metadata)
  }
  return result
}

/**
 * 带反馈循环的断轴处理
 */
function processBreaksWithFeedback(
  initialBreaks: BreakInterval[],
  metadata: BreakMetadata,
  processors: BreakProcessor[],
  computeFunctions: BreakComputeFunctions,
  maxIters: number = 5,
): BreakInterval[] {
  let lastSig = ''
  let breaks = initialBreaks

  for (let i = 0; i < maxIters; i++) {
    // 执行管道处理
    breaks = processBreaksPipeline(breaks, metadata, processors)

    // 检测收敛
    const sig = breaksSignature(breaks)
    if (sig === lastSig) break
    lastSig = sig
  }

  return breaks
}

/**
 * 计算最终调试信息（在管道外部）
 */
function computeFinalDebug(
  breaks: BreakInterval[],
  metadata: BreakMetadata,
  iqrDebug: IQRBreakAxisResult['debug'],
  computeFunctions: BreakComputeFunctions,
): BreakDebug {
  const centerVisible = computeFunctions.calculateCenterVisible(breaks)
  const { normalMin, normalMax } = computeFunctions.calculateNormalBoundary(
    metadata.numericValues,
    centerVisible,
  )

  return {
    ...iqrDebug,
    normalMin,
    normalMax,
  }
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
  const {
    breaksUpper,
    breaksLower,
    debug: iqrDebug,
  } = calculateIQRBreakAxis(numericValues, config.k ?? 1.5, config.ignoreZero ?? true)

  const initialBreaks = combineRawBreaks(breaksUpper, breaksLower)
  if (initialBreaks.length === 0) return null

  // 创建元数据（只包含原始数据）
  const metadata: BreakMetadata = {
    numericValues,
    totalRange,
    iqrBounds: {
      b_upper: iqrDebug.b_upper,
      b_lower: iqrDebug.b_lower,
    },
  }

  // 创建计算函数（依赖注入）
  const computeFunctions = createComputeFunctions()

  // 构建处理器管道（注入计算函数）
  const processors: BreakProcessor[] = [
    createBufferAdjustProcessor(computeFunctions, config.bufferRatio ?? 0.2),
    roundAndValidate,
    createMinWidthFilterProcessor(computeFunctions, config.minWidthRatio ?? 0.1),
  ]

  // 执行带反馈循环的处理
  const finalBreaks = processBreaksWithFeedback(
    initialBreaks,
    metadata,
    processors,
    computeFunctions,
  )

  // 计算最终调试信息（在管道外部）
  const finalDebug = computeFinalDebug(finalBreaks, metadata, iqrDebug, computeFunctions)

  return {
    breaks: finalBreaks,
    debug: finalDebug,
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
