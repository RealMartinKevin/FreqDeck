/**
 * 统计页聚合：9 个端点并发，**单段失败只影响自己**。
 *
 * `errors{}` 的键是段名、值是 `"kind: detail"`：统计页要能逐段说明
 * 「这一段没取到、为什么」，而不是整页变成一条红字。只看得到结论、
 * 看不到哪一段缺口，用户会以为策略盈利归零了。
 *
 * 两个口径不能伪造（设计 §2.5）：
 *   - `profit_all.long/short` **恒为 null**：后端没有按方向拆分的端点，
 *     前端凭 pair 去猜方向会得出一个「看似合理但错」的多空对比。
 *   - `winrate` / `profit_pct` 一族**已是百分数**，直取，不再 ×100。
 */

import { ApiFailure } from './errors'
import { get } from './http'
import { MAIN_ID, botName, stakeCurrency } from './mappers'
import { num } from './normalize'
import type {
  AnalyticsOut,
  ExitReasonStat,
  ObserveAvailability,
  PairPerf,
  PeriodOut,
  ProfitBucket,
  RawBalance,
  RawProfit,
  RawShowConfig,
  TagPerf,
} from '../types'

export interface AnalyticsQuery {
  days?: number
  weeks?: number
  months?: number
}

const DEFAULT_DAYS = 30
const DEFAULT_WEEKS = 12
const DEFAULT_MONTHS = 12
/** 统计端点要扫全库，比看板慢，超时给宽 */
const ANALYTICS_TIMEOUT_MS = 20_000

function availabilityOf(failure: ApiFailure): ObserveAvailability {
  switch (failure.kind) {
    case 'not_ready':
      return 'not_ready'
    case 'network':
      return 'api_unreachable'
    case 'unauthorized':
      return 'unauthorized'
    case 'invalid':
      return 'unsupported'
    default:
      return 'unknown'
  }
}

/** `ProfitBucket` 里「一旦存在就必须是数字」的字段（没有 null 位） */
const BUCKET_STRICT_NUMBERS = [
  'profit_closed_coin',
  'profit_closed_percent',
  'profit_closed_ratio',
  'profit_all_coin',
  'profit_all_percent',
  'profit_all_ratio',
  'closed_trade_count',
  'winning_trades',
  'losing_trades',
] as const

/** `ProfitBucket` 里允许为 null 的数字字段（null = 后端没给这个数，不是 0） */
const BUCKET_NULLABLE_NUMBERS = [
  'best_rate',
  'winrate',
  'profit_factor',
  'expectancy',
  'sharpe',
  'sortino',
  'max_drawdown',
  'max_drawdown_abs',
  'current_drawdown',
  'trading_volume',
] as const

/** `ProfitBucket` 里允许为 null 的字符串字段 */
const BUCKET_STRINGS = ['first_trade_date', 'latest_trade_date', 'avg_duration', 'best_pair'] as const

/**
 * `RawProfit`（值可能是 null）→ `ProfitBucket`。
 *
 * 为什么必须逐键搬：`ProfitBucket` 有一批**不接受 null** 的字段，直接把
 * `RawProfit` 铺过去会在「后端返回 null」时填进一个非法的 null；而补 0
 * 又会让「不知道」变成「确实是零」，统计页会显示一排假的 0。
 * 这里的取舍是：严格数字字段 null 就不写（界面显示 —），可空字段保留 null。
 */
function bucketOf(raw: RawProfit): ProfitBucket {
  const bucket: ProfitBucket = {}

  for (const key of BUCKET_STRICT_NUMBERS) {
    const value = num(raw[key])
    if (value !== null) bucket[key] = value
  }
  for (const key of BUCKET_NULLABLE_NUMBERS) {
    bucket[key] = num(raw[key])
  }
  for (const key of BUCKET_STRINGS) {
    const value = raw[key]
    bucket[key] = typeof value === 'string' && value.trim() ? value : null
  }

  return bucket
}

/**
 * 周期端点（`/daily` `/weekly` `/monthly`）的 `data` 是**倒序**（最新在前）。
 *
 * 统计页要两件事，且都建立在同一个前提上：**数组升序**
 *   - 日表「最新在上」= 升序 + `slice(-14).reverse()`
 *   - 周/月柱「时间轴从左到右」= 升序 + `slice(-12)`
 * 视图层只做 slice/reverse，所以归一化必须在这里一次做完——与 `mapDailyPoints()`
 * （看板那条路径）完全同一套做法，否则同一个后端响应在两条路径上顺序相反。
 */
