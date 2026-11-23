/**
 * 配置读写 + **白名单式 diff** + 生效态解析。
 *
 * 三件事在这里，且只在这里：
 *   1. `GET/PUT /app/config` 与几个动作端点（mode / password / reload / restart）
 *   2. `FIELDS`：配置页表单的字段表（驱动渲染 + diff 白名单 + 分组锚点）
 *   3. `buildDiff()`：把「用户显式改过的点分路径」拼成最小 payload
 *
 * ★ 全文件最危险的一行是 `isRedacted(next) && !secretsReplaced.has(path)`：
 *   后端把密钥回传成 `***redacted***`，若把它当值提交回去，用户的交易所密钥/登录密码
 *   就会被覆盖成这串字面量，**下次登录直接锁死**。所以掩码默认绝不出现。
 */

import { get, post, put } from './http'
import { setInterrupting } from './http'
import { isRedacted } from './normalize'
import type { AppConfigOut, AppConfigSaved, AppMode, ConfigFieldSpec, ModeAccepted } from '../types'

/** 密钥掩码语义见 normalize.ts 的 REDACTED；这里只消费 `isRedacted()` */

/* ------------------------------------------------------------------ *
 * 端点
 * ------------------------------------------------------------------ */

export function fetchConfig(): Promise<AppConfigOut> {
  return get<AppConfigOut>('/api/v1/app/config', { timeoutMs: 10_000 })
}

/**
 * 保存增量配置。`config` 里**只放改动过的键**（后端是深合并语义，漏传的键保持原值）。
 * 返回 `applied` 四态 + `restart_required_for`，由页面决定提示与后续动作。
 */
export async function saveConfig(diff: Record<string, unknown>): Promise<AppConfigSaved> {
  const saved = await put<AppConfigSaved>('/api/v1/app/config', {
    body: { config: diff },
    timeoutMs: 20_000,
  })
  return {
    saved: saved.saved === true,
    applied: typeof saved.applied === 'string' ? saved.applied : 'reload_pending',
    changed: Array.isArray(saved.changed) ? saved.changed : [],
    restart_required_for: Array.isArray(saved.restart_required_for) ? saved.restart_required_for : [],
  }
}

/** `POST /app/mode`：HTTP 200 只表示「已受理」，真正是否切换成功由 mode store 轮询判定 */
export function requestMode(mode: AppMode): Promise<ModeAccepted> {
  return post<ModeAccepted>('/api/v1/app/mode', { body: { mode }, timeoutMs: 10_000 })
}

/** 改密码（后端要求 new_password ≥ 8 位）；旧 JWT 在过期前仍有效 */
export function changePassword(currentPassword: string, newPassword: string): Promise<ModeAccepted> {
  return post<ModeAccepted>('/api/v1/app/password', {
    body: { current_password: currentPassword, new_password: newPassword },
    timeoutMs: 10_000,
  })
}

/** 原地重载配置（不重启进程） */
export function reloadConfig(): Promise<unknown> {
  return post<unknown>('/api/v1/app/reload', { timeoutMs: 15_000 })
}

/**
 * 重启进程。**这是唯一会主动断连的动作**：请求返回后服务会短暂消失，
 * 因此立刻进入「中断期」，让所有页面的网络错误静默 20 秒。
 * 定时器兜底清零——不能只靠一次 `finally`（这里没有等待窗口）。
 */
export async function restartProcess(): Promise<void> {
  await post<unknown>('/api/v1/app/restart', { timeoutMs: 10_000 })
  setInterrupting(true)
  window.setTimeout(() => setInterrupting(false), 20_000)
}

export async function fetchStrategies(): Promise<string[]> {
  const res = await get<{ strategies?: string[] }>('/api/v1/strategies', { timeoutMs: 15_000 })
  return Array.isArray(res.strategies) ? res.strategies.filter((name) => !!name.trim()) : []
}

