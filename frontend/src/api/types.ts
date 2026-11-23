export type ApiState = 'unknown' | 'ok' | 'unreachable' | 'unauthorized' | 'error'
export type BotState = 'running' | 'paused' | 'stopped' | 'unknown'
export type ProcessState = 'running' | 'exited' | 'unknown' | 'not_managed'

/** 进程生命周期（systemd）与交易开关（freqtrade API）两轴，绝不混用 */
export type LifecycleAction = 'start' | 'stop' | 'restart' | 'stop_bot' | 'start_bot' | 'pause_bot'

export interface ActionResult {
  action: LifecycleAction
  kind: 'process' | 'trading'
  ok: boolean
  command?: string[]
  path?: string
  status?: { unit: string; active_state: string; sub_state: string; main_pid: number | null; process_state: ProcessState } | null
  error?: { kind: string; detail: string; status?: number | null } | null
}

export interface InstanceOut {
  id: string
  name: string
  base_url: string
  auth_mode: string
  username: string | null
  has_password: boolean
  has_ws_token: boolean
  managed: boolean
  work_dir: string | null
  ft_bin: string | null
  config_path: string | null
  strategy: string | null
  logfile_path: string | null
  unit_name: string | null
  auto_restart: boolean
  created_at: string
  updated_at: string
  notes: string | null
}

export interface InstanceIn {
  name: string
  base_url: string
  username?: string | null
  password?: string | null
  work_dir?: string | null
  ft_bin?: string | null
  config_path?: string | null
  strategy?: string | null
  logfile_path?: string | null
  unit_name?: string | null
  auto_restart?: boolean
  notes?: string | null
}

export interface DailyPoint {
  date: string
  abs_profit: number
  rel_profit: number
  trade_count: number
  /** 当日开盘本金；曲线基准取窗口内最早一天的这个值，不是 dry_run_wallet */
  starting_balance: number | null
}

export interface PositionOut {
  trade_id: number
  pair: string
  side: 'long' | 'short'
  amount: number
  open_rate: number
  current_rate: number
  stake_amount: number
  unrealized_pnl: number
  unrealized_pnl_ratio: number | null
  stoploss_distance_pct: number | null
  open_time: string
  strategy: string
  enter_tag: string | null
  has_open_order: boolean
}

export interface InstanceOverview {
  id: string
  name: string
  base_url: string
  process_state: ProcessState
  /** 用户意图 vs 实际进程态的偏差；null=无偏差或从未托管 */
  process_drift: 'unexpected_stop' | 'manually_started' | null
  unit_name: string | null
  api_state: ApiState
  bot_state: BotState
  dry_run: boolean | null
  runmode: string | null
  strategy: string | null
  stake_currency: string | null
  equity_total: number | null
  equity_bot: number | null
  starting_capital: number | null
  realized_pnl: number | null
  unrealized_pnl: number | null
  open_trades: number | null
  open_positions: PositionOut[] | null
  daily: DailyPoint[] | null
  /** UTC 自然日的已平仓盈亏；null 表示后端没拿到今天的数据，不代表今天没成交 */
  today: { date: string; abs_profit: number; trade_count: number } | null
  data_age_seconds: number | null
  from_snapshot: boolean
  error: { kind: string; detail: string; status?: number | null } | null
  /** 胜率百分数（62.5 = 62.5%）；快照实例不写胜率 → null，显示「—」而不是 0 */
  winrate_pct: number | null
  /** 已平仓笔数，胜率合计按它加权 */
  closed_trade_count: number | null
  /**
   * `/app/info` 原样（单实例改造新增）。看板「Bot 状态卡」要用
   * `state_file` / `ui_ready` / `version` / `last_error`；取不到时为 null。
   */
  app: RawAppInfo | null
}

