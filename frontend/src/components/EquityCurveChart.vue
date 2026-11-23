<script setup lang="ts">
import { t } from '../i18n'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as echarts from 'echarts/core'
import type { EChartsCoreOption } from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { CurvePoint } from '../api/types'
import { money } from '../composables/useFormat'

// 按需注册：整包 echarts 上兆，本图只用折线+图例+提示框
echarts.use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

const props = defineProps<{
  curve: CurvePoint[]
  /** id 必须等于 instances[].id（后端就是按这个字段出的 series_id） */
  series: { id: string; name: string; equity: number | null }[]
  currency: string | null
}>()

const el = ref<HTMLDivElement | null>(null)
let chart: echarts.ECharts | null = null

/** 日期轴 = 所有点日期的并集，升序；前端不再排序第二遍以外的加工 */
const dates = computed(() => [...new Set(props.curve.map((p) => p.date))].sort())

const values = computed(() => {
  const map = new Map<string, Map<string, number | null>>()
  for (const point of props.curve) {
    let row = map.get(point.series_id)
    if (!row) map.set(point.series_id, (row = new Map()))
    row.set(point.date, point.value)
  }
  return map
})

const selected = ref<Record<string, boolean>>({})
const selectedCount = computed(() => props.series.filter((s) => selected.value[s.id]).length)

/** ≤6 条全勾；>6 条按总权益降序默认只勾前 3——全勾等于一屏糊在一起，图例仍可全量开关 */
function defaultSelection(): Record<string, boolean> {
  const ids = props.series.map((s) => s.id)
  if (ids.length <= 6) return Object.fromEntries(ids.map((id) => [id, true]))
  const top = new Set(
    [...props.series]
      .sort((a, b) => (b.equity ?? Number.NEGATIVE_INFINITY) - (a.equity ?? Number.NEGATIVE_INFINITY))
      .slice(0, 3)
      .map((s) => s.id),
  )
  return Object.fromEntries(ids.map((id) => [id, top.has(id)]))
}

// canvas 读不到 var()，只能把 token 解析成具体色值；切主题后必须重读，否则图表停在旧配色
function token(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

function buildOption(): EChartsCoreOption {
  const axisColor = token('--text-tertiary', '#86868b')
  const gridColor = token('--border', 'rgba(0, 0, 0, 0.07)')
  const unit = props.currency ? ` ${props.currency}` : ''

  return {
    // 曲线色板刻意避开绿/红色相（绿涨红跌是本项目铁律）
    color: [1, 2, 3, 4, 5, 6].map((i) => token(`--chart-${i}`, '#0071e3')),
    backgroundColor: 'transparent',
    animationDuration: 300,
    grid: { left: 8, right: 16, top: 44, bottom: 8, containLabel: true },
    legend: {
      top: 0,
      left: 0,
      itemWidth: 14,
      itemHeight: 2,
      textStyle: { color: axisColor, fontSize: 12 },
      // 勾选状态由本组件持有：每次 setOption 都带上，30s 刷新才不会把用户的开关重置
      selected: selected.value,
    },
    tooltip: {
      trigger: 'axis',
      valueFormatter: (value: unknown) => (typeof value === 'number' ? money(value) + unit : '—'),
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: dates.value.map((date) => date.slice(5)),
      axisLine: { lineStyle: { color: gridColor } },
      axisTick: { show: false },
      axisLabel: { color: axisColor, fontSize: 11.5 },
    },
    yAxis: {
      type: 'value',
      // 净值本身量级窄（1000 上下浮动几块），从 0 起画会把波动压成一条直线
      scale: true,
      axisLabel: { color: axisColor, fontSize: 11.5, formatter: (value: number) => money(value) },
      splitLine: { lineStyle: { color: gridColor } },
    },
    series: props.series.map((s) => {
      const row = values.value.get(s.id)
      return {
        id: s.id,
        name: s.name,
        type: 'line',
        showSymbol: false,
        // null 必须断开：补前值/插值/补 0 都会把"那天没有记录"画成"那天没有波动"
        connectNulls: false,
        lineStyle: { width: 2 },
        emphasis: { focus: 'series' },
        // 区间外（该实例没有这一天）同样给 null，不向前后延伸
        data: dates.value.map((date) => (row && row.has(date) ? (row.get(date) ?? null) : null)),
      }
    }),
  }
}

function render() {
  // notMerge:false + replaceMerge 只换 series：重建实例会丢掉用户点过的图例勾选
  chart?.setOption(buildOption(), { notMerge: false, replaceMerge: ['series'] })
}

function resize() {
  chart?.resize()
}

const themeObserver = new MutationObserver(() => render())

onMounted(() => {
  if (!el.value) return
  chart = echarts.init(el.value)
  // 用户点图例后同步回本地 state，下一次 setOption 才能把它带上
  chart.on('legendselectchanged', (event: unknown) => {
    selected.value = { ...((event as { selected?: Record<string, boolean> }).selected ?? {}) }
  })
  render()
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  window.addEventListener('resize', resize)
})

onBeforeUnmount(() => {
  themeObserver.disconnect()
  window.removeEventListener('resize', resize)
  chart?.dispose()
  chart = null
})

// 实例增删时重算默认勾选；日常轮询集合不变，不打扰用户的开关
watch(
  () => props.series.map((s) => s.id).join('|'),
  () => {
    selected.value = defaultSelection()
  },
  { immediate: true },
)

watch([() => props.curve, selected, () => props.series.map((s) => s.name).join('|')], render)
</script>

<template>
  <div class="wrap">
    <div ref="el" class="canvas" />
    <!-- 单人自用：超过 6 条只提示不阻止，替用户做决定比看清更难 -->
    <p v-if="selectedCount > 6" class="hint over">{{ t('同屏超过 6 条不好分辨，建议在图例里收敛到 6 条以内。') }}</p>
  </div>
</template>

<style scoped>
.canvas {
  width: 100%;
  height: 360px;
}

.over {
  margin-top: var(--space-sm);
}
</style>
