/**
 * 对外 `api` 门面：签名与旧 `src/api/client.ts` **逐一对齐**（含 `instanceId` 形参），
 * 这样 12 个组件 + 6 个 view 的 `import { api } from '../api/client'` 一行都不用改。
 *
 * 单实例世界里的「实例」只有一个，`instanceId` 一律忽略；`MAIN_ID` 让既有契约里的
 * `instance_id` 字段始终有值，组件不需要新增判空分支。
 *
 * 本批（B02）只接「看板 / 持仓 / K 线」需要的端点。运维、统计、配置三块的端点
 * 属于后续批次，这里先以**明确报错**占位——宁可让页面显示「尚未接入」，
 * 也不能返回假数据（假数据会被当成 bug 排查半天）。
 */

import { ApiFailure } from './errors'
import * as auth from './auth'
import { del, get, post } from './http'
import { MAIN_ID, botName, DEFAULT_BOT_NAME } from './mappers'
import { CANDLE_LIMIT_MAX, normalizeTimeframe } from './candles'
import { fetchChartMeta, fetchCandles } from './candles'
import { fetchOverview, fetchPositionsOpen } from './snapshot'
import { fetchTrades, invalidateTradesWindow } from './trades'
import { fetchAnalytics } from './analytics'
import { fetchLogs, fetchPairlist, fetchShowConfig, fetchStrategy, fetchSysinfo } from './obs'
import type { CandleQuery } from './candles'
import type { TradesQuery } from './trades'
import type {
  ActionResult,
  AnalyticsOut,
  CandlesOut,
  ChartMetaOut,
  CustomDataRow,
  InstanceIn,
  InstanceOut,
  LifecycleAction,
  LogsOut,
  OverviewOut,
  PairlistOut,
  PositionAction,
  PositionActionResult,
  PositionsOut,
  ProvisionPreview,
  ProvisionResult,
  RawAppInfo,
  RawShowConfig,
  ShowConfigOut,
  StrategyOut,
  SysinfoOut,
  TradeDetail,
  TradeDetailOut,
  TradesOut,
} from '../types'

/** 虚拟单实例 id 从 mappers 统一导出，避免两处常量漂移 */
export { MAIN_ID, CANDLE_LIMIT_MAX, invalidateTradesWindow }

function baseUrl(): string {
  return typeof location === 'undefined' ? '' : location.origin
}

export const api = {
  // ------------------------------------------------------------- 认证（S2：JWT）
  /**
   * 旧登录页只收集口令（用户名固定 admin）。B03 会改成「用户名 + 密码」，
   * 届时 view 改用 `loginWithCredentials`，这里保留旧签名不让 typecheck 断。
   */
  login: async (password: string): Promise<void> => {
    await auth.login('admin', password)
  },
  loginWithCredentials: async (username: string, password: string): Promise<void> => {
    await auth.login(username, password)
  },
  /** freqtrade 没有 logout 端点：清本地令牌就是登出 */
  logout: async (): Promise<void> => {
    auth.clear()
  },
  me: async (): Promise<{ authenticated: boolean }> => ({ authenticated: auth.hasSession() }),

  health: async (): Promise<{ status: string; version: string }> => {
    const [ping, info] = await Promise.all([
      get<{ status?: string }>('/api/v1/ping', { timeoutMs: 5_000 }),
      get<RawAppInfo>('/api/v1/app/info', { timeoutMs: 5_000 }).catch(() => null),
    ])
    return { status: ping.status ?? 'pong', version: info?.version ?? '' }
  },

  // ------------------------------------------------------------- 看板
  /**
   * `signal` 只为一件事存在：页面卸载时把正在飞的 6 个并发请求一起断掉。
   * 不接 signal 的旧调用（`api.overview()`）行为完全不变——默认参数是空对象。
   * 取消以 `ApiFailure('aborted')` 抛出，调用方应当静默忽略。
   */
  overview: (options: { signal?: AbortSignal } = {}): Promise<OverviewOut> => fetchOverview(options),

  // --- 多实例能力已整体下线（对比 / 实例 CRUD / systemd 托管）。
  // 留一个「返回空列表」的假实现会让后来者以为后端还有这个能力，比直接报错更难排查。

  // ------------------------------------------------------------- 持仓
  positionsOpen: (): Promise<PositionsOut> => fetchPositionsOpen(),

  /**
   * 平仓 / 撤单。两个动作都不可撤销，调用前必须已经过二次确认（view 层负责）。
   * 失败**不抛**：返回 `ok:false + error`，因为页面要在行内显示原因而不是整页报错。
   */
  positionAction: async (instanceId: string, tradeId: number, action: PositionAction): Promise<PositionActionResult> => {
    try {
      if (action === 'force_exit') {
        await post<unknown>('/api/v1/forceexit', { body: { tradeid: tradeId }, timeoutMs: 15_000 })
      } else {
        // 撤单不平仓：只删未成交挂单
        await del<unknown>(`/api/v1/trades/${tradeId}/open-order`, { timeoutMs: 15_000 })
      }
      // 动作生效后窗口必须失效：否则「已平仓」列表还是旧的，用户以为没生效
      invalidateTradesWindow()
      return { action, trade_id: tradeId, ok: true, detail: '成交结果会在下一次刷新时反映', error: null }
    } catch (error) {
      if (error instanceof ApiFailure && error.kind === 'aborted') throw error
      const failure = error instanceof ApiFailure ? error : new ApiFailure('server_error', {})
      return {
        action,
        trade_id: tradeId,
        ok: false,
        error: { kind: failure.kind, detail: failure.detail, status: failure.status },
      }
    }
  },

  trades: (params: TradesQuery, options?: { force?: boolean }): Promise<TradesOut> => fetchTrades(params, options),

  tradeDetail: async (instanceId: string, tradeId: number): Promise<TradeDetailOut> => {
    const [trade, custom, show] = await Promise.all([
      get<Record<string, unknown>>(`/api/v1/trade/${tradeId}`),
      // 自定义数据是「有就展示」的增强信息，取不到不算错误（旧契约同样给 []）
      get<unknown[]>(`/api/v1/trades/${tradeId}/custom-data`).catch(() => []),
      get<RawShowConfig>('/api/v1/show_config').catch(() => null),
    ])
    return {
      instance_id: MAIN_ID,
      instance_name: botName(show),
      available: 'ok',
      reason: null,
      trade: trade as unknown as TradeDetail,
      custom_data: mapCustomData(custom),
    }
  },

  // ------------------------------------------------------------- K 线
  chartMeta: (instanceId: string): Promise<ChartMetaOut> => fetchChartMeta(instanceId),
  candles: (instanceId: string, params: CandleQuery): Promise<CandlesOut> => fetchCandles(instanceId, params),

  // ------------------------------------------------------------- 运维 / 统计（B03）
  logs: (instanceId: string, params: { limit?: number; level?: string } = {}): Promise<LogsOut> =>
    fetchLogs(instanceId, params),
  sysinfo: (instanceId: string): Promise<SysinfoOut> => fetchSysinfo(instanceId),
  instanceConfig: (instanceId: string): Promise<ShowConfigOut> => fetchShowConfig(instanceId),
  strategyInfo: (instanceId: string, name?: string): Promise<StrategyOut> => fetchStrategy(instanceId, name),
  analytics: (instanceId: string, params: { days?: number; weeks?: number; months?: number } = {}): Promise<AnalyticsOut> =>
    fetchAnalytics(instanceId, params),
  pairlist: (instanceId: string): Promise<PairlistOut> => fetchPairlist(instanceId),
}