export interface OverviewTotals {
  instances: number
  running: number
  paused: number
  stopped: number
  unreachable: number
  equity_total: number | null
  equity_currency: string | null
  realized_pnl: number | null
  unrealized_pnl: number | null
  /** UTC 今日已实现盈亏的合计；多币种时为 null（不同币种不可相加） */
  today_realized: number | null
  /** 仅当所有实例都拿到今日数据时为 true；false 表示合计不完整 */
  today_complete: boolean
  /** 0=所有实例都确认没有持仓；null=一个已知值都没有（E9：不知道≠没有） */
  open_trades: number | null
  stale_instances: number
  /** 显式布尔，禁止用 equity_total === null 反推（多原因置空时必然误判） */
  mixed_currency: boolean
  /** 合计胜率，按 closed_trade_count 加权；无已平仓交易 → null */
  winrate_pct: number | null
}

export interface OverviewOut {
  generated_at: string
  totals: OverviewTotals
  instances: InstanceOverview[]
}

export interface ProvisionPreview {
  unit_name: string
  unit_content: string
  unit_path: string
}

export interface ProvisionResult {
  ok: boolean
  unit_name: string
  unit_content?: string
  unit_path?: string
  error?: { kind: string; detail: string; status?: number | null } | null
}

/* ------------------------------------------------------------------ *
 * 三期契约（03-tech-design §2 冻结）。字段名一律 snake_case 照抄后端，
 * 前端不做改名映射——改名会让「契约」变成两份，联调时对不上。
 * 约定：null=不知道、0=确实是零、[]=确实是空，三者禁止互换。
 * ------------------------------------------------------------------ */

export interface ChartMetaOut {
  instance_id: string
  /** 实例自身粒度；探测未完成或不可达 → null */
  timeframe: string | null
  /** 不可用时是 []，不是 null——前端据此走空态而不是崩溃 */
  pair_whitelist: string[]
  /** 选币方式（如 ["OkxCryptoGainersPairList"]）；老版本回退或取不到时是 []，不显示即可 */
  pairlist_method: string[]
  strategy: string | null
  reason: string | null
}

export interface CandleBar {
  /** Unix 秒；轴与标记都用这个单位，不在前端换成 ISO 串 */
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  /** 该根没有任何可识别的支撑线 → null（不猜不连） */
  support: { line: string; value: number } | null
}

export interface ChartMarker {
  time: number
  price: number
  kind: 'enter_long' | 'exit_long' | 'enter_short' | 'exit_short' | 'block'
  l2: 'enter' | 'block' | null
  /** block 的拦截原因原文，如 too_far_from_price */
  reason: string | null
  enter_tag: string | null
}

export interface ChartScopeOut {
  bar_count: number
  earliest_time: string | null
  latest_time: string | null
  /** 上游只保留了最近 N 根时为 true */
  truncated: boolean
  upstream_length: number
  /**
   * 覆盖层需要但上游缺的列名（如 ["l2_block","l2_order_price"]）；[] = 列完整。
   * 非空只表示"标记少了归因信息"，bars 与 markers 照画——与 reason="schema_mismatch"
   * （标记全没了）是两件事，提示文案与用户该做的事都不同。
   */
  overlay_missing: string[]
}

export interface CandlesOut {
  instance_id: string
  pair: string
  timeframe: string
  /** 上游真实粒度 */
  base_timeframe: string | null
  /** "1m" 表示 5m 是由 1m 聚合派生（此时 markers=[]、每根 support=null） */
  derived_from: string | null
  /** 客户端请求的根数，原样回显 */
  limit_requested: number
  /** 截断后真正生效的根数（>500 被截断，不报错） */
  limit_effective: number
  bars: CandleBar[]
  markers: ChartMarker[]
  scope: ChartScopeOut
  reason: string | null
}

export interface OpenPositionRow {
  instance_id: string
  instance_name: string
  /** 实例没取到币种时为空——空就不显示，不补占位 */
  stake_currency: string | null
  trade_id: number
  pair: string
  side: 'long' | 'short'
  leverage: number | null
  open_rate: number | null
  current_rate: number | null
  amount: number | null
  stake_amount: number | null
  /** 单笔浮动金额（= total_profit_abs） */
  unrealized_abs: number | null
  /** 百分数，已含杠杆——永不再乘 leverage */
  roe_pct: number | null
  /** 绝对值；有符号版本留给看板，这里只表示"距离止损多远" */
  stoploss_distance_pct: number | null
  open_time: string
  enter_tag: string | null
  /** 是否有未成交挂单：决定「取消挂单」是否可点（撤单不平仓） */
  has_open_order: boolean
}

