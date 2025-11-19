/**
 * 断轴功能类型定义
 */

/** 断轴区间 */
export type BreakInterval = {
  start: number
  end: number
}

/** IQR 算法计算结果 */
export type IQRBreakAxisResult = {
  breaksUpper: BreakInterval[]
  breaksLower: BreakInterval[]
  debug: {
    Q1: number
    Q3: number
    IQR: number
    b_upper: number
    b_lower: number
    normalCount: number
    outlierCount: number
  }
}

/** 断轴调试信息（扩展版） */
export type BreakDebug = {
  Q1: number
  Q3: number
  IQR: number
  b_upper: number
  b_lower: number
  normalCount: number
  outlierCount: number
  normalMin: number // 正常值实际最小值
  normalMax: number // 正常值实际最大值
}

/** 断轴元数据（只包含原始数据，不包含计算出的中间数据） */
export type BreakMetadata = {
  numericValues: number[]
  totalRange: number
  iqrBounds: {
    b_upper: number
    b_lower: number
  }
}

/** 断轴处理器函数类型（纯管道模式） */
export type BreakProcessor = (breaks: BreakInterval[], metadata: BreakMetadata) => BreakInterval[]

/** 计算函数接口（用于依赖注入） */
export type BreakComputeFunctions = {
  /** 计算中心可见区间 */
  calculateCenterVisible: (breaks: BreakInterval[]) => [number, number]
  /** 计算正常值边界 */
  calculateNormalBoundary: (
    values: number[],
    centerVisible: [number, number],
  ) => { normalMin: number; normalMax: number }
  /** 计算可见范围 */
  computeVisibleRange: (breaks: BreakInterval[], totalRange: number) => number
}

/** 断轴配置 */
export type BreakAxisConfig = {
  /** 是否启用断轴 */
  enabled: boolean
  /** IQR 算法的 k 参数（默认 1.5） */
  k?: number
  /** 是否忽略零值 */
  ignoreZero?: boolean
  /** 缓冲比例（默认 0.2，即 20%） */
  bufferRatio?: number
  /** 最小断轴宽度比例（默认 0.1，即总范围的 10%） */
  minWidthRatio?: number
}

/** 断轴计算结果 */
export type BreakAxisResult = {
  breaks: BreakInterval[]
  debug: BreakDebug
}
