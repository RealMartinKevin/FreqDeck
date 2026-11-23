/**
 * 已平仓交易：**窗口缓存 + 本地过滤 + 本地分页**。
 *
 * 为什么必须在前端做过滤（C4 实测）：`GET /trades` 只接受 `limit` / `offset` /
 * `order_by_id`，**没有 pair / exit_reason / 时间参数**。想让「筛选 + 分页 + 总数」
 * 三个语义同时正确，只能把窗口拉回来自己切：
 *
 *   打开已平仓 → 拉窗口（每页 500，最多 4 页 = 2000 笔，最新在前）
 *   → 本地过滤（pair / exit_reason / 时间）
 *   → 本地切片（offset / limit）
 *
 * 代价是「更早的记录不参与筛选」。这是上游限制、改前端消除不了，所以打满窗口时
 * 用 `reason='window_truncated'` 明确告诉用户，而不是假装全量。
 *
 * facet（下拉选项）**不走窗口**：`/stats` 与 `/performance` 覆盖**全部**已平仓交易，
 * 是精确全集。用窗口内的行去 distinct，交易一多就会漏掉早期 reasons/pairs。
 */

import { ApiFailure } from './errors'
import { get } from './http'
import { MAIN_ID, botName, mapClosedTradeRow, mapTradesFacets, stakeCurrency } from './mappers'
import { LIMIT_MAX, clampLimit, isoZ, num, tagOrNull } from './normalize'
import type {
  RawBalance,
  RawShowConfig,
  RawTradesPage,
  RawTradeRow,
  TradesFacets,
  TradesOut,
} from '../types'

/** 上游单页上限（超过不报错，只是截断） */
const PAGE_SIZE = LIMIT_MAX
/** 最多翻 4 页。再多就会把「打开持仓页」变成一个几十 MB 的下载 */
const MAX_PAGES = 4
/** 超过这个条数，筛选/分页就只在窗口内生效，必须告知用户 */
const WINDOW_CAPACITY = PAGE_SIZE * MAX_PAGES
/** 窗口缓存时间：短到能看见新成交，长到连续翻页不重复拉 */
const WINDOW_TTL_MS = 30_000
/** 已平仓是用户主动看的页面，超时给短一点，别让人对着空表格等 15s */
const TRADES_TIMEOUT_MS = 8_000

export interface TradesQuery {
  /** 形参保留以对齐旧 `client.ts` 签名，内部一律忽略（只有 main 一个实例） */
  instance_id: string
  exit_reason?: string
  pair?: string
  from?: string
  to?: string
  limit?: number
  offset?: number
}

interface TradesWindow {
  rows: RawTradeRow[]
  fetchedAt: number
  /** 窗口没装下全部已平仓交易 */
  truncated: boolean
}

let windowCache: TradesWindow | null = null
/** bot 名/计价币/facet 变化很慢，跟窗口一起缓存，避免每轮轮询多打 5 个请求 */
let contextCache: { value: TradesContext; fetchedAt: number } | null = null

/** 执行过强平/撤单后调用：下一次读取必须重新拉，否则用户看不到自己刚做的操作 */
export function invalidateTradesWindow(): void {
  windowCache = null
  contextCache = null
}

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */

async function loadWindow(signal?: AbortSignal): Promise<TradesWindow> {
  const rows: RawTradeRow[] = []
  let totalTrades = 0

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await get<RawTradesPage>('/api/v1/trades', {
      signal,
      timeoutMs: TRADES_TIMEOUT_MS,
      query: {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        // false = 按平仓时间倒序（最新在前）；前端不做二次排序，避免与上游口径打架
        order_by_id: 'false',
      },
    })
    totalTrades = num(res.total_trades) ?? totalTrades
    const batch = Array.isArray(res.trades) ? res.trades : []
    rows.push(...batch)
    // 不足一页说明已经是最后一页
    if (batch.length < PAGE_SIZE) break
  }

  return {
    rows,
    fetchedAt: Date.now(),
    // total 为 0 或缺失时判断不了，按「没截断」处理，避免误报
    truncated: totalTrades > 0 && rows.length < totalTrades,
  }
}

async function getWindow(signal: AbortSignal | undefined, force: boolean): Promise<TradesWindow> {
  const cached = windowCache
  if (!force && cached !== null && Date.now() - cached.fetchedAt < WINDOW_TTL_MS) return cached
  const fresh = await loadWindow(signal)
  windowCache = fresh
  return fresh
}

/* ------------------------------------------------------------------ *
 * facet 与被平仓交易无关的上下文（bot 名、计价币）
 * ------------------------------------------------------------------ */

interface TradesContext {
  instanceName: string
  stakeCurrency: string | null
  facets: TradesFacets
}

/**
 * 5 个小请求并发，任一失败只丢它自己那一份贡献：
 * 统计端点挂了不该让整张表格报错（facets 少几个选项，用户仍能看数据）。
 */