function sortPeriodAsc(period: PeriodOut | null): PeriodOut | null {
  if (period === null) return null
  const rows = Array.isArray(period.data) ? period.data : []
  if (rows.length < 2) return period
  return { ...period, data: [...rows].sort((a, b) => a.date.localeCompare(b.date)) }
}

export async function fetchAnalytics(
  instanceId: string,
  params: AnalyticsQuery = {},
  signal?: AbortSignal,
): Promise<AnalyticsOut> {
  const days = Number.isFinite(Number(params.days)) ? Number(params.days) : DEFAULT_DAYS
  const weeks = Number.isFinite(Number(params.weeks)) ? Number(params.weeks) : DEFAULT_WEEKS
  const months = Number.isFinite(Number(params.months)) ? Number(params.months) : DEFAULT_MONTHS

  const errors: Record<string, string> = {}
  /** 段名 → 失败对象（抛/降级的判断要用 kind，不只是字符串） */
  const segmentFailures = new Map<string, ApiFailure>()

  const capture = async <T>(segment: string, path: string, query?: Record<string, string | number>): Promise<T | null> => {
    try {
      return await get<T>(path, { signal, timeoutMs: ANALYTICS_TIMEOUT_MS, query })
    } catch (error) {
      if (error instanceof ApiFailure && error.kind === 'aborted') throw error
      const failure = error instanceof ApiFailure ? error : null
      errors[segment] = `${failure?.kind ?? 'unknown'}: ${failure?.detail ?? '未知错误'}`
      if (failure) segmentFailures.set(segment, failure)
      return null
    }
  }

  const [profit, stats, performance, entries, exits, mixTags, daily, weekly, monthly, balance, show] = await Promise.all([
    capture<RawProfit>('profit', '/api/v1/profit'),
    capture<{ exit_reasons?: Record<string, ExitReasonStat>; durations?: Record<string, number | null> }>(
      'stats',
      '/api/v1/stats',
    ),
    capture<PairPerf[]>('performance', '/api/v1/performance'),
    capture<TagPerf[]>('entries', '/api/v1/entries'),
    capture<TagPerf[]>('exits', '/api/v1/exits'),
    capture<TagPerf[]>('mix_tags', '/api/v1/mix_tags'),
    capture<PeriodOut>('daily', '/api/v1/daily', { timescale: days }),
    capture<PeriodOut>('weekly', '/api/v1/weekly', { timescale: weeks }),
    capture<PeriodOut>('monthly', '/api/v1/monthly', { timescale: months }),
    capture<RawBalance>('balance', '/api/v1/balance'),
    capture<RawShowConfig>('show_config', '/api/v1/show_config'),
  ])

  const profitFailure = segmentFailures.get('profit') ?? null

  // 主端点网络/鉴权失败 → 抛：页面统一走 errorbar（保留旧数据），不伪装成「统计为空」
  if (profitFailure !== null && (profitFailure.kind === 'network' || profitFailure.kind === 'unauthorized')) {
    throw profitFailure
  }

  const available: ObserveAvailability = profitFailure === null ? 'ok' : availabilityOf(profitFailure)
  const reason = profitFailure === null ? null : profitFailure.detail

  return {
    instance_id: MAIN_ID,
    instance_name: botName(show),
    available,
    reason,
    days,
    weeks,
    months,
    // 计价币：/balance.stake（USDT）优先，回退周期端点给的同名字段
    stake_currency: stakeCurrency(balance, show) ?? daily?.stake_currency ?? null,
    profit_all:
      profit === null
        ? null
        : {
            all: bucketOf(profit),
            // ★ 后端没有按方向拆分的端点：恒 null，绝不伪造
            long: null,
            short: null,
          },
    stats: stats === null ? null : { exit_reasons: stats.exit_reasons ?? {}, durations: stats.durations ?? {} },
    performance: performance ?? null,
    entries: entries ?? null,
    exits: exits ?? null,
    mix_tags: mixTags ?? null,
    // 三段的 data 一律升序（见 sortPeriodAsc）：视图层的 slice/reverse 才成立
    daily: sortPeriodAsc(daily),
    weekly: sortPeriodAsc(weekly),
    monthly: sortPeriodAsc(monthly),
    errors,
  }
}
