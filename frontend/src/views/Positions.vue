<script setup lang="ts">
import { t } from '../i18n'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { MAIN_ID, NetworkError, UnauthorizedError, api, errorDetailText } from '../api/client'
import { ApiFailure } from '../api/client'
import type { ErrorDetailSource } from '../api/client'
import type {
  ClosedTradeRow,
  OpenPositionRow,
  PositionAction,
  PositionsOut,
  TradesFacets,
  TradesOut,
} from '../api/types'
import { useAppMode } from '../composables/useAppMode'
import { usePolling } from '../composables/usePolling'
import { price, signed, tone } from '../composables/useFormat'
import ClosedFilterBar from '../components/ClosedFilterBar.vue'
import ClosedTradesTable from '../components/ClosedTradesTable.vue'
import Modal from '../components/Modal.vue'
import ModeSwitchDialog from '../components/ModeSwitchDialog.vue'
import OpenPositionsTable from '../components/OpenPositionsTable.vue'
import StatePanel from '../components/StatePanel.vue'
import TopBar from '../components/TopBar.vue'
import TradeDetailModal from '../components/TradeDetailModal.vue'

type Tab = 'open' | 'closed'

const route = useRoute()
const router = useRouter()
const query = route.query
const str = (value: unknown) => (typeof value === 'string' ? value : '')
const num = (value: unknown, fallback: number) => (Number(value) > 0 ? Number(value) : fallback)

const { state: modeState, isShell } = useAppMode()

// 初值取自 URL：刷新应停在原选择（02 §1.2 的 query 约定）。
// 单实例化后不再有 `instance` 维度——旧链接带过来的 instance 参数会被 syncQuery 清掉。
const tab = ref<Tab>(query.tab === 'closed' ? 'closed' : 'open')
const exitReason = ref(str(query.exit_reason))
const pairFilter = ref(str(query.pair))
const from = ref(str(query.from))
const to = ref(str(query.to))
const limit = ref(num(query.limit, 100))
const offset = ref(num(query.offset, 0))
const positions = ref<PositionsOut | null>(null)
const trades = ref<TradesOut | null>(null)
const fetchError = ref<ErrorDetailSource>(null)
const openBusy = ref(false)
const closedBusy = ref(false)
const fetchedAt = ref(0)
const now = ref(Date.now())
const modeDialog = ref(false)

const EMPTY_FACETS: TradesFacets = { exit_reasons: [], pairs: [] }

const CLOSED_AVAIL: Record<string, string> = {
  db_not_found: '历史交易库不可用（不是没有交易）',
  db_unavailable: '历史交易库不可用（不是没有交易）',
  no_table: '历史库里还没有 trades 表，可能还没产生过交易',
  schema_mismatch: '历史库结构与预期不一致，部分字段显示为 —',
  timeout: '读取历史库超时（超过 3 秒）',
  not_ready: '当前未在交易模式：观察模式下不读取交易数据',
}

/** 模式未知（首帧 / `/app/info` 还没回来）时不能下"观察模式"的结论，否则会闪一下空态 */
const shellMode = computed(() => modeState.loaded && isShell.value)

const spinning = computed(() => openBusy.value || closedBusy.value)
const filterDirty = computed(() => !!(exitReason.value || pairFilter.value || from.value || to.value))
// 有行可看时照常渲染表格（缺列只是部分字段为 —），只有整库读不到才换错误面板
const closedReady = computed(
  () => trades.value?.available === 'ok' || trades.value?.available === 'schema_mismatch',
)
/** 观察模式：未平仓 / 已平仓各自用自己的枚举表达，文案不共用 */
const openNotReady = computed(() => positions.value?.availability[0]?.available === 'not_ready')
const closedNotReady = computed(() => trades.value?.available === 'not_ready')
/** 打满 2000 笔窗口：筛选只在窗口内生效，这个限制必须显示出来，不能藏 */
const windowTruncated = computed(() => trades.value?.reason === 'window_truncated')

