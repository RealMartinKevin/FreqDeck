/**
 * 字段级映射：freqtrade 原始响应 → `types.ts` 既有契约。
 *
 * 全部是纯函数：不发请求、不缓存、不读时钟（除了 `generated_at` 由调用方传）。
 * 这样「口径错」就只可能错在这一个文件里，对拍 `.probe/*.json` 能一眼定位。
 *
 * 三条口径铁律（设计 §2 / §3）在这里落地，不许在被调用方再改：
 *   1. `profit_pct` / `winrate` / `close_profit_pct` **已是百分数且含杠杆**，
 *      直取；禁止 ×100、禁止乘 leverage。
 *   2. 金额回退链一律 `??`，**绝不 `||` / `?? 0`**：null=不知道、0=确实是零。
 *   3. 时间统一 `isoZ()` 成 ISO Z。
 */

import { isoZ, num, pctFromRatio, tagOrNull, truthySignal, utcToday } from './normalize'
import type {
  ApiState,
  BotState,
  CandleBar,
  ChartMarker,
  ChartMetaOut,
  ClosedTradeRow,
  DailyPoint,
  InstanceOverview,
  OpenPositionRow,
  OverviewTotals,
  PositionOut,
  RawAppInfo,
  RawBalance,
  RawPairCandles,
  RawPeriodPoint,
  RawProfit,
  RawShowConfig,
  RawStatusRow,
  RawTradeRow,
  TradesFacets,
} from '../types'

/** 虚拟单实例 id。保留它是因为既有组件/契约里到处有 `instance_id`，让它有值即可零改动 */
export const MAIN_ID = 'main'

/** `/show_config.bot_name` 为空时的兜底名（空串不是合法名字） */
export const DEFAULT_BOT_NAME = '本机 Bot'

/** `/daily` 默认窗口：30 天足够画曲线，取太多会把首屏拖慢 */
export const DAILY_TIMESCALE = 30

/* ------------------------------------------------------------------ *
 * 时间
 * ------------------------------------------------------------------ */

/**
 * 上游时间戳有两种单位：`/logs` 的 `ts_ms` 是毫秒，`TradeSchema.open_timestamp`
 * 实测也是毫秒（1795374772496），但 freqtrade 历史版本给过秒。
 * 用 1e11（≈1973 年的毫秒值）当分界线不会误判本世纪的任何时间戳。
 */
function msFromTimestamp(value: unknown): number | null {
  const raw = num(value)
  if (raw === null) return null
  return raw > 1e11 ? raw : raw * 1000
}

/** 优先用 ISO 文本，缺失才回退数值时间戳；两者都没有 → null（不造 1970） */
export function isoFromEither(iso: unknown, timestamp: unknown): string | null {
  const direct = isoZ(iso)
  if (direct !== null) return direct
  const ms = msFromTimestamp(timestamp)
  if (ms === null) return null
  const date = new Date(ms)
  if (!Number.isFinite(date.getTime())) return null
  return date.toISOString()
}

/* ------------------------------------------------------------------ *
 * 实例身份 / 状态
 * ------------------------------------------------------------------ */

export function botName(show: RawShowConfig | null): string {
  const name = show?.bot_name
  return typeof name === 'string' && name.trim() ? name.trim() : DEFAULT_BOT_NAME
}

/** `stake`（USDT）才是计价币；`symbol`（USD）是法币显示币，用它会让所有金额单位错 */
export function stakeCurrency(balance: RawBalance | null, show: RawShowConfig | null): string | null {
  const fromBalance = balance?.stake
  if (typeof fromBalance === 'string' && fromBalance.trim()) return fromBalance.trim()
  const fromConfig = show?.stake_currency
  if (typeof fromConfig === 'string' && fromConfig.trim()) return fromConfig.trim()
  return null
}

/**
 * 交易态。注意 `trade && !trading_active` 必须是 `unknown` 而不是 `stopped`：
 * 进程正在爬起来，写 stopped 会被用户读成「我故意停的」。
 */
export function mapBotState(app: RawAppInfo | null, show: RawShowConfig | null): BotState {
  if (show?.state === 'paused') return 'paused'
  if (!app) return 'unknown'
  if (app.mode === 'shell') return 'stopped'
  if (app.mode === 'trade') return app.trading_active === true ? 'running' : 'unknown'
  return 'unknown'
}