/** 未平仓行可执行的两个动作，与后端 /force-exit、/cancel-order 一一对应 */
export type PositionAction = 'force_exit' | 'cancel_order'

export interface PositionActionResult {
  action: PositionAction
  trade_id: number
  ok: boolean
  /** 成功时的补充说明（如「成交结果下一次刷新反映」） */
  detail?: string
  error?: { kind: string; detail: string; status?: number | null } | null
}

export interface InstanceAvailability {
  instance_id: string
  instance_name: string
  /**
   * `not_ready`：观察模式下 `/status` 回 503/502 包装体——端点本身是好的，是 bot 没在交易。
   * 不能塞进 `unknown`：`unknown` 的文案是「原因未知」，会把「没开交易」说成「出了怪事」。
   */
  available: 'ok' | 'api_unreachable' | 'unauthorized' | 'timeout' | 'not_ready' | 'unknown'
  reason: string | null
  /** reason 来自带 HTTP 状态的失败时携带 status，供渲染处把 {n} 替换为真实码 */
  status?: number | null
}

export interface PositionsOut {
  generated_at: string
  /** 全部来自看板 totals 原样搬运；行相加会在部分实例失败时得出错数 */
  totals: {
    unrealized_abs: number | null
    realized_abs: number | null
    equity_currency: string | null
    mixed_currency: boolean
    /** 0=确认没有；null=不知道（某实例 /status 失败时），显示 — 不显示 0 */
    open_trades: number | null
    complete: boolean
  }
  rows: OpenPositionRow[]
  /** 每个实例都出现，不可用的也列出来，别让实例凭空消失 */
  availability: InstanceAvailability[]
}

export interface ClosedTradeRow {
  trade_id: number
  pair: string
  side: 'long' | 'short'
  leverage: number | null
  open_rate: number | null
  close_rate: number | null
  /** SQLite 里是无时区 UTC 文本，后端已转 ISO Z */
  open_time: string | null
  close_time: string | null
  duration_seconds: number | null
  exit_reason: string | null
  enter_tag: string | null
  /** 回退链 close_profit_abs → realized_profit；两者皆无 → null（绝不写 0） */
  pnl_abs: number | null
  roe_pct: number | null
  stake_amount: number | null
}

export interface TradesFacets {
  /** 该实例已平仓全集 distinct，不受当前过滤影响，否则筛完没有别的选项可切 */
  exit_reasons: string[]
  pairs: string[]
}

export interface TradesOut {
  instance_id: string
  instance_name: string
  stake_currency: string | null
  /**
   * `not_ready`：观察模式下不读交易数据（不是库坏了）。
   * 不能拿 `db_unavailable` 冒充——文案会把「没开交易」说成「库坏了」。
   */
  available: 'ok' | 'db_not_found' | 'db_unavailable' | 'no_table' | 'schema_mismatch' | 'timeout' | 'not_ready'
  /** db_not_found 时给出探测过的绝对路径 */
  reason: string | null
  rows: ClosedTradeRow[]
  /** 过滤后总数，独立 COUNT(*)；offset 越界时仍是真实总数 */
  total: number
  /** 客户端请求值，原样回显不截断 */
  limit_requested: number
  /** 截断后生效值 = min(limit_requested, 500)；与 candles 的 limit_effective 对称 */
  limit: number
  offset: number
  facets: TradesFacets
  /** pnl_abs 与 roe_pct 同时为 null 的行数（合计不可信信号） */
  schema_anomaly: number
}

/** 权益曲线上的一个点。单实例后没有 `series_id` 的对比语义，但字段保留以兼容 EquityCurveChart。 */
export interface CurvePoint {
  /** 固定为 MAIN_ID：曲线组件按它不是空的来分流 */
  series_id: string
  /** UTC YYYY-MM-DD */
  date: string
  /** 缺日 → 显式 null，曲线在此断开（禁止补前值/插值/补 0） */
  value: number | null
}