const updatedText = computed(() => {
  if (tab.value === 'closed') {
    // 已平仓是历史查询，没有"实时"可言，显示查询时刻
    return fetchedAt.value ? t('查询于 {time}', { time: new Date(fetchedAt.value).toTimeString().slice(0, 5) }) : ''
  }
  if (!fetchedAt.value) return t('正在获取数据…')
  const seconds = Math.max(0, Math.floor((now.value - fetchedAt.value) / 1000))
  return seconds < 2 ? t('刚刚更新') : t('数据更新于 {n} 秒前', { n: seconds })
})

const emptyOpenText = computed(() =>
  positions.value?.totals.complete
    ? t('当前没有未平仓持仓')
    : t('没有取到未平仓持仓：持仓查询没返回，合计也就只是空值'),
)
const emptyClosedText = computed(() =>
  filterDirty.value ? t('没有符合条件的已平仓记录') : t('还没有已平仓交易'),
)

// 合计条四格：值、色、单位一起给，模板里就不必重复四遍同样的三元判断。
// 单实例化后第 4 格不再是「实例可用数」——只有 1 个实例，那一格永远显示 1/1，等于没说。
const stripCells = computed(() => {
  const totals = positions.value?.totals
  if (!totals) return []
  const cur = totals.equity_currency ?? ''
  return [
    { key: 'u', label: t('未实现'), tone: tone(totals.unrealized_abs), unit: cur, text: signed(totals.unrealized_abs) },
    { key: 'r', label: t('已实现'), tone: tone(totals.realized_abs), unit: cur, text: signed(totals.realized_abs) },
    {
      key: 'o',
      label: t('持仓'),
      tone: '',
      unit: totals.complete ? '' : t('· 不完整'),
      text: totals.open_trades === null ? '—' : t('{n} 笔', { n: totals.open_trades }),
    },
    { key: 'd', label: t('数据'), tone: '', unit: '', text: totals.complete ? t('完整') : t('不完整') },
  ]
})

function fail(e: unknown) {
  if (e instanceof UnauthorizedError) return void router.push('/login')
  // 保留上一次数据只做提示：轮询会继续重试，页面不白屏
  fetchError.value =
    e instanceof NetworkError
      ? t('无法连接交易接口，正在重试')
      : e instanceof ApiFailure
        ? e
        : (e as Error).message
}

async function fetchPositions() {
  if (shellMode.value) return
  openBusy.value = true
  try {
    positions.value = await api.positionsOpen()
    fetchError.value = null
    fetchedAt.value = Date.now()
  } catch (e) {
    fail(e)
  } finally {
    openBusy.value = false
  }
}

async function fetchTrades() {
  if (shellMode.value) return
  closedBusy.value = true
  try {
    trades.value = await api.trades({
      // 形参保留但对齐旧签名，适配层内部一律按单实例处理
      instance_id: MAIN_ID,
      exit_reason: exitReason.value || undefined,
      pair: pairFilter.value || undefined,
      from: from.value || undefined,
      to: to.value || undefined,
      limit: limit.value,
      offset: offset.value,
    })
    fetchError.value = null
    fetchedAt.value = Date.now()
  } catch (e) {
    fail(e)
  } finally {
    closedBusy.value = false
  }
}

async function refresh() {
  await (tab.value === 'open' ? fetchPositions() : fetchTrades())
}

function switchTab(next: Tab) {
  if (tab.value === next) return
  tab.value = next
  if (next === 'closed') offset.value = 0
  void (next === 'closed' ? fetchTrades() : fetchPositions())
}

// 任何过滤变化都回第一页：停在第 3 页看筛选结果为空是纯粹的自找困惑
function onFilterChange() {
  if (tab.value !== 'closed') return
  if (offset.value !== 0) {
    offset.value = 0 // offset 的 watcher 会去取数，这里不再发第二次
    return
  }
  void fetchTrades()
}

function resetFilters() {
  exitReason.value = ''
  pairFilter.value = ''
  from.value = ''
  to.value = ''
}