/**
 * 聚合层的成败 → 看板左上角那个「连得上/没授权」的灯。
 * 判定只依赖**主端点**（`/app/info`）的结果：其它端点 503 是「bob 没在交易」，
 * 不是「API 挂了」，那种情况 api_state 仍然是 ok。
 */
export function apiStateOf(failure: { kind: string } | null): ApiState {
  if (!failure) return 'ok'
  if (failure.kind === 'network') return 'unreachable'
  if (failure.kind === 'unauthorized') return 'unauthorized'
  return 'error'
}

/* ------------------------------------------------------------------ *
 * `/daily` → DailyPoint[]
 * ------------------------------------------------------------------ */

/**
 * 按日盈亏。上游 `data` 是**倒序**（最新在前），曲线和表格都要升序，这里排好。
 * 缺任一必需数值的点整点丢弃：曲线宁可少一个点，也不能出现伪造的 0
 * （伪造的 0 会被读成「那天打平」，直接影响用户的判断）。
 */
export function mapDailyPoints(raw: readonly RawPeriodPoint[] | null): DailyPoint[] | null {
  if (raw === null) return null
  const points: DailyPoint[] = []
  for (const row of raw) {
    const date = typeof row.date === 'string' ? row.date.trim() : ''
    const absProfit = num(row.abs_profit)
    const relProfit = num(row.rel_profit)
    const tradeCount = num(row.trade_count)
    if (!date || absProfit === null || relProfit === null || tradeCount === null) continue
    points.push({
      date,
      abs_profit: absProfit,
      rel_profit: relProfit,
      trade_count: tradeCount,
      starting_balance: num(row.starting_balance),
    })
  }
  points.sort((a, b) => a.date.localeCompare(b.date))
  return points
}

/**
 * 今日（UTC）。找不到 → null：「后端没给今天」不等于「今天没成交」，
 * 两种情况在界面上的文案完全不同（— + 原因 vs 0）。
 */
export function mapToday(daily: DailyPoint[] | null): { date: string; abs_profit: number; trade_count: number } | null {
  if (!daily) return null
  const today = utcToday()
  const hit = daily.find((point) => point.date === today)
  if (!hit) return null
  return { date: hit.date, abs_profit: hit.abs_profit, trade_count: hit.trade_count }
}

/* ------------------------------------------------------------------ *
 * `/status[]` → OpenPositionRow
 * ------------------------------------------------------------------ */

export interface PositionContext {
  instanceName: string
  stakeCurrency: string | null
}

/**
 * 当前价：**直取 `current_rate`**（实测 `/status` 有该字段，C1 裁决）。
 * 公式只做兜底，且 **short 必须换号** —— 不换会把整列浮盈反号，
 * 而且看起来「像真的」（数字都在合理区间内）。
 */
export function currentRateOf(raw: RawStatusRow): number | null {
  const direct = num(raw.current_rate)
  if (direct !== null) return direct
  const openRate = num(raw.open_rate)
  const ratio = num(raw.profit_ratio)
  if (openRate === null || ratio === null) return null
  const isShort = raw.is_short === true
  return openRate * (1 + (isShort ? -ratio : ratio))
}

/**
 * 距止损（百分数，取绝对值）。契约语义是「距离多远」，符号没有意义；
 * 有符号版本留给看板另行计算。
 */
export function stoplossDistancePct(raw: RawStatusRow, currentRate: number | null): number | null {
  const direct = num(raw.stoploss_current_dist_pct)
  if (direct !== null) return Math.abs(direct)
  const stopAbs = num(raw.stop_loss_abs)
  if (currentRate === null || currentRate === 0 || stopAbs === null) return null
  // 这里 ×100 是「比例→百分数」的唯一合法处之一（设计 §3 的 grep 白名单）
  return Math.abs(((currentRate - stopAbs) / currentRate) * 100)
}

/**
 * 单行持仓。`trade_id` / `pair` 是行的身份：缺了这行就没有意义，
 * 返回 null 让调用方丢弃 —— 比补 `trade_id: 0` 好，补 0 会让强平按钮点到「0 号单」。
 */