/* ------------------------------------------------------------------ *
 * 观测与统计（四期）。这些数据全部来自**实例 REST**，不是本地 SQLite：
 * 实例停止时取不到是正常状态，用 availability 表达，不是错误码。
 * ------------------------------------------------------------------ */

export type ObserveAvailability =
  | 'ok'
  | 'api_unreachable'
  | 'unauthorized'
  | 'unsupported'
  | 'timeout'
  | 'unknown'
  /** 观察模式：端点本身可用，是 bot 没在交易（与 unreachable 是两件事） */
  | 'not_ready'

export interface LogLine {
  /** 上游已格式化好的 "YYYY-MM-DD HH:MM:SS,mmm"；直接显示，不再二次转时区 */
  ts_text: string
  /** 毫秒时间戳；老版本没有这个字段 → null（排序回退到行序） */
  ts_ms: number | null
  logger: string
  level: string
  /** 可能含 traceback 的换行，按原样保留 */
  message: string
}

export interface LogsOut {
  instance_id: string
  instance_name: string
  available: ObserveAvailability
  reason: string | null
  /** reason 来自带 HTTP 状态的失败时携带 status，供渲染处把 {n} 替换为真实码 */
  status?: number | null
  kind?: string
  lines: LogLine[]
  /** 过滤前的缓冲区总行数；用于显示「已筛出 N / 共 M 行」 */
  total: number
  limit: number
  level: string | null
}

export interface ObserveBase {
  instance_id: string
  instance_name: string
  available: ObserveAvailability
  reason: string | null
  /** reason 来自带 HTTP 状态的失败时携带 status，供渲染处把 {n} 替换为真实码 */
  status?: number | null
  kind?: string
}

/**
 * 上游 `/sysinfo` 的**实测**形状（2026.11-dev 逐字段核对）：
 * - `cpu_pct` 是历史采样序列，不是单值；`ram_pct` 才是单值
 * - 没有 `disk` 字段（旧版文档里提过，本版不返回）
 * 猜错这三个字段的表现是「界面全显示 —」，而且不会报错，最难发现。
 */
export interface SysinfoOut extends ObserveBase {
  sysinfo: {
    /** 每个核的采样序列（最近若干秒） */
    cpu_pct?: number[]
    cpu_load?: { cpu: number; pct: number }[]
    cpu_load_avg?: { '1m'?: number; '5m'?: number; '15m'?: number }
    cpu_count?: number
    /** 全部核的平均占用（百分数，单值） */
    cpu_avg?: number
    /** 内存占用（百分数，单值） */
    ram_pct?: number
  } | null
}

/**
 * `/strategy/{name}` 的 `params` 是**可优化参数列表**，不是 dict：
 * `[{name, value, param_type, space, low, high}]`。
 * 按 dict 遍历会得到空表 —— 这里用数组类型把它钉死。
 */
export interface StrategyParam {
  name: string
  value: unknown
  param_type?: string
  space?: string
  low?: number | null
  high?: number | null
  load?: boolean
  optimize?: boolean
  decimals?: number | null
}

export interface StrategyOut extends ObserveBase {
  strategy: string | null
  /** 源码已由后端剔除（几十 KB 且界面不展示），这里只说「有没有」 */
  code_available?: boolean
  info: {
    strategy?: string
    timeframe?: string
    params?: StrategyParam[]
    /** 策略源码（可能很大，界面上不展示，只用来判断是否拿到） */
    code?: string
    [key: string]: unknown
  } | null
}

export interface ShowConfigOut extends ObserveBase {
  /** 上游已剔除凭据；字段随版本增减，故用宽松记录而不是逐字段声明 */
  config: Record<string, unknown> | null
}

export interface TradeOrder {
  order_id: string
  ft_pair: string
  ft_order_side: 'buy' | 'sell' | string
  ft_is_open?: boolean
  status: string
  order_type: string | null
  price: number | null
  average: number | null
  amount: number | null
  filled: number | null
  remaining: number | null
  cost: number | null
  order_date: string | null
  order_filled_date: string | null
  /** 撤单原因（TIMEOUT / PARTIALLY_FILLED / …）；未撤单为 null */
  ft_cancel_reason?: string | null
}