/** 已平仓复盘：直接带着 pair 去 K 线页（单实例，不再带 instance 维度） */
function reviewClosed(row: ClosedTradeRow) {
  void router.push({ path: '/chart', query: { pair: row.pair } })
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

// 逐笔详情
// 详情来自 bot 的交易接口（含订单级 fill 记录），与已平仓表的本地 SQLite 是两套数据源：
// 接口不可达时详情打不开，但表格照常可读 —— 所以详情失败只影响弹窗，不影响这一屏。
const detailOpen = ref(false)
const detailTradeId = ref<number | null>(null)

function openDetail(row: OpenPositionRow | ClosedTradeRow) {
  detailTradeId.value = row.trade_id
  detailOpen.value = true
}

function closeDetail() {
  detailOpen.value = false
  detailTradeId.value = null
}

// ------------------------------------------------------------------ 仓位操作
// 两个动作都会真的动仓位（市价平仓 / 撤单），因此固定两步：先选动作，再确认。
// 不做「点一下就执行」，也不把确认做成浏览器 confirm——它无法显示这笔仓位的摘要，
// 用户很可能在 10 笔持仓里点错行还不知道自己平了哪一笔。
const actionTarget = ref<OpenPositionRow | null>(null)
const actionPending = ref<PositionAction | null>(null)
const actionBusy = ref(false)
const actionError = ref<ErrorDetailSource>(null)

const ACTION_TEXT: Record<PositionAction, { title: string; body: string; confirm: string }> = {
  force_exit: {
    title: '强制平仓',
    body: '以市价立即平掉这笔持仓。成交价由盘口决定，可能与当前价有偏差，且不可撤销。',
    confirm: '确认强制平仓',
  },
  cancel_order: {
    title: '取消挂单',
    body: '撤销这笔交易尚未成交的挂单。注意：只撤单不平仓，持仓仍然存在。',
    confirm: '确认取消挂单',
  },
}

/** 摘要里的价格走 useFormat 的 price()：与两张明细表同一个档位（≥1 四位 / <1 六位） */

function openAction(row: OpenPositionRow) {
  actionTarget.value = row
  actionPending.value = null
  actionBusy.value = false
  actionError.value = null
}

function closeAction() {
  if (actionBusy.value) return // 请求在途时不允许关窗，否则结果无处显示
  actionTarget.value = null
  actionPending.value = null
  actionError.value = null
}

async function runAction(action: PositionAction) {
  const row = actionTarget.value
  if (!row || actionBusy.value) return
  actionBusy.value = true
  actionError.value = null
  try {
    const result = await api.positionAction(MAIN_ID, row.trade_id, action)
    if (!result.ok) {
      actionError.value = result.error ?? t('操作未成功')
      return
    }
    actionTarget.value = null
    actionPending.value = null
    // 立刻刷新一次：动作已下发，等 10s 轮询会让人以为没生效
    await fetchPositions()
  } catch (e) {
    if (e instanceof UnauthorizedError) return void router.push('/login')
    actionError.value = e instanceof ApiFailure ? e : t('操作失败')
  } finally {
    actionBusy.value = false
  }
}

function syncQuery() {
  // replace 而不是 push：刷新要停在原选择，但后退不该被 8 次下拉淹没
  const next: Record<string, string> = { tab: tab.value }
  if (tab.value !== 'closed') return void router.replace({ query: next })
  if (exitReason.value) next.exit_reason = exitReason.value
  if (pairFilter.value) next.pair = pairFilter.value
  if (from.value) next.from = from.value
  if (to.value) next.to = to.value
  if (limit.value !== 100) next.limit = String(limit.value)
  if (offset.value) next.offset = String(offset.value)
  void router.replace({ query: next })
}

watch([exitReason, pairFilter, from, to, limit], onFilterChange)
watch(offset, () => {
  if (tab.value === 'closed') void fetchTrades()
})
watch([tab, exitReason, pairFilter, from, to, limit, offset], syncQuery)
// 从观察模式切回交易模式：模式 store 轮询到新状态后立刻取一次，不必等下一轮 10s 轮询
watch(shellMode, (blocked) => {
  if (!blocked) void refresh()
})

// 未平仓是实时数据，轮询只在 open tab 且处于交易模式时有效；已平仓没有"更新"的概念
usePolling(() => (tab.value === 'open' && !shellMode.value ? fetchPositions() : undefined), 10_000)
usePolling(() => {
  now.value = Date.now()
}, 1_000)

onMounted(() => {
  // open tab 由 usePolling 挂载即跑；已平仓没有轮询，这里补第一次查询
  if (tab.value === 'closed') void fetchTrades()
})
</script>

<template>
  <div class="page">
    <TopBar :updated="updatedText" :busy="spinning" @refresh="refresh" />

    <main class="main">
      <div class="head">
        <h1>{{ t('持仓明细') }}</h1>
        <div class="tabs" role="tablist">
          <button class="tab" :class="{ active: tab === 'open' }" type="button" role="tab"
            :aria-selected="tab === 'open'" @click="switchTab('open')">
            {{ t('未平仓') }}<span v-if="positions" class="badge num">{{ positions.totals.open_trades ?? '—' }}</span>
          </button>
          <button class="tab" :class="{ active: tab === 'closed' }" type="button" role="tab"
            :aria-selected="tab === 'closed'" @click="switchTab('closed')">
            {{ t('已平仓') }}
          </button>
        </div>
      </div>

      <div v-if="fetchError" class="errorbar" role="alert">
        <span class="msg">{{ errorDetailText(fetchError) }}</span>
        <button class="btn btn-secondary btn-sm" type="button" @click="refresh">{{ t('重试') }}</button>
      </div>

      <!-- 未平仓：实时数据，合计原样搬自看板 -->
      <section v-if="tab === 'open'">
        <!-- 观察模式：整块换空态。不显示红色错误——端点没坏，是 bot 没在交易 -->
        <StatePanel v-if="shellMode || openNotReady" tone="info" :title="t('未在交易模式')">
          <p>{{ t('观察模式下进程不连接交易所，因此没有未平仓持仓。切到交易模式后这里才有数据。') }}</p>
          <button class="btn btn-primary btn-sm panel-act" type="button" @click="openModeDialog">{{ t('切换模式') }}</button>
        </StatePanel>

        <StatePanel v-else-if="!positions" tone="muted" :title="t('正在获取未平仓持仓…')" />

        <template v-else>
          <div class="strip card">
            <div v-for="cell in stripCells" :key="cell.key" class="cell">
              <span class="eyebrow">{{ cell.label }}</span>
              <div class="v num" :class="cell.tone">{{ cell.text }}<span class="unit">{{ cell.unit }}</span></div>
            </div>
          </div>

          <OpenPositionsTable class="table" :rows="positions.rows" :availability="positions.availability"
            :busy="openBusy" :empty-text="emptyOpenText" @action="openAction" @detail="openDetail" />
        </template>
      </section>

      <!-- 已平仓：本地窗口 + 本地过滤 + 本地分页（上游 /trades 没有筛选参数） -->
      <section v-else>
        <StatePanel v-if="shellMode || closedNotReady" tone="info" :title="t('未在交易模式')">
          <p>{{ t('观察模式下不读取交易数据——历史库里没有新增记录，读出来只会是旧快照。') }}</p>
          <button class="btn btn-primary btn-sm panel-act" type="button" @click="openModeDialog">{{ t('切换模式') }}</button>
        </StatePanel>

        <template v-else>
          <ClosedFilterBar v-if="closedReady" :exit-reason="exitReason" :pair="pairFilter" :from="from"
            :to="to" :limit="limit" :facets="trades?.facets ?? EMPTY_FACETS" :busy="closedBusy"
            @update:exit-reason="exitReason = $event" @update:pair="pairFilter = $event"
            @update:from="from = $event" @update:to="to = $event" @update:limit="limit = $event"
            @reset="resetFilters" />

          <!-- 窗口打满：筛选/分页只在最近 2000 笔内生效，这个限制不能藏起来 -->
          <StatePanel v-if="windowTruncated" class="table" variant="inline" tone="warn"
            :title="t('已加载最近 2000 笔，更早的记录未参与筛选')">
            {{ t('上游') }} <code>/trades</code> {{ t('只接受 limit/offset，没有筛选参数，所以这里只能拉回窗口自己切。') }}
            {{ t('更早的记录仍在库里，但上面的筛选与「共 N 条」都只覆盖这 2000 笔。') }}
          </StatePanel>

          <ClosedTradesTable v-if="trades && closedReady" :result="trades" :instance-name="trades.instance_name"
            :busy="closedBusy" :empty-text="emptyClosedText" @page="offset = $event" @review="reviewClosed"
            @detail="openDetail" />

          <StatePanel v-else-if="trades" tone="warn" :title="t(CLOSED_AVAIL[trades.available] ?? trades.available)"
            :action="t('重试')" @action="fetchTrades">
            <span :title="trades.reason ?? ''">{{ t(trades.reason ?? '没有更多细节') }}</span>
          </StatePanel>

          <StatePanel v-else tone="muted" :title="t('正在读取历史库…')" />

          <StatePanel v-if="trades && trades.schema_anomaly > 0" class="table" variant="inline" tone="warn"
            :title="t('有 {n} 笔记录的盈亏与 ROE 都取不到', { n: trades.schema_anomaly })">
            {{ t('这些行显示 — 而不是 0.00：0 会被读成"打平"，混进合计就是错账。') }}
          </StatePanel>
        </template>
      </section>
    </main>

    <!-- 仓位操作：先选动作 → 再确认；两次点击之间能看到这笔仓位的摘要 -->
    <Modal :open="!!actionTarget" @close="closeAction">
      <template v-if="actionTarget">
        <h2 class="modal-title">{{ t('仓位操作') }}</h2>
        <dl class="brief">
          <div><dt>pair</dt><dd>{{ actionTarget.pair }}</dd></div>
          <div><dt>{{ t('方向') }}</dt><dd>
            {{ actionTarget.side === 'long' ? t('做多') : t('做空') }}
            <span v-if="actionTarget.leverage !== null">· {{ actionTarget.leverage }}x</span>
          </dd></div>
          <div><dt>{{ t('开仓价') }}</dt><dd class="num">{{ price(actionTarget.open_rate) }}</dd></div>
          <div><dt>{{ t('当前价') }}</dt><dd class="num">{{ price(actionTarget.current_rate) }}</dd></div>
          <div><dt>{{ t('未实现') }}</dt><dd class="num" :class="tone(actionTarget.unrealized_abs)">
            {{ signed(actionTarget.unrealized_abs) }}<span class="unit">{{ actionTarget.stake_currency ?? '' }}</span>
          </dd></div>
          <div><dt>trade_id</dt><dd class="num">{{ actionTarget.trade_id }}</dd></div>
        </dl>

        <template v-if="!actionPending">
          <p class="hint">{{ t('选择要对这笔持仓执行的操作。两项都会立即下发到 bot，不可撤销。') }}</p>
          <div class="modal-actions">
            <button class="btn btn-secondary" type="button" @click="closeAction">{{ t('取消') }}</button>
            <button class="btn btn-danger" type="button" @click="actionPending = 'force_exit'">
              {{ t('强制平仓') }}
            </button>
            <button class="btn btn-secondary" type="button" :disabled="!actionTarget.has_open_order"
              :title="actionTarget.has_open_order ? '' : t('该笔交易当前没有未成交挂单')"
              @click="actionPending = 'cancel_order'">
              {{ t('取消挂单') }}
            </button>
          </div>
          <p v-if="!actionTarget.has_open_order" class="hint sub-hint">
            {{ t('这笔交易当前没有未成交挂单，所以「取消挂单」不可用。') }}
          </p>
        </template>

        <template v-else>
          <div class="confirm" :class="{ danger: actionPending === 'force_exit' }">
            <strong>{{ t(ACTION_TEXT[actionPending].title) }}</strong>
            <p>{{ t(ACTION_TEXT[actionPending].body) }}</p>
          </div>
          <p v-if="actionError" class="modal-err">{{ errorDetailText(actionError) }}</p>
          <div class="modal-actions">
            <button class="btn btn-secondary" type="button" :disabled="actionBusy"
              @click="actionPending = null; actionError = null">{{ t('返回') }}</button>
            <button class="btn" :class="actionPending === 'force_exit' ? 'btn-danger' : 'btn-primary'"
              type="button" :disabled="actionBusy" @click="runAction(actionPending)">
              {{ actionBusy ? t('执行中…') : t(ACTION_TEXT[actionPending].confirm) }}
            </button>
          </div>
        </template>
      </template>
    </Modal>

    <!-- 逐笔详情：订单级 fill、撤单原因、策略自定义数据；数据源是 bot 的交易接口 -->
    <TradeDetailModal :open="detailOpen" :instance-id="MAIN_ID" :trade-id="detailTradeId"
      @close="closeDetail" />

    <ModeSwitchDialog :open="modeDialog" @close="modeDialog = false" @go-ops="goOps" @go-config="goConfigure" />
  </div>
</template>

<style scoped>
.page { min-height: 100vh; padding-bottom: var(--space-2xl); }
.main { max-width: 1180px; margin: 0 auto; padding: 32px var(--space-lg) 0; }
.head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-md); margin-bottom: var(--space-lg); }
h1 { font-size: 26px; font-weight: 600; letter-spacing: -0.02em; }