export function mapOpenPosition(raw: RawStatusRow, ctx: PositionContext): OpenPositionRow | null {
  const tradeId = num(raw.trade_id)
  const pair = typeof raw.pair === 'string' ? raw.pair.trim() : ''
  if (tradeId === null || !pair) return null
  const currentRate = currentRateOf(raw)
  return {
    instance_id: MAIN_ID,
    instance_name: ctx.instanceName,
    stake_currency: ctx.stakeCurrency,
    trade_id: tradeId,
    pair,
    side: raw.is_short === true ? 'short' : 'long',
    leverage: num(raw.leverage),
    open_rate: num(raw.open_rate),
    current_rate: currentRate,
    amount: num(raw.amount),
    stake_amount: num(raw.stake_amount),
    // 两者实测同值；都为 null → null（不 sum /status，单行口径更可靠）
    unrealized_abs: num(raw.total_profit_abs) ?? num(raw.profit_abs),
    // ★ 已是百分数且含杠杆：直取 profit_pct，绝不 ×100、绝不乘 leverage
    roe_pct: num(raw.profit_pct) ?? pctFromRatio(raw.profit_ratio),
    stoploss_distance_pct: stoplossDistancePct(raw, currentRate),
    open_time: isoFromEither(raw.open_date, raw.open_timestamp) ?? '',
    enter_tag: tagOrNull(raw.enter_tag),
    // ★ 复数：抄成 has_open_order 会让「取消挂单」永远置灰
    has_open_order: raw.has_open_orders === true,
  }
}

export function mapOpenPositions(raw: readonly RawStatusRow[] | null, ctx: PositionContext): OpenPositionRow[] | null {
  if (raw === null) return null
  const rows: OpenPositionRow[] = []
  for (const row of raw) {
    const mapped = mapOpenPosition(row, ctx)
    if (mapped !== null) rows.push(mapped)
  }
  return rows
}

/**
 * 看板预览用的旧契约 `PositionOut`（字段全是非空数字）。
 * 缺任一必需数字 → 丢弃该行，**不补 0**：伪造的 0 在持仓表里看起来像「打平」。
 * 实测 `/status` 这些字段齐全，这条路径基本不会触发，是安全网。
 *
 * ⚠️ 刻意取舍：预览行是**严格数字契约**，缺字段就丢行；而 `open_trades` 来自
 * `status.length`（后端说有几笔就是几笔）。所以「持仓 N 笔」与预览表渲染出的行数
 * 可能差 1——这是设计选择（宁可少一行，也不让表里出现 0），不是 bug。
 * 不要为了对齐行数去改 `open_trades` 的口径：那会让「有几笔持仓」变成一个猜测值。
 */
export function mapPositionPreview(raw: RawStatusRow): PositionOut | null {
  const tradeId = num(raw.trade_id)
  const pair = typeof raw.pair === 'string' ? raw.pair.trim() : ''
  const amount = num(raw.amount)
  const openRate = num(raw.open_rate)
  const currentRate = currentRateOf(raw)
  const stakeAmount = num(raw.stake_amount)
  const unrealized = num(raw.total_profit_abs) ?? num(raw.profit_abs)
  if (
    tradeId === null ||
    !pair ||
    amount === null ||
    openRate === null ||
    currentRate === null ||
    stakeAmount === null ||
    unrealized === null
  ) {
    return null
  }
  const strategy = typeof raw.strategy === 'string' ? raw.strategy : ''
  return {
    trade_id: tradeId,
    pair,
    side: raw.is_short === true ? 'short' : 'long',
    amount,
    open_rate: openRate,
    current_rate: currentRate,
    stake_amount: stakeAmount,
    unrealized_pnl: unrealized,
    unrealized_pnl_ratio: num(raw.total_profit_ratio) ?? num(raw.profit_ratio),
    stoploss_distance_pct: stoplossDistancePct(raw, currentRate),
    open_time: isoFromEither(raw.open_date, raw.open_timestamp) ?? '',
    strategy,
    enter_tag: tagOrNull(raw.enter_tag),
    has_open_order: raw.has_open_orders === true,
  }
}

