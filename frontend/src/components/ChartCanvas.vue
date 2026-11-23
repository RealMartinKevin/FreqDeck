<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { CandlestickSeries, ColorType, CrosshairMode, LineSeries, LineStyle, createChart, createSeriesMarkers } from 'lightweight-charts'
import type { IChartApi, ISeriesApi, ISeriesMarkersPluginApi, SeriesMarker, Time, UTCTimestamp } from 'lightweight-charts'
import type { CandleBar, ChartMarker } from '../api/types'
import type { ChartTheme } from '../composables/useChartTheme'

const props = defineProps<{
  bars: CandleBar[]
  markers: ChartMarker[]
  theme: ChartTheme
  /** 数据身份（实例+pair+粒度+根数）：变了才 fitContent，刷新时不能跳视野 */
  scopeKey: string
}>()

const emit = defineEmits<{ hoverTime: [time: number | null] }>()

const host = ref<HTMLDivElement | null>(null)
let chart: IChartApi | null = null
let candles: ISeriesApi<'Candlestick'> | null = null
let supportLine: ISeriesApi<'Line'> | null = null
let markerLayer: ISeriesMarkersPluginApi<Time> | null = null
let lastScopeKey = ''

// lightweight-charts v5：createChart + chart.addSeries(CandlestickSeries) + createSeriesMarkers。
// v4 的 addCandlestickSeries / series.setMarkers 在 5.x 已不存在。
onMounted(() => {
  const el = host.value
  if (!el) return
  chart = createChart(el, {
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: props.theme.bg }, textColor: props.theme.textSecondary, fontSize: 12 },
    grid: { vertLines: { color: props.theme.border }, horzLines: { color: props.theme.border } },
    rightPriceScale: { borderColor: props.theme.border, scaleMargins: { top: 0.12, bottom: 0.12 } },
    timeScale: { borderColor: props.theme.border, timeVisible: true, secondsVisible: false, rightOffset: 4 },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: props.theme.textTertiary, width: 1, style: LineStyle.Dashed, labelBackgroundColor: props.theme.textSecondary },
      horzLine: { color: props.theme.textTertiary, width: 1, style: LineStyle.Dashed, labelBackgroundColor: props.theme.textSecondary },
    },
  })

  candles = chart.addSeries(CandlestickSeries, { upColor: props.theme.up, downColor: props.theme.down, borderVisible: false, wickUpColor: props.theme.up, wickDownColor: props.theme.down })
  // 支撑线：逐根给值，缺支撑的根只给 time（whitespace）→ 线在那里断开，不猜不连
  supportLine = chart.addSeries(LineSeries, {
    color: props.theme.accent,
    lineWidth: 1,
    lineStyle: LineStyle.Dashed,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  })
  markerLayer = createSeriesMarkers(candles, [])

  chart.subscribeCrosshairMove((param) => {
    // 标记不做 hover tooltip（要自绘 DOM 层），读数条据此取最近一根核对 enter_tag
    emit('hoverTime', param.time === undefined ? null : Number(param.time))
  })

  paint()
})

onBeforeUnmount(() => {
  chart?.remove()
  chart = null
  candles = null
  supportLine = null
  markerLayer = null
})

watch([() => props.bars, () => props.markers], paint)
watch(
  () => props.theme,
  (theme) => {
    chart?.applyOptions({
      layout: { background: { type: ColorType.Solid, color: theme.bg }, textColor: theme.textSecondary },
      grid: { vertLines: { color: theme.border }, horzLines: { color: theme.border } },
      rightPriceScale: { borderColor: theme.border },
      timeScale: { borderColor: theme.border },
      crosshair: {
        vertLine: { color: theme.textTertiary, labelBackgroundColor: theme.textSecondary },
        horzLine: { color: theme.textTertiary, labelBackgroundColor: theme.textSecondary },
      },
    })
    candles?.applyOptions({ upColor: theme.up, downColor: theme.down, wickUpColor: theme.up, wickDownColor: theme.down })
    supportLine?.applyOptions({ color: theme.accent })
  },
)

function paint() {
  if (!chart || !candles || !supportLine || !markerLayer) return
  candles.setData(
    props.bars.map((bar) => ({
      time: bar.time as UTCTimestamp,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    })),
  )
  supportLine.setData(
    props.bars.map((bar) =>
      bar.support ? { time: bar.time as UTCTimestamp, value: bar.support.value } : { time: bar.time as UTCTimestamp },
    ),
  )
  markerLayer.setMarkers(toMarkers(props.markers))

  // 只在"换了数据身份"时重设视野：每次刷新都 fitContent 会让用户正在看的形态跳走
  if (props.scopeKey !== lastScopeKey && props.bars.length) {
    lastScopeKey = props.scopeKey
    chart.timeScale().fitContent()
  }
}

const MARKER_SHAPE: Record<ChartMarker['kind'], 'arrowUp' | 'arrowDown' | 'circle'> = {
  enter_long: 'arrowUp',
  exit_long: 'arrowDown',
  // 空头方向与多头镜像：进空朝下、平空朝上，形状与颜色一起反，避免和做多混淆
  enter_short: 'arrowDown',
  exit_short: 'arrowUp',
  block: 'circle',
}

function toMarkers(markers: ChartMarker[]): SeriesMarker<Time>[] {
  return markers.map((marker) => ({
    time: marker.time as UTCTimestamp,
    // atPrice* 才让 markers[].price 真正生效：后端为了兜底算出的那个价格不该被丢掉
    position: 'atPriceMiddle',
    price: marker.price,
    shape: MARKER_SHAPE[marker.kind],
    color:
      marker.kind === 'enter_long' || marker.kind === 'exit_short'
        ? props.theme.up
        : marker.kind === 'exit_long' || marker.kind === 'enter_short'
          ? props.theme.down
          : props.theme.textTertiary,
    size: marker.kind === 'block' ? 0.8 : 1.2,
  }))
}
</script>

<template>
  <div ref="host" class="canvas" />
</template>

<style scoped>
/* 高度按设计稿 clamp(420px, 62vh, 720px)：500 根时再低就看不清回踩位 */
.canvas {
  height: clamp(420px, 62vh, 720px);
  border-radius: var(--radius-card);
  overflow: hidden;
  background: var(--card-solid);
  border: 1px solid var(--border);
}
</style>