.tabs {
  display: flex; gap: 2px; padding: 3px; border: 1px solid var(--border);
  border-radius: var(--radius-pill); background: var(--bg-secondary);
}
.tab {
  display: inline-flex; align-items: center; gap: 6px; padding: 7px 16px; border: none;
  border-radius: var(--radius-pill); background: transparent; font-size: 14px; font-weight: 500;
  color: var(--text-secondary); cursor: pointer;
  transition: background-color 0.2s var(--ease), color 0.2s var(--ease);
}
.tab.active { background: var(--card-solid); color: var(--text); box-shadow: var(--shadow-card); }
.tab .badge {
  padding: 0 6px; border-radius: var(--radius-pill); font-size: 11.5px;
  background: color-mix(in srgb, var(--text) 8%, transparent);
}

.strip {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--space-lg);
  margin-bottom: var(--space-md); padding: 20px 24px;
}
.strip .eyebrow { display: block; margin-bottom: 6px; }
.v { font-size: 22px; font-weight: 600; letter-spacing: -0.02em; }
.unit { margin-left: 4px; font-size: 13px; font-weight: 500; color: var(--text-tertiary); }

.table { margin-top: var(--space-sm); }
/* 空态面板里的动作按钮：块级面板居中对齐，别跟着右侧浮动 */
.panel-act { margin-top: var(--space-sm); }