/* ------------------------------------------------------------------ *
 * `/balance` + `/profit` → 金额口径
 * ------------------------------------------------------------------ */

/** 浮盈 = 全部 − 已平仓。用差值而不是 sum(/status)：零持仓时也有值，且不会因某行缺字段少算 */
export function unrealizedPnl(profit: RawProfit | null): number | null {
  const all = num(profit?.profit_all_coin)
  const closed = num(profit?.profit_closed_coin)
  if (all === null || closed === null) return null
  return all - closed
}

/* ------------------------------------------------------------------ *
 * `InstanceOverview` + `OverviewTotals`
 * ------------------------------------------------------------------ */

export interface OverviewParts {
  app: RawAppInfo | null
  show: RawShowConfig | null
  balance: RawBalance | null
  profit: RawProfit | null
  /** `/status` 失败时传 null（= 不知道，不是 0 笔） */
  status: readonly RawStatusRow[] | null
  daily: DailyPoint[] | null
  apiState: ApiState
  /** 主端点全失败才有值 */
  error: { kind: string; detail: string } | null
}

export function mapInstanceOverview(parts: OverviewParts): InstanceOverview {
  const name = botName(parts.show)
  const currency = stakeCurrency(parts.balance, parts.show)
  const daily = parts.daily
  const positions = parts.status === null ? null : parts.status.map(mapPositionPreview).filter((row): row is PositionOut => row !== null)

  return {
    id: MAIN_ID,
    name,
    base_url: typeof location === 'undefined' ? '' : location.origin,
    // 能读到 `/app/info` 就说明进程活着；本系统不管进程，所以不用 not_managed
    process_state: 'running',
    process_drift: null,
    unit_name: null,
    api_state: parts.apiState,
    bot_state: mapBotState(parts.app, parts.show),
    dry_run: typeof parts.app?.dry_run === 'boolean' ? parts.app.dry_run : null,
    runmode: typeof parts.app?.runmode === 'string' ? parts.app.runmode : (parts.show?.runmode ?? null),
    // shell 模式下 /app/info.strategy 可能为 null（未加载策略）→ 回退配置里的 strategy
    strategy: (parts.app?.strategy ?? null) || (parts.show?.strategy ?? null),
    stake_currency: currency,
    // 账户口径（含手动划入）
    equity_total: num(parts.balance?.total),
    // ★ bot 权益：看板「总权益」用它，不是 total
    equity_bot: num(parts.balance?.total_bot),
    starting_capital: num(parts.balance?.starting_capital),
    realized_pnl: num(parts.profit?.profit_closed_coin),
    unrealized_pnl: unrealizedPnl(parts.profit),
    // ★ 用数组长度，不用 trade_count − closed_trade_count（后者含 force-enter 中间态）
    open_trades: parts.status === null ? null : parts.status.length,
    open_positions: positions,
    daily,
    today: mapToday(daily),
    // 由 view 用 fetchedAt 算「数据多旧」：mapper 不该知道「现在」
    data_age_seconds: null,
    from_snapshot: false,
    error: parts.error,
    // ★ winrate 已是百分数（0 表示 0%）
    winrate_pct: num(parts.profit?.winrate),
    closed_trade_count: num(parts.profit?.closed_trade_count),
    app: parts.app,
  }
}

/**
 * 单实例口径的 `totals`：只是 instance 的投影，**不是**多实例聚合。
 * `equity_total` 用 `equity_bot`（标题注明「不含手动划入」），
 * 四个状态计数互斥，和恒为 1。
 */
export function mapOverviewTotals(instance: InstanceOverview): OverviewTotals {
  const unreachable = instance.api_state === 'ok' ? 0 : 1
  const running = unreachable ? 0 : instance.bot_state === 'running' ? 1 : 0
  const paused = unreachable || running ? 0 : instance.bot_state === 'paused' ? 1 : 0
  const stopped = unreachable || running || paused ? 0 : 1
  return {
    instances: 1,
    running,
    paused,
    stopped,
    unreachable,
    equity_total: instance.equity_bot,
    equity_currency: instance.stake_currency,
    realized_pnl: instance.realized_pnl,
    unrealized_pnl: instance.unrealized_pnl,
    today_realized: instance.today === null ? null : instance.today.abs_profit,
    today_complete: instance.today !== null,
    open_trades: instance.open_trades,
    stale_instances: 0,
    // 显式布尔：禁止用 equity_total === null 反推（多个原因会同时置空）
    mixed_currency: false,
    winrate_pct: instance.winrate_pct,
  }
}