/** 交易所下拉：只要 `valid && !dex`（dex 交易所的配置项与中心化交易所不同，不支持在本页编辑） */
export async function fetchExchanges(): Promise<string[]> {
  const res = await get<{ exchanges?: { name?: string; valid?: boolean; dex?: boolean }[] }>('/api/v1/exchanges', {
    timeoutMs: 20_000,
  })
  const list = Array.isArray(res.exchanges) ? res.exchanges : []
  return list
    .filter((item) => item.valid === true && item.dex !== true && typeof item.name === 'string')
    .map((item) => String(item.name))
    .sort((a, b) => a.localeCompare(b))
}

/* ------------------------------------------------------------------ *
 * 点分路径读写
 * ------------------------------------------------------------------ */

/** `getAtPath(config, 'exchange.pair_whitelist')` */
export function getAtPath(root: Record<string, unknown> | null | undefined, path: string): unknown {
  if (!root) return undefined
  let cursor: unknown = root
  for (const key of path.split('.')) {
    if (!cursor || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor
}

/** 写入嵌套对象；中间层缺失时自动建 `{}`（diff 是稀疏树，必须能自建路径） */
export function setAtPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.')
  let cursor: Record<string, unknown> = target
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i]
    const next = cursor[key]
    if (!next || typeof next !== 'object' || Array.isArray(next)) cursor[key] = {}
    cursor = cursor[key] as Record<string, unknown>
  }
  cursor[keys[keys.length - 1]] = value
}

/** 只比较「我改过的那一个字段」，不做整树深比较（整树比较会把后端热载的键算成用户改动） */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * 字段表（7 组；G1 运行模式不是配置，走 `POST /app/mode`，故不在表内）
 * ------------------------------------------------------------------ */

export const FIELDS: ConfigFieldSpec[] = [
  // G2 交易所
  { path: 'exchange.name', kind: 'select', label: '交易所', group: 'exchange', hot: false, p0: true, options: fetchExchanges, hint: '改交易所等于换数据源，需要重启进程' },
  { path: 'exchange.key', kind: 'secret', label: 'API Key', group: 'exchange', hot: false, p0: true },
  { path: 'exchange.secret', kind: 'secret', label: 'API Secret', group: 'exchange', hot: false, p0: true },
  { path: 'exchange.password', kind: 'secret', label: 'API Passphrase', group: 'exchange', hot: false, p0: false, hint: 'OKX / KuCoin 需要，其余交易所留空' },
  { path: 'exchange.pair_whitelist', kind: 'lines', label: '交易对白名单', group: 'exchange', hot: false, p0: true, hint: '每行一个，格式 BASE/QUOTE' },
  { path: 'exchange.pair_blacklist', kind: 'lines', label: '交易对黑名单', group: 'exchange', hot: false, p0: false },

  // G3 资金与仓位
  { path: 'stake_currency', kind: 'text', label: '计价币', group: 'stake', hot: false, p0: true },
  { path: 'stake_amount', kind: 'text', label: '单笔投入', group: 'stake', hot: true, p0: true, hint: '数字，或 unlimited（按 max_open_trades 均分）' },
  { path: 'max_open_trades', kind: 'number', label: '最大同时持仓', group: 'stake', hot: true, p0: true, hint: '-1 表示不限' },
  { path: 'tradable_balance_ratio', kind: 'number', label: '可用余额比例', group: 'stake', hot: true, p0: false, hint: '0.99 表示只用 99% 的余额' },
  { path: 'dry_run_wallet', kind: 'number', label: '模拟盘本金', group: 'stake', hot: false, p0: false, hint: '仅在进程启动时初始化，改动对已有模拟盘无效' },

  // G4 策略与退出
  { path: 'strategy', kind: 'select', label: '策略', group: 'strategy', hot: false, p0: true, options: fetchStrategies },
  { path: 'timeframe', kind: 'select', label: '时间周期', group: 'strategy', hot: false, p0: true, hint: '策略主周期，如 5m' },
  { path: 'minimal_roi', kind: 'roi', label: '最小收益率（ROI）', group: 'strategy', hot: false, p0: true, hint: '键是持仓分钟数，必须含 0' },
  { path: 'stoploss', kind: 'number', label: '止损', group: 'strategy', hot: false, p0: true, hint: '-0.1 表示 -10%' },
  { path: 'force_entry_enable', kind: 'bool', label: '允许手动开仓', group: 'strategy', hot: true, p0: false },

  // G5 API 服务（listen_* 在 restart_only_paths 里）
  { path: 'api_server.listen_ip_address', kind: 'text', label: '监听地址', group: 'api', hot: false, p0: false, restartOnly: true },
  { path: 'api_server.listen_port', kind: 'number', label: '监听端口', group: 'api', hot: false, p0: false, restartOnly: true },
  { path: 'api_server.CORS_origins', kind: 'lines', label: '允许的跨域来源', group: 'api', hot: true, p0: false },

  // G6 安全
  { path: 'api_server.username', kind: 'text', label: '登录用户名', group: 'security', hot: true, p0: true },
  { path: 'api_server.password', kind: 'secret', label: '登录密码', group: 'security', hot: true, p0: true, hint: '改动后当前会话仍有效，但下次登录要用新密码' },
  { path: 'app.signal_token', kind: 'secret', label: '信号令牌', group: 'security', hot: true, p0: false, hint: '外部系统用它调用 /api/v1/signal' },
]