.errorbar {
  display: flex; align-items: center; gap: 10px; margin-bottom: var(--space-lg);
  padding: 10px 10px 10px 14px; border-radius: 14px; font-size: 14px;
  border: 1px solid color-mix(in srgb, var(--down) 18%, transparent);
  background: color-mix(in srgb, var(--down) 6%, transparent);
}
.errorbar .msg { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---- 仓位操作弹窗（结构对齐通用 Modal，样式留在使用处）---- */
.modal-title {
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.brief {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 20px;
  margin: var(--space-md) 0 var(--space-lg);
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-inner);
  background: var(--bg-secondary);
  font-size: 13px;
}
.brief div { display: flex; justify-content: space-between; gap: 12px; min-width: 0; }
.brief dt { color: var(--text-tertiary); }
.brief dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-sm);
  margin-top: var(--space-lg);
}

.modal-err {
  margin-top: var(--space-md);
  padding: 9px 12px;
  border-radius: 10px;
  font-size: 13px;
  color: var(--down);
  background: color-mix(in srgb, var(--down) 8%, transparent);
}

.confirm {
  margin-top: var(--space-md);
  padding: 14px 16px;
  border-radius: var(--radius-inner);
  border: 1px solid var(--border);
  background: var(--bg-secondary);
  font-size: 13px;
}
/* 涨跌配色沿加密惯例：绿涨红跌 —— 平仓是结束持仓，用 --down（红）强调不可逆 */
.confirm.danger {
  border-color: color-mix(in srgb, var(--down) 26%, transparent);
  background: color-mix(in srgb, var(--down) 6%, transparent);
}
.confirm p { margin-top: 6px; color: var(--text-secondary); line-height: 1.6; }

.sub-hint { margin-top: var(--space-sm); font-size: 12.5px; }

@media (max-width: 900px) {
  .strip { grid-template-columns: repeat(2, 1fr); }
}

@media (max-width: 560px) {
  .main { padding: 24px var(--space-md) 0; }
}
</style>