/* ------------------------------------------------------------------ *
 * `/trades.trades[]` → ClosedTradeRow
 * ------------------------------------------------------------------ */

/**
 * 平仓盈亏金额。回退链末尾是 `profit_abs`，**三者皆 null → null**：
 * 写 0 会被读成「打平」，混进合计就是错账。
 */
function closedPnlAbs(raw: RawTradeRow): number | null {
  return num(raw.close_profit_abs) ?? num(raw.realized_profit) ?? num(raw.profit_abs)
}

/** 平仓收益率。`close_profit_pct` 与 `profit_pct` 都是百分数，只有最后一级从 ratio 换算 */
function closedRoePct(raw: RawTradeRow): number | null {
  return num(raw.close_profit_pct) ?? num(raw.profit_pct) ?? pctFromRatio(raw.close_profit)
}

/** 持仓时长：优先上游 `trade_duration_s`，缺失才用两个时间戳相减 */
function durationSeconds(raw: RawTradeRow): number | null {
  const direct = num(raw.trade_duration_s)
  if (direct !== null) return direct
  const openMs = msFromTimestamp(raw.open_timestamp)
  const closeMs = msFromTimestamp(raw.close_timestamp)
  if (openMs === null || closeMs === null) return null
  return (closeMs - openMs) / 1000
}

/** 身份字段缺失的行直接丢弃（不是补 trade_id: 0 —— 那会让详情弹窗查到 0 号交易） */
export function mapClosedTradeRow(raw: RawTradeRow): ClosedTradeRow | null {
  const tradeId = num(raw.trade_id)
  const pair = typeof raw.pair === 'string' ? raw.pair.trim() : ''
  if (tradeId === null || !pair) return null
  return {
    trade_id: tradeId,
    pair,
    side: raw.is_short === true ? 'short' : 'long',
    leverage: num(raw.leverage),
    open_rate: num(raw.open_rate),
    close_rate: num(raw.close_rate),
    open_time: isoFromEither(raw.open_date, raw.open_timestamp),
    close_time: isoFromEither(raw.close_date, raw.close_timestamp),
    duration_seconds: durationSeconds(raw),
    // 原样透出（force_exit / roi / stop_loss …），中文映射在组件层
    exit_reason: tagOrNull(raw.exit_reason),
    enter_tag: tagOrNull(raw.enter_tag),
    pnl_abs: closedPnlAbs(raw),
    roe_pct: closedRoePct(raw),
    stake_amount: num(raw.stake_amount),
  }
}

/**
 * facet 的**精确源**：`/stats` 与 `/performance` 覆盖全部已平仓交易，
 * 不受 `/trades` 窗口上限（2000 笔）影响。用窗口内的行去 distinct 会在
 * 「交易很多」时漏掉早期出现过的原因/交易对，用户筛不到它们。
 */
export function mapTradesFacets(
  exitReasonKeys: readonly string[],
  performancePairs: readonly string[],
  whitelist: readonly string[],
): TradesFacets {
  const pairs = new Set<string>()
  for (const pair of performancePairs) if (pair.trim()) pairs.add(pair.trim())
  for (const pair of whitelist) if (pair.trim()) pairs.add(pair.trim())
  const exitReasons = new Set<string>()
  for (const reason of exitReasonKeys) if (reason.trim()) exitReasons.add(reason.trim())
  return {
    exit_reasons: [...exitReasons].sort((a, b) => a.localeCompare(b)),
    pairs: [...pairs].sort((a, b) => a.localeCompare(b)),
  }
}

/* ------------------------------------------------------------------ *
 * `/pair_candles` → CandleBar[] + ChartMarker[]
 * ------------------------------------------------------------------ */

