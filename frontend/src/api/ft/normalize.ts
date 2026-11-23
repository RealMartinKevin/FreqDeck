/**
 * 口径工具：单位、时间、掩码、限流的**唯一转换点**（设计 §3）。
 *
 * 这个文件只做「值 → 值」的纯转换，不认识任何业务字段名，也不发请求。
 * 之所以要集中：freqtrade 同时给 `*_ratio`（0.0062）与 `*_pct`（0.62），
 * 谁都能在自己那一层乘个 100；一旦散落，界面上会出现「0.62% 和 62% 并存」。
 *
 * ★ 三态铁律：null=不知道、0=确实是零、[]=确实是空。
 *   所以本文件每个数值函数失败时返回 **null**，绝不返回 0；
 *   全代码库禁止 `?? 0`（会把「不知道」渲染成「零」）。
 */

/** 后端把密钥回传成这个字面量；原样提交回去会把密码改成这串字符，直接锁死登录 */
export const REDACTED = '***redacted***'

/** 上游 `/pair_candles` 的硬上限；超过不报错，只是截断 */
export const LIMIT_MAX = 500

/**
 * 时间 → ISO 8601 UTC Z（契约层唯一形态），失败 → null。
 *
 * 三种输入都要兼容（实测三种都真实出现过）：
 *   1. `"2026-11-22T19:12:52Z"`        —— 已经是目标形态，**原样返回**（幂等）
 *   2. `"2026-11-22 15:00:00+00:00"`   —— `/pair_candles` 的 data_start/data_stop
 *   3. `"2026-11-22 19:12:52"`          —— SQLite 里的无时区 UTC 文本
 *
 * 幂等很关键：同一个值被两层各转一次时，不能出现 `...+00:00Z` 这种脏字符串。
 */
export function isoZ(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null

  // 1. 已经是严格 ISO Z：直接返回，不要走 Date 往返（往返会丢掉微秒位）
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(text)) return text

  // 3. 无时区的库内文本（SQLite `"2026-11-22 19:12:52"`）：按 UTC 补 Z，**不走 Date**。
  // 走 Date 会得到 `.000Z`，而契约与既有组件都按 `...:52Z` 这个形态对齐；
  // 多出来的毫秒位会让「时间相等」的字符串比较全部失效。
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(text)) return `${text.replace(' ', 'T')}Z`

  // 2. 带时区偏移（含 +00:00）：交给 Date 解析后归一成 Z
  const hasZone = /(?:[+-]\d{2}:?\d{2}|Z)$/.test(text)
  const candidate = hasZone ? text : `${text.replace(' ', 'T')}Z`

  const ms = Date.parse(candidate)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString()
}

/**
 * 任意值 → 有限数字，否则 null。
 *
 * **不接受数字字符串**：`"unlimited"`（`stake_amount` 的取值）与 `"5"` 长得一样，
 * 兼容字符串必然把 unlimited 变成 NaN 或 0。字符串转换由需要的地方自己显式做。
 */
export function num(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

/**
 * 比例 → 百分数（0.0062 → 0.62）。
 *
 * 只在**确认上游给的是 ratio** 时才用。freqtrade 的 `profit_pct` / `winrate` /
 * `close_profit_pct` 已经是百分数且含杠杆，再走这里就等于 ×100 两次。
 */
export function pctFromRatio(value: unknown): number | null {
  const ratio = num(value)
  return ratio === null ? null : ratio * 100
}

/** 是不是「密钥未改动」的掩码。配置页据此决定「该键不提交」 */
export function isRedacted(value: unknown): boolean {
  return value === REDACTED
}

/**
 * 今日（UTC）`YYYY-MM-DD`。
 *
 * 交易日以 UTC 切分：用本地时区的 `toLocaleDateString` 会在东八区把凌晨 0-8 点的
 * 成交算到前一天，与后端的 `/daily` 对不上。
 */
export function utcToday(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * 条数上限收敛：非法/缺省 → `fallback`，小数取整，越界夹到 [1, LIMIT_MAX]。
 * 上游 `/pair_candles` 上限 500、`/trades` 单页上限 500，超了不报错只是截断，
 * 所以在客户端先夹住，界面回显的 limit 才与实际拿到的根数一致。
 */
export function clampLimit(value: unknown, fallback: number = LIMIT_MAX): number {
  const parsed = num(value)
  if (parsed === null) return Math.min(Math.max(Math.trunc(fallback), 1), LIMIT_MAX)
  const floored = Math.trunc(parsed)
  if (floored < 1) return 1
  if (floored > LIMIT_MAX) return LIMIT_MAX
  return floored
}

/**
 * enter_tag / exit_tag → 可用标签或 null。
 * 空串不是标签（上游对「无标签」给的是 `''`），组件按 null 不渲染。
 * JSON 里的 Python `None` 已经是 `null`，不需要再认 `"None"` 字符串。
 */
export function tagOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text ? text : null
}

/**
 * 信号列真值判定。上游 signal 列实测是 `1` / `true` / `null`（NaN 时是 `None`），
 * 且 `0` / `''` / `null` 都表示「没有信号」。
 * 注意不能用 `!== null` 判断：`0` 会被误当成信号。
 */
export function truthySignal(value: unknown): boolean {
  if (value === true) return true
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    return text === '1' || text === 'true'
  }
  return false
}

/**
 * 去重保序 + 去掉空值。
 * 用于 pairlist / exit_reason 这类 facet 列表：上游可能重复给，
 * 而 `<option>` 重复会造成「选了又跳回第一项」的诡异现象。
 */
export function distinct(values: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const text = typeof value === 'string' ? value.trim() : ''
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

/**
 * 单值或数组 → 数组。上游部分端点在「一个」与「多个」之间摇摆
 * （如 `whitelist.method` 可能是字符串也可能是数组），统一在这里吸收。
 */
export function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return []
  return Array.isArray(value) ? value : [value]
}