export interface TradeDetail {
  trade_id: number
  pair: string
  is_open: boolean
  side?: string
  leverage?: number | null
  open_rate?: number | null
  close_rate?: number | null
  amount?: number | null
  stake_amount?: number | null
  open_date?: string | null
  close_date?: string | null
  exit_reason?: string | null
  enter_tag?: string | null
  profit_abs?: number | null
  profit_ratio?: number | null
  stoploss_current_dist_pct?: number | null
  orders?: TradeOrder[]
  [key: string]: unknown
}

export interface CustomDataRow {
  key: string
  type?: string
  value?: unknown
  /** 上游以 `str(value)` 存文本，前端按需解析 */
  [k: string]: unknown
}

export interface TradeDetailOut extends ObserveBase {
  trade: TradeDetail | null
  custom_data: CustomDataRow[]
}

export interface ProfitBucket {
  profit_closed_coin?: number
  profit_closed_percent?: number
  profit_closed_ratio?: number
  profit_all_coin?: number
  profit_all_percent?: number
  profit_all_ratio?: number
  closed_trade_count?: number
  first_trade_date?: string | null
  latest_trade_date?: string | null
  avg_duration?: string | null
  best_pair?: string | null
  best_rate?: number | null
  winning_trades?: number
  losing_trades?: number
  /** 百分数（62.5 = 62.5%），与 pct() 的口径一致 */
  winrate?: number | null
  profit_factor?: number | null
  expectancy?: number | null
  sharpe?: number | null
  sortino?: number | null
  /** 百分数 */
  max_drawdown?: number | null
  max_drawdown_abs?: number | null
  current_drawdown?: number | null
  trading_volume?: number | null
  [key: string]: unknown
}

export interface PeriodPoint {
  date: string
  abs_profit: number
  rel_profit: number
  trade_count: number
  starting_balance?: number | null
}

export interface PeriodOut {
  data?: PeriodPoint[]
  stake_currency?: string
  [key: string]: unknown
}

export interface ExitReasonStat {
  wins: number
  losses: number
  draws?: number
  winrate?: number | null
  [key: string]: unknown
}

export interface PairPerf {
  pair: string
  /** `/performance` 的 `profit` 是**百分数**（-0.3 = -0.3%），不是金额 */
  profit: number
  /**
   * USDT 绝对额（实测 `-1.96330934`）。页面上要横向比较金额时用它：
   * `profit` 是百分数，和「已实现盈亏 -1.96 USDT」放在同一屏里会被读成同一个单位。
   */
  profit_abs: number
  profit_ratio?: number
  profit_pct?: number
  count?: number
  [key: string]: unknown
}

/**
 * `/entries` `/exits` `/mix_tags` 的元素。
 *
 * ★ 实测这三个端点**没有** `profit` 字段（只有 `profit_abs` / `profit_pct` / `profit_ratio`）。
 * 早期这里声明了必填 `profit: number`，于是 `row.profit` 永远是 `undefined`，
 * 进 `Intl.NumberFormat` 就成了界面上的 `NaN`。金额请读 `profit_abs`。
 */
export interface TagPerf {
  enter_tag?: string
  exit_reason?: string
  mix_tag?: string
  /** USDT 绝对额；缺失时保持 undefined，由格式化函数兜成 —（绝不写 0） */
  profit_abs?: number
  profit_ratio?: number
  profit_pct?: number
  count?: number
  [key: string]: unknown
}

export interface PairlockRow {
  id: number
  active: boolean
  pair: string
  side: string
  reason: string | null
  lock_time: string
  lock_end_time: string
  lock_end_timestamp: number
}

/**
 * 选币与屏蔽。三个概念必须分开显示：
 * - `whitelist` 本轮会考虑的交易对（动态选币每轮变）
 * - `blacklist` 是**正则**（如 `.*(3L|3S)/.*`），不是具体 pair；
 *   `blacklist_expanded` 才是展开后的具体币对
 * - `locks` 有到期时间，到期自动释放，不是永久屏蔽
 */
export interface PairlistOut extends ObserveBase {
  whitelist: string[]
  /** 选币链的类名顺序，直接反映 config 里的 pairlist 配置 */
  whitelist_method: string[]
  blacklist: string[]
  blacklist_expanded: string[]
  locks: PairlockRow[]
  errors: Record<string, string>
}

