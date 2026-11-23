// 数字与时长的人话表述集中一处：汇总条与实例卡必须逐字一致，否则同一个数字换个位置就长得不一样。
// 这里只做"格式化"，不做任何日历日期运算——每日盈亏的日期切分由后端按 UTC 算好。
const nf = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** 金额，不带正负号；null = 没数据，显示破折号 */
export function money(v: number | null): string {
  return v === null ? '—' : nf.format(Math.abs(v))
}

/**
 * 盈亏，带 +/- 号。0 显示 0.00（有数据且为零），null 显示 —（无数据），两者不能混。
 *
 * 签名收 `undefined` 并拦 `NaN`：上游字段缺失时（如标签端点的 `profit_abs`）拿到的是
 * `undefined`，只判 `null` 会让它走进 `Intl.NumberFormat` 并在界面上直接印出 `NaN`——
 * 数字看着像"有数据"，最难发现。
 */
export function signed(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return (v > 0 ? '+' : v < 0 ? '-' : '') + nf.format(Math.abs(v))
}

/** 涨绿跌红，零与无数据用次要色 */
export function tone(v: number | null): 'up' | 'down' | 'muted' {
  return v === null || v === 0 ? 'muted' : v > 0 ? 'up' : 'down'
}

/** 秒数转人话；只做时长换算，不涉及日期串 */
export function humanizeAge(seconds: number | null): string {
  if (seconds === null) return '数据时间未知'
  if (seconds < 60) return `数据 ${seconds}s 前`
  if (seconds < 3600) return `数据 ${Math.floor(seconds / 60)} 分钟前`
  return `数据 ${Math.floor(seconds / 3600)} 小时前`
}

/**
 * 百分数：传入值**已经是百分数**（1.5 → 1.50%，不再 ×100），后端已按此口径出数。
 * sign=false 用于胜率这类"比例"而非"变化"——给胜率加正号会被读成涨幅。
 * null 显示 —（不知道），不是 0.00%（确实是零）。
 */
export function pct(v: number | null | undefined, digits = 2, sign = true): string {
  // undefined / NaN 与 null 同义：都是「不知道」，不能写成 0.00%
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  const body = Math.abs(v).toFixed(digits)
  const mark = v < 0 ? '-' : sign && v > 0 ? '+' : ''
  return `${mark}${body}%`
}

// Intl.NumberFormat 构造开销大，按千次调用摊薄，模块级建一次
const qtyFmt = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 })

/** 数量（基础币）：千分位 + 去掉尾零；null → — */
export function qty(v: number | null): string {
  return v === null ? '—' : qtyFmt.format(v)
}

/**
 * 价格：≥1 保留 4 位，<1 保留 6 位。
 *
 * 为什么分级：BTC 的 4 位已经到 0.0001 USDT，够用；但山寨币/AI 类币的开仓价
 * 常是 0.00001234，统一 4 位会显示成 0.0000，看起来像"价格为零"——比不显示更糟。
 * 这两档此前在 OpenPositionsTable / ClosedTradesTable / Positions / CandleChart
 * 各写了一遍，口径必须只有一份，否则同一个价格在两张表里长得不一样。
 *
 * null（不知道）与 NaN 都显示 —，绝不显示 0.0000。
 */
export function price(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—'
  return v >= 1 ? v.toFixed(4) : v.toFixed(6)
}

/** 持仓时长：3d 4h / 2h 14m / 48m；null 或负数 → — */
export function duration(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec) || sec < 0) return '—'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  // 不足 1 小时只显示分钟：挂了几十秒的仓显示「0h 0m」等于没说
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}
