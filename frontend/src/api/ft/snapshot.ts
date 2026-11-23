/**
 * 单实例快照聚合：把 6 个端点并发拉回来，合成**一个** `InstanceOverview` + `totals`。
 *
 * 设计原则（§1.2）：**部分失败降级，不整页失败**。
 * `/daily` 挂了只是曲线空着，不该让「权益」也变成 —；但 `network` / `unauthorized`
 * 这类「跟这个实例说不上话」的错误要抛出去，让页面出 errorbar 而不是显示一堆 —。
 */

import { ApiFailure } from './errors'
import { get } from './http'
import {
  DAILY_TIMESCALE,
  MAIN_ID,
  apiStateOf,
  botName,
  mapDailyPoints,
  mapInstanceOverview,
  mapOpenPositions,
  mapOverviewTotals,
  stakeCurrency,
  unrealizedPnl,
} from './mappers'
import { num } from './normalize'
import type {
  InstanceAvailability,
  OverviewOut,
  PositionsOut,
  RawAppInfo,
  RawBalance,
  RawPeriod,
  RawProfit,
  RawShowConfig,
  RawStatusRow,
} from '../types'

/** 单个端点的结果：`value` 与 `failure` 恰好一个非空 */
interface Outcome<T> {
  value: T | null
  failure: ApiFailure | null
}

export interface SnapshotOptions {
  /** 页面卸载/切实例时取消；取消会以 `ApiFailure('aborted')` 抛出，调用方应当忽略 */
  signal?: AbortSignal
}

/**
 * 把一次 GET 收成 `Outcome`。
 * `aborted` 必须原样抛出：把它吞成「降级 null」会让「用户切走了」变成「数据没有了」。
 */
async function settle<T>(path: string, options: SnapshotOptions & { query?: Record<string, string | number> }): Promise<Outcome<T>> {
  try {
    const value = await get<T>(path, { signal: options.signal, query: options.query })
    return { value, failure: null }
  } catch (error) {
    if (error instanceof ApiFailure) {
      if (error.kind === 'aborted') throw error
      return { value: null, failure: error }
    }
    throw error
  }
}

/** `not_ready` 是「观察模式」而不是故障：降级成 null，不参与「API 挂了」的判定 */
function isNotReady(outcome: Outcome<unknown>): boolean {
  return outcome.failure?.kind === 'not_ready'
}

function reasonOf(outcome: Outcome<unknown>): string | null {
  return outcome.failure === null ? null : outcome.failure.detail
}

/**
 * 看板快照。
 * 6 个端点**并发**：串行时 `shell` 模式下每个 503 都要等一轮，首屏会明显卡顿。
 */
export async function fetchOverview(options: SnapshotOptions = {}): Promise<OverviewOut> {
  const [info, show, balance, profit, status, daily] = await Promise.all([
    settle<RawAppInfo>('/api/v1/app/info', options),
    settle<RawShowConfig>('/api/v1/show_config', options),
    settle<RawBalance>('/api/v1/balance', options),
    settle<RawProfit>('/api/v1/profit', options),
    settle<RawStatusRow[]>('/api/v1/status', options),
    settle<RawPeriod>('/api/v1/daily', { ...options, query: { timescale: DAILY_TIMESCALE } }),
  ])

  // 主端点 = 决定「这个实例到底是谁、有没有钱、有没有仓」
  const primaryFailures = [info, balance, profit, status].map((outcome) => outcome.failure).filter((failure) => failure !== null)
  const allPrimaryFailed = primaryFailures.length === 4

  // unauthorized 只要出现在任何一处就一定是会话问题，让看板显示「未授权」而不是「正常但空」
  const unauthorized = [show, daily].map((outcome) => outcome.failure).find((failure) => failure?.kind === 'unauthorized') ?? null

  const instance = mapInstanceOverview({
    app: info.value,
    show: show.value,
    balance: balance.value,
    profit: profit.value,
    status: status.value,
    daily: daily.value === null ? null : mapDailyPoints(daily.value.data ?? null),
    apiState: apiStateOf(info.failure ?? unauthorized),
    // 主端点全失败才给整页错误；单个端点失败由对应字段的 null 表达
    error: allPrimaryFailed ? { kind: primaryFailures[0]?.kind ?? 'server_error', detail: primaryFailures[0]?.detail ?? '' } : null,
  })

  return {
    generated_at: new Date().toISOString(),
    totals: mapOverviewTotals(instance),
    instances: [instance],
  }
}

/**
 * 持仓页数据。
 * 只拉 4 个端点（不需要 `/daily` 与 `/app/info`：本页不画曲线，模式由 mode store 提供）。
 *
 * 失败策略：`/status` 的 `not_ready` **不抛**——观察模式下「没在交易」要把整块换成
 * 空态并说明原因，而不是弹错误条；`network` 才抛（页面保留旧数据 + errorbar）。
 */
export async function fetchPositionsOpen(options: SnapshotOptions = {}): Promise<PositionsOut> {
  const [status, balance, profit, show] = await Promise.all([
    settle<RawStatusRow[]>('/api/v1/status', options),
    settle<RawBalance>('/api/v1/balance', options),
    settle<RawProfit>('/api/v1/profit', options),
    settle<RawShowConfig>('/api/v1/show_config', options),
  ])

  if (status.failure !== null && !isNotReady(status)) throw status.failure

  const name = botName(show.value)
  const currency = stakeCurrency(balance.value, show.value)
  const rows = mapOpenPositions(status.value, { instanceName: name, stakeCurrency: currency }) ?? []

  const available: InstanceAvailability['available'] =
    status.failure === null
      ? 'ok'
      : isNotReady(status)
        ? 'not_ready'
        : status.failure.kind === 'unauthorized'
          ? 'unauthorized'
          : 'unknown'

  const availability: InstanceAvailability = {
    instance_id: MAIN_ID,
    instance_name: name,
    available,
    // 观察模式下 `/status` 会抛 not_ready（业务态，不是故障）：把它表达成 available 枚举，
    // 而不是用 reason 含糊带过——页面的空态文案是照着这个枚举写的。
    reason: reasonOf(status),
  }

  return {
    generated_at: new Date().toISOString(),
    totals: {
      // 浮盈用 /profit 的差值口径（与看板同一个数），不 sum 行
      unrealized_abs: unrealizedPnl(profit.value),
      realized_abs: num(profit.value?.profit_closed_coin),
      equity_currency: currency,
      mixed_currency: false,
      // null = 不知道（/status 没拿到），显示 — 不显示 0
      open_trades: status.value === null ? null : status.value.length,
      complete: status.value !== null,
    },
    rows,
    availability: [availability],
  }
}