export interface AnalyticsOut {
  instance_id: string
  instance_name: string
  available: ObserveAvailability
  reason: string | null
  /** reason 来自带 HTTP 状态的失败时携带 status，供渲染处把 {n} 替换为真实码 */
  status?: number | null
  days: number
  weeks: number
  months: number
  stake_currency: string | null
  profit_all: { all?: ProfitBucket; long?: ProfitBucket | null; short?: ProfitBucket | null } | null
  stats: {
    exit_reasons?: Record<string, ExitReasonStat>
    durations?: Record<string, number | null>
    [key: string]: unknown
  } | null
  performance: PairPerf[] | null
  entries: TagPerf[] | null
  exits: TagPerf[] | null
  mix_tags: TagPerf[] | null
  daily: PeriodOut | null
  weekly: PeriodOut | null
  monthly: PeriodOut | null
  /** 哪些段没取到、为什么；键是段名，值是 "kind: detail" */
  errors: Record<string, string>
}

/* ================================================================== *
 * 单实例改造·增量（设计 §1.4）
 *
 * 这一整段都是**加法**：上面的既有契约一个字都没改语义，只在上方做了三处
 * 联合类型扩展（`TradesOut.available` / `ObserveAvailability` / `ChartMarker.kind`）
 * 与 `InstanceOverview.app` 一个新增字段。
 *
 * 下面的 `Raw*` 是 freqtrade 的**原始响应**形状：只允许 `src/api/ft/` 内部 import，
 * view / components **不许**碰——一旦组件认识 `is_short`、`total_profit_abs` 这些名字，
 * 适配层就白做了。
 * ================================================================== */

/**
 * `/api/v1/app/info` 原样（实测 `.probe/app_info_boot.json`）。
 * 这是「进程活着 + 当前模式」的唯一权威来源。
 */
export interface RawAppInfo {
  version: string
  /** shell = 只跑 API/UI 不连交易所；trade = 跑 bot */
  mode: 'shell' | 'trade'
  runmode: string
  dry_run: boolean
  trading_active: boolean
  exchange: string
  /** shell 模式下可能为 null（未加载策略），mapper 要回退到 /show_config.strategy */
  strategy: string | null
  state_file: string
  /** 启动失败回退 shell 时的原因；null = 没有错误 */
  last_error: string | null
  ui_ready: boolean
  [k: string]: unknown
}

/**
 * `GET /status[]` 的元素（`OpenTradeSchema`，实测 73 字段）。
 * 只声明映射用到的字段，其余走索引签名——上游加字段不该让前端编译失败。
 * ⚠️ 别和 `POST /forceenter` 的 `TradeSchema` 混用：后者**没有** `current_rate`。
 */
export interface RawStatusRow {
  trade_id: number
  pair: string
  is_open?: boolean
  is_short?: boolean | null
  leverage?: number | null
  amount?: number | null
  stake_amount?: number | null
  open_rate?: number | null
  /** 实测直接给，不要用 open_rate × (1 + profit_ratio) 反推（C1 裁决） */
  current_rate?: number | null
  open_date?: string | null
  /** 毫秒时间戳；`open_date` 缺失时的兜底 */
  open_timestamp?: number | null
  profit_ratio?: number | null
  /** **已是百分数且含杠杆**（-0.31 表示 -0.31%）→ 直取 roe_pct */
  profit_pct?: number | null
  profit_abs?: number | null
  /** 单笔浮动金额（含杠杆）；与 profit_abs 实测同值 */
  total_profit_abs?: number | null
  total_profit_ratio?: number | null
  /** 距止损的百分数（带符号），契约层取绝对值 */
  stoploss_current_dist_pct?: number | null
  stop_loss_abs?: number | null
  enter_tag?: string | null
  /** ★ 复数：少写一个 s 会让「取消挂单」永远置灰 */
  has_open_orders?: boolean | null
  strategy?: string | null
  timeframe?: string | null
  exit_reason?: string | null
  orders?: unknown[]
  [k: string]: unknown
}