export interface CandleParseResult {
  bars: CandleBar[]
  markers: ChartMarker[]
  /** 上游缺的列名（目前只可能是 volume）；[] = 列完整 */
  overlayMissing: string[]
}

/** 信号列 → 标记种类。列名即上游列名，两者必须一致才能对上 */
const SIGNAL_COLUMNS: { column: string; kind: ChartMarker['kind'] }[] = [
  { column: 'enter_long', kind: 'enter_long' },
  { column: 'exit_long', kind: 'exit_long' },
  { column: 'enter_short', kind: 'enter_short' },
  { column: 'exit_short', kind: 'exit_short' },
]

/** 标记价的兜底列：上游为信号单独算过触发价，有就用，别再拿 close 顶替 */
const SIGNAL_PRICE_COLUMN: Record<string, string> = {
  enter_long: '_enter_long_signal_close',
  exit_long: '_exit_long_signal_close',
  enter_short: '_enter_short_signal_close',
  exit_short: '_exit_short_signal_close',
}

/**
 * 解析列矩阵。
 *
 * **唯一允许的取列方式是 `columns.indexOf(name)`**：实测 34 列、`all_columns` 29 列，
 * 尾部混着 `__date_ts`（毫秒）与 4 个 `_*_signal_close` 列，且换个策略就是另一套列名。
 * 任何按下标硬编码的写法都会在换策略后静默错列（把 rsi 当 close 画）。
 */
export function parsePairCandles(raw: RawPairCandles): CandleParseResult {
  const columns = Array.isArray(raw.columns) ? raw.columns : []
  const rows = Array.isArray(raw.data) ? raw.data : []

  const cell = (row: (string | number | boolean | null)[], name: string): unknown => {
    const index = columns.indexOf(name)
    return index < 0 ? undefined : row[index]
  }

  const hasVolume = columns.indexOf('volume') >= 0
  const bars: CandleBar[] = []
  const markers: ChartMarker[] = []

  for (const row of rows) {
    if (!Array.isArray(row)) continue
    // 时间统一成 Unix 秒（契约：轴与标记都用秒）。`date` 优先，`__date_ts` 是毫秒兜底
    const dateText = cell(row, 'date')
    const dateTs = num(cell(row, '__date_ts'))
    const parsed = typeof dateText === 'string' ? Date.parse(dateText) : NaN
    const timeMs = Number.isFinite(parsed) ? parsed : dateTs
    if (timeMs === null || !Number.isFinite(timeMs)) continue
    const time = Math.floor(timeMs / 1000)

    const open = num(cell(row, 'open'))
    const high = num(cell(row, 'high'))
    const low = num(cell(row, 'low'))
    const close = num(cell(row, 'close'))
    // 缺 OHLC 的整根丢弃：宁可少一根，不造 0（0 会被画成贴着下沿的假 K 线）
    if (open === null || high === null || low === null || close === null) continue

    // volume 缺失 → 0，并记进 overlay_missing：图表必须给数，但界面要能解释「量为 0 是缺列」
    const volume = num(cell(row, 'volume')) ?? 0
    bars.push({ time, open, high, low, close, volume, support: null })

    for (const signal of SIGNAL_COLUMNS) {
      if (!truthySignal(cell(row, signal.column))) continue
      const signalClose = num(cell(row, SIGNAL_PRICE_COLUMN[signal.kind]))
      markers.push({
        time,
        price: signalClose ?? close,
        kind: signal.kind,
        // 上游没有 l2 拦截数据（PRD 已删该层），恒 null
        l2: null,
        reason: null,
        enter_tag: tagOrNull(cell(row, 'enter_tag')) ?? tagOrNull(cell(row, 'exit_tag')),
      })
    }
  }

  return { bars, markers, overlayMissing: hasVolume ? [] : ['volume'] }
}

/** `ChartMetaOut` ← `/whitelist` + `/show_config` + `/app/info` */
export function mapChartMeta(
  whitelist: string[],
  methods: string[],
  timeframe: string | null,
  strategy: string | null,
  reason: string | null,
): ChartMetaOut {
  return {
    instance_id: MAIN_ID,
    timeframe,
    pair_whitelist: whitelist,
    pairlist_method: methods,
    strategy,
    reason,
  }
}