/** 上游 custom-data 是 `[{key,type,value}]`；形状不符就当作没有（不是错误） */
function mapCustomData(raw: unknown): CustomDataRow[] {
  if (!Array.isArray(raw)) return []
  const rows: CustomDataRow[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const row = item as { key?: unknown; type?: unknown; value?: unknown }
    if (typeof row.key !== 'string' || !row.key.trim()) continue
    rows.push({
      key: row.key,
      type: typeof row.type === 'string' ? row.type : undefined,
      value: row.value,
    })
  }
  return rows
}

/** K 线页显示「最多 500 根」时用的常量（与适配层同一个来源） */
export const CANDLE_LIMIT = CANDLE_LIMIT_MAX
/** 时间周期归一（`5` → `"5m"`）：view 的 select 需要同一套取值 */
export { normalizeTimeframe }
/** 单实例 bot 名的兜底值：状态卡在没有 `/show_config` 时用它 */
export const FALLBACK_BOT_NAME = DEFAULT_BOT_NAME

/* ------------------------------------------------------------------ *
 * 适配层对外暴露的领域 API（配置 / 模式 / 运维）
 *
 * 视图一律从 `../api/client` 引入，不要深链到 `ft/`——那样一旦适配层内部
 * 拆文件，页面就会跟着改。这里显式列出可用的名字，等于把「公共面」钉死。
 * ------------------------------------------------------------------ */

export {
  buildDiff,
  changePassword,
  CONFIG_GROUPS,
  FIELDS,
  fieldByPath,
  fetchConfig,
  fetchExchanges,
  fetchStrategies,
  getAtPath,
  reloadConfig,
  requestMode,
  restartOnlyPaths,
  restartProcess,
  saveConfig,
  setAtPath,
} from './config'

export {
  appModeState,
  beginConfirm,
  currentModeBadge,
  describeMode,
  modeSwitchState,
  onModeSettled,
  refresh as refreshMode,
  resetSwitch,
  startPolling,
  stopPolling,
  SWITCH_PROGRESS_TEXT,
  switchTo,
} from './mode'

export { fetchLogs, fetchPairlist, fetchShowConfig, fetchStrategy, fetchSysinfo } from './obs'
export { fetchAnalytics } from './analytics'
/** 会话真的失效时由 http 层回调：router 注册它把用户送回登录页（api 层不 import router，避免循环依赖） */
export { setUnauthorizedHandler } from './http'
export type { LogsQuery } from './obs'
export type { AnalyticsQuery } from './analytics'
export type { ModeBadgeInfo, ModeState, ModeTone, SwitchPhase, SwitchState } from './mode'