/**
 * `GET /trades.trades[]` 的元素（`TradeSchema`）。
 * 与 RawStatusRow 的差别：有 `close_*` / `trade_duration_s`，**没有** `current_rate`。
 */
export interface RawTradeRow {
  trade_id: number
  pair: string
  is_open?: boolean
  is_short?: boolean | null
  leverage?: number | null
  amount?: number | null
  stake_amount?: number | null
  open_rate?: number | null
  close_rate?: number | null
  open_date?: string | null
  close_date?: string | null
  open_timestamp?: number | null
  close_timestamp?: number | null
  /** schema 里没有但实测有 → 双路径兜底（另一个是 close_timestamp - open_timestamp） */
  trade_duration_s?: number | null
  trade_duration?: number | string | null
  exit_reason?: string | null
  enter_tag?: string | null
  /** 平仓盈亏金额回退链：close_profit_abs → realized_profit → profit_abs */
  close_profit_abs?: number | null
  close_profit?: number | null
  realized_profit?: number | null
  profit_abs?: number | null
  /** 平仓收益率回退链：close_profit_pct → profit_pct → close_profit × 100 */
  close_profit_pct?: number | null
  profit_pct?: number | null
  profit_ratio?: number | null
  close_profit_ratio?: number | null
  [k: string]: unknown
}

/** `GET /trades` 的包装对象 */
export interface RawTradesPage {
  trades: RawTradeRow[]
  /** 本页条数 */
  trades_count: number
  /** 全量条数（不受 limit 影响） */
  total_trades: number
  offset: number
  [k: string]: unknown
}

/**
 * `GET /pair_candles`（实测 `.probe/pair_candles.json`）。
 * `data` 是**行式二维数组**，列名在 `columns[]`（34 列，随策略变），
 * 尾部混有 `__date_ts`（毫秒）与 4 个 `_*_signal_close` 列。
 * **绝不允许按下标硬编码**：换个策略就是另一套列名。
 */
export interface RawPairCandles {
  strategy: string
  pair: string
  timeframe: string
  timeframe_ms: number
  /** 含派生列（`__date_ts` / `_enter_long_signal_close` …） */
  columns: string[]
  /** 不含派生列，只有策略 DataFrame 的列 */
  all_columns: string[]
  data: (string | number | boolean | null)[][]
  length: number
  /** `"2026-11-22 15:00:00+00:00"`（+00:00 形态）→ isoZ() 必须兼容 */
  data_start: string | null
  data_stop: string | null
  data_start_ts: number | null
  data_stop_ts: number | null
  buy_signals: number
  sell_signals: number
  enter_long_signals?: number
  exit_long_signals?: number
  enter_short_signals?: number
  exit_short_signals?: number
  last_analyzed?: string | null
  [k: string]: unknown
}

/** `/logs` 的一行：`[ts_text, ts_ms, logger, level, message]`（C5：数组的数组） */
export type RawLogLine = [string, number, string, string, string]

export interface RawLogs {
  log_count: number
  logs: RawLogLine[]
  [k: string]: unknown
}

/**
 * `GET /balance`。三个金额口径**不互推**：
 * - `total` 账户含手动划入
 * - `total_bot` 才是 bot 权益（看板「总权益」用它）
 * - `starting_capital` 本金基准
 * `stake` 是计价币（USDT）；`symbol` 是法币显示币（USD），不要用错。
 */
export interface RawBalance {
  currencies?: Record<string, unknown>[]
  total?: number | null
  total_bot?: number | null
  symbol?: string | null
  value?: number | null
  value_bot?: number | null
  stake?: string | null
  starting_capital?: number | null
  [k: string]: unknown
}

/** `GET /profit`（54 字段扁平对象）。`winrate` **已是百分数**（0 表示 0%） */
export interface RawProfit {
  profit_closed_coin?: number | null
  profit_all_coin?: number | null
  trade_count?: number | null
  closed_trade_count?: number | null
  winrate?: number | null
  best_pair?: string | null
  best_rate?: number | null
  winning_trades?: number | null
  losing_trades?: number | null
  profit_factor?: number | null
  max_drawdown?: number | null
  trading_volume?: number | null
  first_trade_date?: string | null
  latest_trade_date?: string | null
  avg_duration?: string | null
  [k: string]: unknown
}