/** 字段表按 path 索引：页面回填时 O(1) 找到 kind，不必每次都 filter */
export function fieldByPath(path: string): ConfigFieldSpec | null {
  return FIELDS.find((field) => field.path === path) ?? null
}

/** 分组顺序固定：配置页锚点按这个顺序渲染 */
export const CONFIG_GROUPS: { id: string; title: string; desc: string }[] = [
  { id: 'exchange', title: '交易所', desc: '密钥与交易对。密钥类字段只会显示「已配置」，不会回显明文。' },
  { id: 'stake', title: '资金与仓位', desc: '单笔投入、最大持仓与模拟盘本金。' },
  { id: 'strategy', title: '策略与退出', desc: '策略、时间周期、ROI 与止损。' },
  { id: 'api', title: 'API 服务', desc: '监听地址与端口改动后必须重启才生效。' },
  { id: 'security', title: '安全', desc: '登录凭据与外部信号令牌。' },
]

/** 后端 `restart_only_paths`（形如 `[["api_server","listen_port"]]`）→ 点分路径集合 */
export function restartOnlyPaths(paths: readonly (readonly string[])[]): Set<string> {
  const out = new Set<string>()
  for (const parts of paths) {
    if (Array.isArray(parts) && parts.length) out.add(parts.join('.'))
  }
  return out
}

/* ------------------------------------------------------------------ *
 * buildDiff
 * ------------------------------------------------------------------ */

/**
 * 只遍历**字段表 × 用户显式改过的路径**，输出可直接提交的稀疏树。
 *
 * 为什么不深比较整棵树：后端热载后会自己微调一些键（如 `internals.heartbeat_interval`），
 * 深比较会把它算成「用户改动」，提交后就把前端猜的值写回去了——这是深合并语义下最隐蔽的数据污染源。
 *
 * @param baseline  `GET /app/config` 拿到的快照（含掩码）
 * @param draft     用户编辑中的完整树
 * @param dirty     用户显式改过的点分路径（只由字段控件写入）
 * @param secretsReplaced 用户点了「更换/清除」并给出新值的密钥路径
 */
export function buildDiff(
  baseline: Record<string, unknown>,
  draft: Record<string, unknown>,
  dirty: ReadonlySet<string>,
  secretsReplaced: ReadonlySet<string> = new Set<string>(),
  fields: readonly ConfigFieldSpec[] = FIELDS,
): Record<string, unknown> {
  const diff: Record<string, unknown> = {}
  for (const field of fields) {
    const path = field.path
    const touched = dirty.has(path) || secretsReplaced.has(path)
    if (!touched) continue

    const next = getAtPath(draft, path)
    if (next === undefined) continue

    // ★★ 掩码绝不提交：除非用户明确点了「更换/清除」，否则这个键连出现都不允许
    if (isRedacted(next) && !secretsReplaced.has(path)) continue

    // 改回原值就不必提交（只比较这一个字段，不是整树）
    if (!secretsReplaced.has(path) && sameValue(getAtPath(baseline, path), next)) continue

    setAtPath(diff, path, next)
  }
  return diff
}
