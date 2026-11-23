import { onBeforeUnmount, onMounted, shallowRef } from 'vue'

/**
 * 图表配色。canvas 读不到 CSS 变量（`var(--up)` 在 canvas 里只是字符串），
 * 所以必须用 getComputedStyle 把变量的**计算值**取出来喂给图表；
 * 并且监听 data-theme 变化重读一次 + applyOptions，否则切换主题后图表停在旧配色
 * —— 这是 canvas 图表最常见的主题 bug。
 */
export interface ChartTheme {
  /** 图表底色用 --card-solid：--card 是半透明的，会让网格线糊成一片 */
  bg: string
  text: string
  textSecondary: string
  textTertiary: string
  border: string
  up: string
  down: string
  accent: string
}

function snapshot(): ChartTheme {
  const style = getComputedStyle(document.documentElement)
  const read = (name: string) => style.getPropertyValue(name).trim()
  return {
    bg: read('--card-solid'),
    text: read('--text'),
    textSecondary: read('--text-secondary'),
    textTertiary: read('--text-tertiary'),
    border: read('--border'),
    up: read('--up'),
    down: read('--down'),
    accent: read('--accent'),
  }
}

export function useChartTheme() {
  const theme = shallowRef<ChartTheme>(snapshot())

  const resync = () => {
    theme.value = snapshot()
  }

  // 系统主题变化：只在用户没手动指定 data-theme 时生效，这里统一重读，多读一次无害
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  let observer: MutationObserver | null = null

  onMounted(() => {
    observer = new MutationObserver(resync)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    media.addEventListener('change', resync)
  })

  onBeforeUnmount(() => {
    observer?.disconnect()
    media.removeEventListener('change', resync)
  })

  return { theme }
}