/** `GET /daily|weekly|monthly`：`data` 是**倒序**，要升序请自行 sort */
export interface RawPeriodPoint {
  date: string
  abs_profit: number
  rel_profit: number
  trade_count: number
  starting_balance?: number | null
  [k: string]: unknown
}

export interface RawPeriod {
  data?: RawPeriodPoint[]
  stake_currency?: string | null
  fiat_display_currency?: string | null
  [k: string]: unknown
}

/** `GET /show_config`（35 键）；shell 模式下是配置里 strategy/timeframe 的来源 */
export interface RawShowConfig {
  strategy?: string | null
  timeframe?: string | null
  stake_currency?: string | null
  stake_amount?: number | string | null
  dry_run?: boolean | null
  runmode?: string | null
  trading_mode?: string | null
  exchange?: string | null
  max_open_trades?: number | null
  bot_name?: string | null
  /** `'running'` / `'paused'` */
  state?: string | null
  stoploss?: number | null
  minimal_roi?: Record<string, number> | null
  force_entry_enable?: boolean | null
  short_allowed?: boolean | null
  version?: string | null
  [k: string]: unknown
}

/* ------------------------------------------------------------------ *
 * app 管理端点（api_app.py）
 * ------------------------------------------------------------------ */

export type AppMode = 'shell' | 'trade'

/** 登录响应（openapi `AccessAndRefreshToken`）：两个都必有 */
export interface TokenPair {
  access_token: string
  /**
   * 刷新响应（openapi `AccessToken`）**不返回**这个字段。
   * `ft/auth.ts` 的 refresh 因此要显式保留旧值，否则下一次刷新失败 → 用户被踢。
   */
  refresh_token?: string
}

/** `GET /app/config`：`config` 里的密钥已脱敏成 `***redacted***` */
export interface AppConfigOut {
  config: Record<string, unknown>
  mode: AppMode
  /** 形如 `[["api_server","listen_port"], ["db_url"]]`：这些改完必须重启才生效 */
  restart_only_paths: string[][]
}

/**
 * `PUT /app/config` 的响应。
 * `applied` 除四个枚举值外还可能是 `reload_failed: xxx`，所以保留 string 分量。
 */
export interface AppConfigSaved {
  saved: boolean
  applied: 'reloaded' | 'reload_pending' | 'restart_required' | 'shell_mode' | (string & {})
  changed: string[]
  restart_required_for: string[]
}

/** `POST /app/mode`：**HTTP 200** 表示「已受理」，500ms 后才 execv 重启 */
export interface ModeAccepted {
  accepted: boolean
  mode: AppMode
  message: string
}

/** `GET /signal/health` */
export interface SignalHealthOut {
  ok: boolean
  runmode: string
  dry_run: boolean
  actions: string[]
  open_trades: number
}

/* ------------------------------------------------------------------ *
 * 配置页字段描述表（驱动表单渲染 + diff 白名单，设计 §6）
 * ------------------------------------------------------------------ */

export type ConfigFieldKind = 'text' | 'number' | 'bool' | 'select' | 'lines' | 'secret' | 'roi' | 'readonly'

export interface ConfigFieldSpec {
  /** 点分路径，如 `exchange.pair_whitelist`；同时是 diff 白名单的键 */
  path: string
  kind: ConfigFieldKind
  label: string
  /** 分组 id，对应配置页锚点（`mode` / `exchange` / `stake` / …） */
  group: string
  /** 能否热载（false → 保存后要重启） */
  hot: boolean
  /** 是否 P0 必填项（P1 字段可折叠） */
  p0: boolean
  /** 下拉候选的异步来源（`/strategies` `/exchanges`），失败时降级为文本输入 */
  options?: () => Promise<string[]>
  hint?: string
  /** 改为实盘等高风险取值时要求二次确认 */
  liveConfirm?: boolean
  /** 后端 `restart_only_paths` 命中时置 true，字段旁打「需重启」角标 */
  restartOnly?: boolean
}