async function loadContext(signal?: AbortSignal): Promise<TradesContext> {
  const swallow = async <T>(promise: Promise<T>): Promise<T | null> => {
    try {
      return await promise
    } catch (error) {
      if (error instanceof ApiFailure && error.kind === 'aborted') throw error
      return null
    }
  }

  const [stats, performance, whitelist, show, balance] = await Promise.all([
    swallow(get<{ exit_reasons?: Record<string, unknown> }>('/api/v1/stats', { signal, timeoutMs: TRADES_TIMEOUT_MS })),
    swallow(get<{ pair?: string }[]>('/api/v1/performance', { signal, timeoutMs: TRADES_TIMEOUT_MS })),
    swallow(get<{ whitelist?: string[] }>('/api/v1/whitelist', { signal, timeoutMs: TRADES_TIMEOUT_MS })),
    swallow(get<RawShowConfig>('/api/v1/show_config', { signal, timeoutMs: TRADES_TIMEOUT_MS })),
    swallow(get<RawBalance>('/api/v1/balance', { signal, timeoutMs: TRADES_TIMEOUT_MS })),
  ])

  const exitReasons = stats === null ? [] : Object.keys(stats.exit_reasons ?? {})
  const pairs = (performance ?? []).map((row) => (typeof row.pair === 'string' ? row.pair : ''))
  const whitelistPairs = whitelist?.whitelist ?? []

  return {
    instanceName: botName(show),
    stakeCurrency: stakeCurrency(balance, show),
    facets: mapTradesFacets(exitReasons, pairs, whitelistPairs),
  }
}

async function getContext(signal: AbortSignal | undefined, force: boolean): Promise<TradesContext> {
  const cached = contextCache
  if (!force && cached !== null && Date.now() - cached.fetchedAt < WINDOW_TTL_MS) return cached.value
  const value = await loadContext(signal)
  contextCache = { value, fetchedAt: Date.now() }
  return value
}

/* ------------------------------------------------------------------ *
 * 本地过滤 / 分页
 * ------------------------------------------------------------------ */

/** 平仓时间（毫秒）；两个来源都没有 → null，这种行在按时间筛选时会被排除 */
function closeTimeMs(row: RawTradeRow): number | null {
  const iso = isoZ(row.close_date)
  if (iso !== null) {
    const parsed = Date.parse(iso)
    if (Number.isFinite(parsed)) return parsed
  }
  const stamp = num(row.close_timestamp)
  if (stamp === null) return null
  // 与 mappers 同一套单位判别：>1e11 视为毫秒
  return stamp > 1e11 ? stamp : stamp * 1000
}

function passesFilter(row: RawTradeRow, query: TradesQuery): boolean {
  if (query.pair && row.pair !== query.pair) return false
  if (query.exit_reason && tagOrNull(row.exit_reason) !== query.exit_reason) return false

  const from = query.from ? Date.parse(query.from) : NaN
  const to = query.to ? Date.parse(query.to) : NaN
  if (Number.isFinite(from) || Number.isFinite(to)) {
    const close = closeTimeMs(row)
    if (close === null) return false
    if (Number.isFinite(from) && close < from) return false
    // to 是「含当天」的语义：调用方传日期时补到当天 23:59:59.999 由它负责，
    // 这里只做纯比较，避免两个层各改一次语义
    if (Number.isFinite(to) && close > to) return false
  }
  return true
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

export interface FetchTradesOptions {
  signal?: AbortSignal
  /** 用户点「刷新」或刚执行过动作：跳过窗口缓存 */
  force?: boolean
}

export async function fetchTrades(query: TradesQuery, options: FetchTradesOptions = {}): Promise<TradesOut> {
  const limitRequested = num(query.limit) ?? 100
  const limit = clampLimit(query.limit, 100)
  const offset = Math.max(num(query.offset) ?? 0, 0)

  // 上下文先拿：即使窗口是 not_ready（观察模式），facets 与实际已平仓集合依然是精确的
  const context = await getContext(options.signal, options.force === true)

  let window: TradesWindow
  try {
    window = await getWindow(options.signal, options.force === true)
  } catch (error) {
    // 观察模式：说「没开交易」，不说「库坏了」（db_unavailable 的文案会把用户带偏）
    if (error instanceof ApiFailure && error.kind === 'not_ready') {
      return {
        instance_id: MAIN_ID,
        instance_name: context.instanceName,
        stake_currency: context.stakeCurrency,
        available: 'not_ready',
        reason: error.detail,
        rows: [],
        total: 0,
        limit_requested: limitRequested,
        limit,
        offset,
        facets: context.facets,
        schema_anomaly: 0,
      }
    }
    // 网络错误不伪装成空表：抛出去，页面出 errorbar 并保留旧数据
    throw error
  }

  const filtered = window.rows.filter((row) => passesFilter(row, query))
  const page = filtered.slice(offset, offset + limit)
  const rows = page.map(mapClosedTradeRow).filter((row) => row !== null)

  return {
    instance_id: MAIN_ID,
    instance_name: context.instanceName,
    stake_currency: context.stakeCurrency,
    available: 'ok',
    // 打满窗口时必须自曝：用户要知道「筛选只覆盖最近 2000 笔」
    reason: window.truncated && window.rows.length >= WINDOW_CAPACITY ? 'window_truncated' : null,
    rows,
    // 过滤后总数（与页码算法一致，offset 越界时仍是真实总数）
    total: filtered.length,
    limit_requested: limitRequested,
    limit,
    offset,
    facets: context.facets,
    // 两个合计信号同时缺失的行数：合计不可信时页面要能说明原因
    schema_anomaly: rows.filter((row) => row.pnl_abs === null && row.roe_pct === null).length,
  }
}
