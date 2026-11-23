<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { UnauthorizedError, api, fetchConfig, getAtPath, normalizeTimeframe } from '../api/client'
import type { ChartMarker } from '../api/types'
import { useAppMode } from '../composables/useAppMode'
import { useCandles } from '../composables/useCandles'
import { useChartTheme } from '../composables/useChartTheme'
import { usePolling } from '../composables/usePolling'
import { money, price } from '../composables/useFormat'
import ChartCanvas from '../components/ChartCanvas.vue'
import ChartScopeBar from '../components/ChartScopeBar.vue'
import ModeSwitchDialog from '../components/ModeSwitchDialog.vue'
import StatePanel from '../components/StatePanel.vue'
import TopBar from '../components/TopBar.vue'

const route = useRoute()
const router = useRouter()
const { theme } = useChartTheme()
// 单实例化：useCandles 内部固定用 MAIN_ID，页面不再持有实例维度
const { meta, data, loading, metaLoading, error, errorStatus, fetchedAt, loadMeta, load } = useCandles()
const { state: modeState, isShell } = useAppMode()

const pairs = ref<string[]>([])
/** 配置里的主周期（`/app/config.timeframe`，形如 "5m"），用来决定默认粒度与可选粒度 */
const configuredTimeframe = ref<string | null>(null)
const pair = ref('')
const timeframe = ref('5m')
const limit = ref(300)
const hoverTime = ref<number | null>(null)
const now = ref(Date.now())
const listError = ref<string | null>(null)
const booting = ref(true)
const modeDialog = ref(false)

const LIMITS = [100, 300, 500]
/** 粒度胶囊的候选：配置里的主周期一定在，1m/5m 只有能取到时才给（见 canUse） */
const TIMEFRAME_CANDIDATES = ['1m', '5m']
const TIMEFRAME_ORDER = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '1d']

const KIND_LABEL: Record<ChartMarker['kind'], string> = {
  enter_long: '开多',
  exit_long: '平多',
  // 空头方向的标记由适配层从 enter_short/exit_short 列产出，文案要能区分方向
  enter_short: '开空',
  exit_short: '平空',
  // 上游没有 l2 拦截数据（该层已删），保留键是为了类型完整：这种标记不会出现
  block: '拦截',
}

/** 模式未知（`/app/info` 还没回来）时不下"观察模式"的结论，否则会闪一下空态 */
const shellMode = computed(() => modeState.loaded && isShell.value)

/**
 * 上游只缓存 bot 自身粒度：`/pair_candles` 请求别的粒度会被拒。
 * 因此「可选粒度」= 主周期本身，以及能从 1m 派生的 5m。拿不到主周期时不做限制。
 */
const baseTimeframe = computed<string | null>(() => configuredTimeframe.value ?? meta.value?.timeframe ?? null)
const timeframeOptions = computed(() => {
  const base = baseTimeframe.value
  const wanted = base ? [base, ...TIMEFRAME_CANDIDATES] : [...TIMEFRAME_CANDIDATES]
  const rank = (tf: string) => {
    const index = TIMEFRAME_ORDER.indexOf(tf)
    return index < 0 ? TIMEFRAME_ORDER.length : index
  }
  return [...new Set(wanted)].filter(canUse).sort((a, b) => rank(a) - rank(b))
})

const noWhitelist = computed(() => pairs.value.length === 0)
/** 首次装配或正在换 pair：这期间既不能出空态结论，也不能留一片空白 */
const pending = computed(() => booting.value || loading.value || metaLoading.value)

function canUse(tf: string): boolean {
  const base = baseTimeframe.value
  if (!base) return true
  return tf === base || (tf === '5m' && base === '1m')
}

const blocked = computed(() => {
  const reason = data.value?.reason
  // schema_mismatch 仍要画价格，只有其它 reason 才整块替换图区（02 §3.4）
  return Boolean(reason) && reason !== 'schema_mismatch'
})

const scopeKey = computed(() => [pair.value, timeframe.value, limit.value].join('|'))
const ageSeconds = computed(() => (fetchedAt.value ? Math.max(0, Math.floor((now.value - fetchedAt.value) / 1000)) : null))
const stale = computed(() => !blocked.value && ageSeconds.value !== null && ageSeconds.value > 60)
const hoveredBar = computed(() => (hoverTime.value === null ? null : data.value?.bars.find((b) => b.time === hoverTime.value) ?? null))
const hoveredMarkers = computed(() =>
  hoverTime.value === null ? [] : (data.value?.markers ?? []).filter((m) => m.time === hoverTime.value),
)

