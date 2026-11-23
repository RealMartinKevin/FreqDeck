/**
 * 运维页取数：日志 / 系统信息 / 策略 / 选币。
 *
 * 与看板的关键区别：**这些数据不依赖 RPC**，观察模式下也照样能看
 * （`/logs` `/sysinfo` `/strategy` `/whitelist` 在 shell 模式可用）。
 * 所以本文件对失败一律「降级成 `available` + `reason`」，不抛异常——
 * 排除故障时最需要运维页能打开，它自己先报错就没意义了。
 */

import { ApiFailure } from './errors'
import { get } from './http'
import { DEFAULT_BOT_NAME, MAIN_ID } from './mappers'
import { clampLimit, num } from './normalize'
import type {
  LogLine,
  LogsOut,
  ObserveAvailability,
  PairlistOut,
  PairlockRow,
  RawAppInfo,
  RawLogs,
  RawShowConfig,
  ShowConfigOut,
  StrategyOut,
  StrategyParam,
  SysinfoOut,
} from '../types'

/** 日志行数上限：一次拉全量会把浏览器卡住，200 行足够定位「刚刚发生了什么」 */
const LOGS_DEFAULT_LIMIT = 200

/** bot 名缓存在这里而不是每页各拉一次：日志每 5s 轮询，多一个请求就多一份无谓负载 */
let botNameCache: { name: string; fetchedAt: number } | null = null
const BOT_NAME_TTL_MS = 60_000

async function currentBotName(signal?: AbortSignal): Promise<string> {
  const cached = botNameCache
  if (cached && Date.now() - cached.fetchedAt < BOT_NAME_TTL_MS) return cached.name
  try {
    const show = await get<RawShowConfig>('/api/v1/show_config', { signal, timeoutMs: 8_000 })
    const name = typeof show.bot_name === 'string' && show.bot_name.trim() ? show.bot_name.trim() : DEFAULT_BOT_NAME
    botNameCache = { name, fetchedAt: Date.now() }
    return name
  } catch (error) {
    if (error instanceof ApiFailure && error.kind === 'aborted') throw error
    // 拿不到名字不该让运维页整块失败：退回默认名，界面照常可用
    return cached?.name ?? DEFAULT_BOT_NAME
  }
}

/** 失败 → 契约里的观察态枚举。注意 `not_ready` 和 `api_unreachable` 是两个不同的结论 */
function availabilityOf(failure: ApiFailure | null): ObserveAvailability {
  if (failure === null) return 'ok'
  switch (failure.kind) {
    case 'not_ready':
      return 'not_ready'
    case 'network':
      return 'api_unreachable'
    case 'unauthorized':
      return 'unauthorized'
    case 'invalid':
      // 404/405 表示这个版本的后端没有该能力，不是「坏」
      return 'unsupported'
    default:
      return 'unknown'
  }
}

/* ------------------------------------------------------------------ *
 * 日志
 * ------------------------------------------------------------------ */

/**
 * `/logs` 的 `logs` 是**行的数组**：`[ts_text, ts_ms(float), logger, level, message]`（C5）。
 * `ts_ms` 是 float（如 1795374771701.8843）→ 必须 `Math.round`，
 * 否则排序/去重会因为浮点尾数出现「同一时刻的两行换位」。
 */
function mapLogLines(raw: unknown): LogLine[] {
  if (!Array.isArray(raw)) return []
  const lines: LogLine[] = []
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 5) continue
    const [tsText, tsMs, logger, level, message] = row as unknown[]
    const roundedMs = num(tsMs)
    lines.push({
      ts_text: typeof tsText === 'string' ? tsText : '',
      ts_ms: roundedMs === null ? null : Math.round(roundedMs),
      logger: typeof logger === 'string' ? logger : '',
      level: typeof level === 'string' ? level : '',
      // traceback 里的换行原样保留：截断它会让人误判异常发生在哪一层
      message: typeof message === 'string' ? message : String(message ?? ''),
    })
  }
  return lines
}

export interface LogsQuery {
  limit?: number
  /** 级别筛选在前端做：上游 `/logs` 只有 `limit` 参数，没有 level */
  level?: string
}

