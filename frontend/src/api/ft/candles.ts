/**
 * K 线取数：`/pair_candles` 的**列矩阵** → `CandleBar[]` + `ChartMarker[]`。
 *
 * 实测形状（`.probe/pair_candles.json`）：`data` 是行式二维数组，列名在 `columns[]`
 * （34 列，随策略变），尾部混着 `__date_ts`（毫秒）与 4 个 `_*_signal_close` 列。
 * 所以取列只能 `columns.indexOf(name)`，任何硬编码下标都会在换策略后**静默错列**。
 */

import { ApiFailure } from './errors'
import { get } from './http'
import { MAIN_ID, mapChartMeta, parsePairCandles } from './mappers'
import { LIMIT_MAX, clampLimit, isoZ, num } from './normalize'
import type { CandlesOut, ChartMetaOut, RawAppInfo, RawPairCandles, RawShowConfig } from '../types'

/** 图表默认根数：5m × 300 ≈ 一整天，再多对屏幕像素没有意义 */
const DEFAULT_LIMIT = 300
/** pair_candles 要读交易所缓存，比普通端点慢，超时给宽一点 */
const CANDLES_TIMEOUT_MS = 12_000

export interface CandleQuery {
  pair: string
  /** 缺省时取 `/show_config.timeframe`（用户没选就跟随 bot 的粒度） */
  timeframe?: string
  limit?: number
}

/**
 * 上游 timeframe 有两种形态：`/show_config` 给 `"5m"`，`/status` 给数字 `5`。
 * 图表接口只认 `"5m"`，所以统一在这里归一；数字一律按「分钟」解释（freqtrade 约定）。
 */
export function normalizeTimeframe(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}m`
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  if (/^\d+$/.test(text)) return `${text}m`
  return text
}

async function fetchShowConfig(signal?: AbortSignal): Promise<RawShowConfig | null> {
  try {
    return await get<RawShowConfig>('/api/v1/show_config', { signal, timeoutMs: CANDLES_TIMEOUT_MS })
  } catch (error) {
    if (error instanceof ApiFailure && error.kind === 'aborted') throw error
    // 策略/粒度只是「默认值」，拿不到不该让 K 线整页失败
    return null
  }
}

/**
 * 拉 K 线。
 *
 * 失败不在这里吞：`not_ready`（观察模式）与 `invalid`（pair 非法，HTTP 400）
 * 是两种完全不同的用户动作（切模式 / 重选交易对），交给页面判断。
 */
export async function fetchCandles(instanceId: string, params: CandleQuery, signal?: AbortSignal): Promise<CandlesOut> {
  const requested = num(params.limit) ?? DEFAULT_LIMIT
  const limitEffective = clampLimit(params.limit, DEFAULT_LIMIT)

  // timeframe 未指定时得先知道配置里的粒度；顺序上先发 show_config，别白等两次往返
  const showPromise = fetchShowConfig(signal)
  let timeframe = normalizeTimeframe(params.timeframe)
  if (timeframe === null) {
    const show = await showPromise
    timeframe = normalizeTimeframe(show?.timeframe)
  }
  if (timeframe === null) {
    // 连粒度都不知道就没法请求：这是「后端没就绪」，不是「这个 pair 没数据」
    throw new ApiFailure('not_ready', { detail: '未取到策略时间周期，暂不能加载 K 线' })
  }

  const [raw] = await Promise.all([
    get<RawPairCandles>('/api/v1/pair_candles', {
      signal,
      timeoutMs: CANDLES_TIMEOUT_MS,
      query: { pair: params.pair, timeframe, limit: limitEffective },
    }),
    showPromise,
  ])

  const parsed = parsePairCandles(raw)

  return {
    instance_id: MAIN_ID,
    pair: typeof raw.pair === 'string' && raw.pair ? raw.pair : params.pair,
    timeframe,
    // 上游真实粒度（可能被策略的 informative 改写）
    base_timeframe: normalizeTimeframe(raw.timeframe),
    // 前端不做多周期聚合派生：上游给什么画什么
    derived_from: null,
    limit_requested: requested,
    limit_effective: limitEffective,
    bars: parsed.bars,
    markers: parsed.markers,
    scope: {
      bar_count: parsed.bars.length,
      // data_start/data_stop 是 `+00:00` 形态，isoZ 兼容；比较时请用 Date.parse 而非字符串全等
      earliest_time: isoZ(raw.data_start),
      latest_time: isoZ(raw.data_stop),
      truncated: parsed.bars.length < requested,
      upstream_length: num(raw.length) ?? parsed.bars.length,
      overlay_missing: parsed.overlayMissing,
    },
    // 空窗口不是错误：可能这个 pair 刚上架，或 bot 还没缓存到这段
    reason: parsed.bars.length === 0 ? 'empty_window' : null,
  }
}

/**
 * 图表头部元信息：白名单、选币链、粒度、策略。
 * 三处数据任一失败都只降级对应字段（`pair_whitelist` 用 `[]` 而不是 null：
 * 契约里它是数组，组件据此走空态）。
 */
export async function fetchChartMeta(instanceId: string, signal?: AbortSignal): Promise<ChartMetaOut> {
  const swallow = async <T>(promise: Promise<T>): Promise<{ value: T | null; reason: string | null }> => {
    try {
      return { value: await promise, reason: null }
    } catch (error) {
      if (error instanceof ApiFailure && error.kind === 'aborted') throw error
      return { value: null, reason: error instanceof ApiFailure ? error.detail : '未知错误' }
    }
  }

  const [whitelist, show, info] = await Promise.all([
    swallow(get<{ whitelist?: string[]; method?: string[] }>('/api/v1/whitelist', { signal, timeoutMs: CANDLES_TIMEOUT_MS })),
    swallow(get<RawShowConfig>('/api/v1/show_config', { signal, timeoutMs: CANDLES_TIMEOUT_MS })),
    swallow(get<RawAppInfo>('/api/v1/app/info', { signal, timeoutMs: CANDLES_TIMEOUT_MS })),
  ])

  const pairs = Array.isArray(whitelist.value?.whitelist) ? (whitelist.value?.whitelist ?? []) : []
  const methods = Array.isArray(whitelist.value?.method) ? (whitelist.value?.method ?? []) : []
  const timeframe = normalizeTimeframe(show.value?.timeframe)
  // shell 模式下 /app/info.strategy 可能为 null（未加载策略）→ 回退配置里的 strategy
  const strategy = info.value?.strategy ?? show.value?.strategy ?? null

  return mapChartMeta(pairs, methods, timeframe, strategy, whitelist.reason)
}

/** 供图表页显示「最多 500 根」的硬上限 */
export const CANDLE_LIMIT_MAX = LIMIT_MAX