/** 标记总览：信号有没有接上，一眼可验证（空数组 = 这段窗口里策略没给信号） */
const markerCounts = computed(() => {
  const counts: Record<ChartMarker['kind'], number> = { enter_long: 0, exit_long: 0, enter_short: 0, exit_short: 0, block: 0 }
  for (const marker of data.value?.markers ?? []) counts[marker.kind] += 1
  return counts
})
const markerTotal = computed(() => data.value?.markers.length ?? 0)
const markerLegend = computed(() =>
  (['enter_long', 'exit_long', 'enter_short', 'exit_short'] as ChartMarker['kind'][])
    .map((kind) => ({ kind, label: KIND_LABEL[kind], count: markerCounts.value[kind] }))
    .filter((item) => item.count > 0),
)

/**
 * 白名单与主周期的兜底来源。
 *
 * 观察模式下 `/whitelist` 是 502（bot 没连交易所，没有选币结果），所以取交易对要回退到
 * `GET /app/config` 的 `exchange.pair_whitelist`；`timeframe` 同理取配置里的 `"5m"` 这种值
 * （`/status` 里的 `timeframe: 5` 是数字，不能直接当粒度用）。
 */
async function loadConfigFallback(): Promise<{ pairs: string[]; timeframe: string | null }> {
  try {
    const res = await fetchConfig()
    const rawPairs = getAtPath(res.config, 'exchange.pair_whitelist')
    const list = Array.isArray(rawPairs)
      ? rawPairs
          .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
          .map((item) => item.trim())
      : []
    return { pairs: list, timeframe: normalizeTimeframe(getAtPath(res.config, 'timeframe')) }
  } catch {
    // 配置也读不到：白名单留空走「没有可选交易对」的空态，不编造一对出来
    return { pairs: [], timeframe: null }
  }
}

async function bootstrap() {
  booting.value = true
  listError.value = null
  try {
    const loaded = await loadMeta()
    let list = loaded?.pair_whitelist ?? []
    let tf = normalizeTimeframe(loaded?.timeframe)
    if (!list.length || tf === null) {
      const fallback = await loadConfigFallback()
      if (!list.length) list = fallback.pairs
      if (tf === null) tf = fallback.timeframe
    }
    pairs.value = list
    configuredTimeframe.value = tf

    // 粒度先定：canUse / timeframeOptions 都依赖 configuredTimeframe
    const wantedTf = queryOf('timeframe')
    timeframe.value = wantedTf && canUse(wantedTf) ? wantedTf : (baseTimeframe.value ?? TIMEFRAME_CANDIDATES[1])
    const wantedPair = queryOf('pair')
    pair.value = list.includes(wantedPair) ? wantedPair : (list[0] ?? '')
    const wantedLimit = Number(queryOf('limit'))
    limit.value = LIMITS.includes(wantedLimit) ? wantedLimit : 300

    if (!shellMode.value) await fetchCandles()
    syncQuery()
  } catch (e) {
    if (e instanceof UnauthorizedError) return void router.push('/login')
    listError.value = e instanceof Error ? e.message : '加载交易对失败'
  } finally {
    booting.value = false
  }
}

async function fetchCandles() {
  if (!pair.value || shellMode.value) return
  try {
    await load({ pair: pair.value, timeframe: timeframe.value, limit: limit.value })
  } catch (e) {
    if (e instanceof UnauthorizedError) await router.push('/login')
  }
}

/** 重新拉取：只换数据不清画布（闪白会丢掉正在看的形态） */
async function reload() {
  await loadMeta()
  await fetchCandles()
}

/** 白名单可能整批换掉（动态选币），当前 pair 不在新列表里就落到第一个 */
async function reloadMeta() {
  const loaded = await loadMeta()
  let list = loaded?.pair_whitelist ?? []
  let tf = normalizeTimeframe(loaded?.timeframe)
  if (!list.length || tf === null) {
    const fallback = await loadConfigFallback()
    if (!list.length) list = fallback.pairs
    if (tf === null) tf = fallback.timeframe
  }
  pairs.value = list
  configuredTimeframe.value = tf
  if (!timeframeOptions.value.includes(timeframe.value)) {
    timeframe.value = timeframeOptions.value[0] ?? baseTimeframe.value ?? '5m'
  }
  if (!list.includes(pair.value)) pair.value = list[0] ?? ''
  await fetchCandles()
}

function pickPair(event: Event) {
  pair.value = (event.target as HTMLSelectElement).value
  void fetchCandles()
  syncQuery()
}

function pickTimeframe(tf: string) {
  if (!canUse(tf)) return
  timeframe.value = tf
  void fetchCandles()
  syncQuery()
}

function pickLimit(value: number) {
  limit.value = value
  void fetchCandles()
  syncQuery()
}