export async function fetchLogs(instanceId: string, query: LogsQuery = {}, signal?: AbortSignal): Promise<LogsOut> {
  const limit = clampLimit(query.limit, LOGS_DEFAULT_LIMIT)
  const level = typeof query.level === 'string' && query.level.trim() ? query.level.trim().toUpperCase() : null
  const instanceName = await currentBotName(signal)

  try {
    const raw = await get<RawLogs>('/api/v1/logs', { signal, timeoutMs: 8_000, query: { limit } })
    const all = mapLogLines(raw.logs)
    const lines = level === null ? all : all.filter((line) => line.level.toUpperCase() === level)
    return {
      instance_id: MAIN_ID,
      instance_name: instanceName,
      available: 'ok',
      reason: null,
      lines,
      // 过滤前的缓冲区总行数：界面据此显示「已筛出 N / 共 M 行」
      total: num(raw.log_count) ?? all.length,
      limit,
      level: level,
    }
  } catch (error) {
    if (error instanceof ApiFailure && error.kind === 'aborted') throw error
    const failure = error instanceof ApiFailure ? error : null
    return {
      instance_id: MAIN_ID,
      instance_name: instanceName,
      available: availabilityOf(failure),
      reason: failure?.detail ?? '读取日志失败',
      status: failure?.status ?? null,
      lines: [],
      total: 0,
      limit,
      level,
    }
  }
}

/* ------------------------------------------------------------------ *
 * 系统信息
 * ------------------------------------------------------------------ */

/**
 * `/sysinfo`：`cpu_pct` 是**历史采样数组**（不是单值）、`ram_pct` 才是单值、本版没有 `disk`。
 * 这三个字段猜错的表现是「界面全显示 —」且不报错，最难发现，所以原样透出不做二次加工。
 */
export async function fetchSysinfo(instanceId: string, signal?: AbortSignal): Promise<SysinfoOut> {
  const instanceName = await currentBotName(signal)
  try {
    const raw = await get<SysinfoOut['sysinfo']>('/api/v1/sysinfo', { signal, timeoutMs: 8_000 })
    return { instance_id: MAIN_ID, instance_name: instanceName, available: 'ok', reason: null, sysinfo: raw ?? null }
  } catch (error) {
    if (error instanceof ApiFailure && error.kind === 'aborted') throw error
    const failure = error instanceof ApiFailure ? error : null
    return {
      instance_id: MAIN_ID,
      instance_name: instanceName,
      available: availabilityOf(failure),
      reason: failure?.detail ?? '读取系统信息失败',
      status: failure?.status ?? null,
      sysinfo: null,
    }
  }
}

/* ------------------------------------------------------------------ *
 * 策略
 * ------------------------------------------------------------------ */

/**
 * `/strategy/{name}` 的 `params` 是**可优化参数数组**（不是 dict）；
 * 源码可能几十 KB，界面不展示，只用 `code_available` 表示「有没有取到」。
 */
export async function fetchStrategy(instanceId: string, name?: string, signal?: AbortSignal): Promise<StrategyOut> {
  const instanceName = await currentBotName(signal)
  let strategyName = typeof name === 'string' && name.trim() ? name.trim() : null

  if (strategyName === null) {
    // 没指定就用当前策略：shell 模式下 /app/info.strategy 可能为 null → 回退配置
    try {
      const info = await get<RawAppInfo>('/api/v1/app/info', { signal, timeoutMs: 5_000 })
      if (typeof info.strategy === 'string' && info.strategy.trim()) strategyName = info.strategy.trim()
    } catch (error) {
      if (error instanceof ApiFailure && error.kind === 'aborted') throw error
    }
    if (strategyName === null) {
      try {
        const show = await get<RawShowConfig>('/api/v1/show_config', { signal, timeoutMs: 5_000 })
        if (typeof show.strategy === 'string' && show.strategy.trim()) strategyName = show.strategy.trim()
      } catch (error) {
        if (error instanceof ApiFailure && error.kind === 'aborted') throw error
      }
    }
  }

  if (strategyName === null) {
    return {
      instance_id: MAIN_ID,
      instance_name: instanceName,
      available: 'unsupported',
      reason: '当前没有加载策略（观察模式下不加载策略）',
      strategy: null,
      info: null,
    }
  }

  try {
    const raw = await get<{ strategy?: string; timeframe?: string; params?: StrategyParam[]; code?: string }>(
      `/api/v1/strategy/${encodeURIComponent(strategyName)}`,
      { signal, timeoutMs: 15_000 },
    )
    const code = typeof raw.code === 'string' ? raw.code : ''
    return {
      instance_id: MAIN_ID,
      instance_name: instanceName,
      available: 'ok',
      reason: null,
      strategy: raw.strategy ?? strategyName,
      code_available: code.length > 0,
      info: {
        strategy: raw.strategy ?? strategyName,
        timeframe: typeof raw.timeframe === 'string' ? raw.timeframe : undefined,
        // 参数是数组，保持数组
        params: Array.isArray(raw.params) ? raw.params : [],
      },
    }
  } catch (error) {
    if (error instanceof ApiFailure && error.kind === 'aborted') throw error
    const failure = error instanceof ApiFailure ? error : null
    return {
      instance_id: MAIN_ID,
      instance_name: instanceName,
      available: availabilityOf(failure),
      reason: failure?.detail ?? '读取策略信息失败',
      status: failure?.status ?? null,
      strategy: strategyName,
      info: null,
    }
  }
}

