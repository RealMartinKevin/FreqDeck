/**
 * 轻量 i18n：中文原文即 message key，英文单独一张表。
 *
 * 为什么不用 vue-i18n：界面只需要「字符串 + {name} 插值」，用不上复数规则、
 * 日期/数字本地化与消息编译；零依赖还能避开 node_modules 跨平台原生包的问题。
 *
 * 为什么用中文原文作 key：现有界面已有数百条中文文案，逐条另起语义 key 既要
 * 维护对照表、又容易写错映射。直接用原文作 key，字典缺项时 t() 原样回退中文，
 * 漏翻只会显示中文（而不是空白或 `some.missing.key`），便于分批补齐。
 */
import { computed, ref } from 'vue'
import { en } from './messages'

export type Locale = 'zh-CN' | 'en-US'
export const LOCALES: readonly Locale[] = ['zh-CN', 'en-US'] as const

const STORAGE_KEY = 'ftm-locale'
const DOC_TITLE_KEY = 'Freqtrade 控制台'

function readStoredLocale(): Locale | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v === 'zh-CN' || v === 'en-US' ? v : null
  } catch {
    // 隐私模式 / file:// 下 localStorage 可能不可用
    return null
  }
}

/** 无显式选择时保持中文：面向中文用户，且与既有界面、截图一致。 */
export const locale = ref<Locale>(readStoredLocale() ?? 'zh-CN')

const messages = computed<Record<string, string>>(() =>
  locale.value === 'en-US' ? en : {},
)

/**
 * 翻译。未收录的 key 原样返回（中文）。
 * 插值用 {name}：t('数据更新于 {n} 秒前', { n: 12 })。
 *
 * 内部读 locale.value，因此在模板 / computed / 函数内调用会随语言切换自动重算。
 * 注意：模块顶层常量（如 `const LABELS = { a: '中文' }`）只会在加载时求值一次，
 * 这类数据请保留中文原文，在渲染处用 t(value) 包裹，否则切换后不会更新。
 */
export function t(
  key: string,
  params?: Record<string, string | number | null | undefined>,
): string {
  const template = messages.value[key] ?? key
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return whole
    const v = params[name]
    // null / undefined 表示「不知道」，按项目口径显示 —，绝不补 0
    return v === null || v === undefined ? '—' : String(v)
  })
}

export function setLocale(next: Locale): void {
  if (next !== 'zh-CN' && next !== 'en-US') return
  locale.value = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    /* 隐私模式下忽略，本次会话内仍然生效 */
  }
  applyDocumentLocale()
}

export function toggleLocale(): void {
  setLocale(locale.value === 'zh-CN' ? 'en-US' : 'zh-CN')
}

/** 同步 <html lang> 与标题；index.html 的首帧脚本也做了同样的事，避免闪烁。 */
export function applyDocumentLocale(): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = locale.value
  document.title = t(DOC_TITLE_KEY)
}