function queryOf(key: string): string {
  const value = route.query[key]
  return typeof value === 'string' ? value : ''
}

// replace 而非 push：刷新后停在原选择，但后退不该被 8 次切粒度淹没。
// 单实例化后 query 里不再有 instance：旧链接带来的 instance 会被这里一并清掉。
function syncQuery() {
  void router.replace({
    query: { pair: pair.value, timeframe: timeframe.value, limit: String(limit.value) },
  })
}

function openModeDialog() {
  modeDialog.value = true
}

function goOps() {
  modeDialog.value = false
  void router.push('/ops')
}

/** 「去配置」：配置页路由可能还没注册，退到运维页——那里有日志，能直接看到启动失败的原因 */
function goConfigure() {
  modeDialog.value = false
  const resolved = router.resolve('/config')
  void router.push(resolved.matched.length > 0 ? '/config' : '/ops')
}

// 价格精度随量级变化，口径统一在 useFormat.price()（≥1 四位 / <1 六位）

function stamp(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(5, 16).replace('T', ' ')} UTC`
}

usePolling(() => (now.value = Date.now()), 1_000)
// 观察模式切回交易模式：模式 store 一变就补一次取数，不必等用户手动刷新
watch(shellMode, (blockedMode) => {
  if (!blockedMode) void reload()
})
onMounted(() => void bootstrap())
</script>

<template>
  <div class="page">
    <TopBar :updated="ageSeconds !== null ? `数据 ${ageSeconds}s 前` : ''" :busy="loading" @refresh="reload" />

    <main class="main">
      <!-- 观察模式：整块换空态。不白屏、不出现红色错误——端点没坏，是 bot 没在交易 -->
      <StatePanel v-if="shellMode" tone="info" title="未在交易模式">
        <p>观察模式下进程不连接交易所，K 线接口不会返回任何行情。切到交易模式后这里才有数据。</p>
        <button class="btn btn-primary btn-sm panel-act" type="button" @click="openModeDialog">切换模式</button>
      </StatePanel>

      <template v-else>
        <div class="toolbar card">
          <label class="field">
            <span class="label">交易对</span>
            <select class="input pick" :value="pair" :disabled="noWhitelist" @change="pickPair">
              <option v-for="item in pairs" :key="item" :value="item">{{ item }}</option>
            </select>
          </label>

          <div class="field">
            <span class="label">粒度</span>
            <div class="pills">
              <button
                v-for="tf in timeframeOptions"
                :key="tf"
                type="button"
                class="pill"
                :class="{ on: timeframe === tf }"
                :title="tf === baseTimeframe ? '配置里的主周期' : `由 ${baseTimeframe} 派生`"
                @click="pickTimeframe(tf)"
              >{{ tf }}</button>
            </div>
          </div>

          <div class="field">
            <span class="label">根数</span>
            <div class="pills">
              <button
                v-for="value in LIMITS"
                :key="value"
                type="button"
                class="pill"
                :class="{ on: limit === value }"
                @click="pickLimit(value)"
              >{{ value }}</button>
            </div>
          </div>

          <button class="btn btn-secondary btn-sm reload" type="button" :disabled="loading || !pair" @click="reload">
            {{ loading ? '拉取中…' : '重新拉取' }}
          </button>
        </div>

        <div class="notices">
          <StatePanel v-if="listError" variant="inline" tone="error" :title="listError" action="重试" @action="bootstrap">
            交易对来自 bot 的选币列表与配置白名单，与画布上的行情是两件事。
          </StatePanel>
          <!-- 400 = pair 不在当前选币列表里：重试同一个 pair 只会再被拒，动作必须换成"重选" -->
          <StatePanel
            v-else-if="error && errorStatus === 400"
            variant="inline"
            tone="warn"
            :title="error"
            action="重新读取选币列表"
            @action="reloadMeta"
          >动态选币每轮换批，之前选中的 pair 可能已被换出。重新读取后会落到当前可用的第一个。</StatePanel>
          <StatePanel v-else-if="error" variant="inline" tone="error" :title="error" action="重试" @action="reload">
            画布仍是上一次拿到的数据。
          </StatePanel>
          <StatePanel
            v-if="stale"
            variant="inline"
            tone="warn"
            :title="`数据 ${ageSeconds}s 未刷新`"
            action="刷新"
            @action="reload"
          >行情可能已断流，图不会淡出——留在屏幕上的仍是最后一次拿到的那批 K 线。</StatePanel>
        </div>

        <StatePanel
          v-if="noWhitelist && !pending"
          tone="warn"
          title="没有可用的交易对"
          action="重新读取"
          @action="reloadMeta"
        >选币列表与配置白名单都是空的：观察模式下 bot 不连交易所，白名单要从配置里读。请先去配置页填 `exchange.pair_whitelist`。</StatePanel>

        <template v-else>
          <ChartScopeBar :data="data" :age-seconds="ageSeconds" @retry="reload" />

          <ChartCanvas
            v-if="data && !blocked"
            :bars="data.bars" :markers="data.markers" :theme="theme"
            :scope-key="scopeKey" @hover-time="hoverTime = $event"
          />
          <div v-else-if="pending" class="canvas-skeleton skeleton" />

          <!-- 信号标记总览：空数组也要说清"是这段没信号"，而不是让人怀疑标记层没接上 -->
          <div v-if="data && !blocked" class="legend card">
            <span class="eyebrow">信号标记</span>
            <span v-if="!markerTotal" class="muted">这段窗口里策略没有任何开平仓信号</span>
            <span v-for="item in markerLegend" :key="item.kind" class="badge num" :class="{
              up: item.kind === 'enter_long' || item.kind === 'exit_short',
              down: item.kind === 'exit_long' || item.kind === 'enter_short',
            }">{{ item.label }} {{ item.count }}</span>
            <span v-if="markerTotal" class="muted num">共 {{ markerTotal }} 个</span>
          </div>

          <div v-if="!blocked" class="readout card">
            <template v-if="hoveredBar">
              <span class="clock num">{{ stamp(hoveredBar.time) }}</span>
              <span class="num">O {{ price(hoveredBar.open) }}</span>
              <span class="num">H {{ price(hoveredBar.high) }}</span>
              <span class="num">L {{ price(hoveredBar.low) }}</span>
              <span class="num">C {{ price(hoveredBar.close) }}</span>
              <span class="num">V {{ money(hoveredBar.volume) }}</span>
              <span
                v-for="(marker, index) in hoveredMarkers"
                :key="`${marker.time}-${marker.kind}-${index}`"
                class="marker"
                :class="
                  marker.kind === 'enter_long' || marker.kind === 'exit_short'
                    ? 'up'
                    : marker.kind === 'exit_long' || marker.kind === 'enter_short'
                      ? 'down'
                      : 'muted'
                "
              >{{ KIND_LABEL[marker.kind] }} @{{ price(marker.price) }} {{ marker.enter_tag ? `tag=${marker.enter_tag}` : marker.reason ?? '' }}</span>
            </template>
            <span v-else class="muted">把光标移到画布上查看该根的开高低收与标记</span>
          </div>
        </template>
      </template>
    </main>

    <ModeSwitchDialog :open="modeDialog" @close="modeDialog = false" @go-ops="goOps" @go-config="goConfigure" />
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  padding-bottom: var(--space-2xl);
}

.main {
  max-width: 1180px;
  margin: 0 auto;
  padding: 24px var(--space-lg) 0;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--space-md);
  margin-bottom: var(--space-md);
  padding: 16px 18px;
}

.field {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.pick {
  min-width: 168px;
  max-width: 240px;
}

.pills {
  display: flex;
  gap: 2px;
  padding: 3px;
  border-radius: var(--radius-pill);
  background: var(--bg-secondary);
}

.pill {
  padding: 7px 14px;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.2s var(--ease), color 0.2s var(--ease);
}

.pill.on {
  background: var(--card-solid);
  color: var(--accent);
  box-shadow: var(--shadow-card);
}

.pill:disabled {
  opacity: 0.4;
  cursor: default;
}

.reload {
  margin-left: auto;
}

.notices {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  margin-bottom: var(--space-md);
}

.notices:empty {
  display: none;
}

.canvas-skeleton {
  height: clamp(420px, 62vh, 720px);
  border-radius: var(--radius-card);
}

.legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: var(--space-sm);
  padding: 10px 16px;
  font-size: 13px;
}

.badge {
  padding: 2px 9px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, currentColor 10%, transparent);
  font-size: 12.5px;
}

.readout {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  margin-top: var(--space-sm);
  padding: 10px 16px;
  font-size: 13px;
  color: var(--text-secondary);
}

.clock {
  font-weight: 600;
  color: var(--text);
}

.marker {
  padding: 2px 9px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, currentColor 10%, transparent);
  font-size: 12.5px;
}

/* 空态面板里的动作按钮：块级面板内容居中 */
.panel-act {
  margin-top: var(--space-sm);
}

/* 窄屏：每个控件独占一行，胶囊与下拉都不挤 */
@media (max-width: 720px) {
  .main {
    padding: 18px var(--space-md) 0;
  }
  .field {
    flex: 1 1 100%;
  }
  .pick {
    min-width: 0;
    width: 100%;
  }
  .reload {
    margin-left: 0;
    width: 100%;
  }
}
</style>