/* ------------------------------------------------------------------ *
 * 选币与屏蔽
 * ------------------------------------------------------------------ */

/**
 * `/whitelist` 的字段是 `method`（选币链类名数组）；
 * `/locks` 是**包装对象** `{lock_count, locks[]}`（C6）——直接当数组遍历会得到 undefined。
 */
export async function fetchPairlist(instanceId: string, signal?: AbortSignal): Promise<PairlistOut> {
  const instanceName = await currentBotName(signal)
  const errors: Record<string, string> = {}
  // 用对象持有而不是裸 `let`：闭包里赋值不会更新外层 `let` 的类型收窄，
  // TS 会把它当成恒为 null，读 `.detail` 时报 never。
  const first: { failure: ApiFailure | null } = { failure: null }

  const capture = async <T>(segment: string, path: string, timeoutMs: number): Promise<T | null> => {
    try {
      return await get<T>(path, { signal, timeoutMs })
    } catch (error) {
      if (error instanceof ApiFailure && error.kind === 'aborted') throw error
      const failure = error instanceof ApiFailure ? error : null
      if (first.failure === null) first.failure = failure
      // 「段名 → kind: detail」：单个段失败只影响自己，页面据此在对应位置显示原因
      errors[segment] = `${failure?.kind ?? 'unknown'}: ${failure?.detail ?? '未知错误'}`
      return null
    }
  }

  const [whitelist, blacklist, locks] = await Promise.all([
    capture<{ whitelist?: string[]; method?: string[] }>('whitelist', '/api/v1/whitelist', 8_000),
    capture<{ blacklist?: string[]; blacklist_expanded?: string[]; errors?: Record<string, string> }>(
      'blacklist',
      '/api/v1/blacklist',
      8_000,
    ),
    capture<{ lock_count?: number; locks?: PairlockRow[] }>('locks', '/api/v1/locks', 8_000),
  ])

  const lockRows = Array.isArray(locks?.locks) ? locks.locks : []
  // 三个段全挂才是「整块不可用」；只挂一段时列表照常显示，原因挂在 errors / reason 上
  const allFailed = whitelist === null && blacklist === null && locks === null

  return {
    instance_id: MAIN_ID,
    instance_name: instanceName,
    available: allFailed ? availabilityOf(first.failure) : 'ok',
    reason: allFailed ? (first.failure?.detail ?? '读取选币信息失败') : null,
    status: allFailed ? (first.failure?.status ?? null) : null,
    whitelist: Array.isArray(whitelist?.whitelist) ? whitelist.whitelist : [],
    // 上游叫 method，契约叫 whitelist_method：改名只在这一行
    whitelist_method: Array.isArray(whitelist?.method) ? whitelist.method : [],
    blacklist: Array.isArray(blacklist?.blacklist) ? blacklist.blacklist : [],
    blacklist_expanded: Array.isArray(blacklist?.blacklist_expanded) ? blacklist.blacklist_expanded : [],
    locks: lockRows,
    errors: { ...(blacklist?.errors ?? {}), ...errors },
  }
}

/* ------------------------------------------------------------------ *
 * 运行配置（脱敏后的只读视图）
 * ------------------------------------------------------------------ */

export async function fetchShowConfig(instanceId: string, signal?: AbortSignal): Promise<ShowConfigOut> {
  const instanceName = await currentBotName(signal)
  try {
    const raw = await get<Record<string, unknown>>('/api/v1/show_config', { signal, timeoutMs: 10_000 })
    return { instance_id: MAIN_ID, instance_name: instanceName, available: 'ok', reason: null, config: raw ?? null }
  } catch (error) {
    if (error instanceof ApiFailure && error.kind === 'aborted') throw error
    const failure = error instanceof ApiFailure ? error : null
    return {
      instance_id: MAIN_ID,
      instance_name: instanceName,
      available: availabilityOf(failure),
      reason: failure?.detail ?? '读取运行配置失败',
      status: failure?.status ?? null,
      config: null,
    }
  }
}
