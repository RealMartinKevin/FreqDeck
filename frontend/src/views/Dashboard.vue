<script setup lang="ts">
/**
 * 看板：只回答一个问题——**这台 bot 现在在干什么**。
 *
 * 只有一个 bot 时的首页不该是"资产管理表格"，而是一张状态牌：
 * 现在什么模式 → 有没有报错 → 它是谁 → 多少钱 → 曲线怎么走 → 手上有什么仓。
 * 六块固定顺序，从上到下就是排查顺序；任何一块缺数据都显示 `—` 并说明原因，
 * 绝不显示 0（`0 笔` 与 `不知道几笔` 是两件事，混了就会得出反向结论）。
 *
 * 观察模式（`mode=shell`）下 `/status` `/profit` `/balance` `/daily` 全部返回
 * `not_ready`：此时所有数字一律 `—`，页面只留一句「观察模式不读取交易数据」
 * 和一个切换入口。**不出现任何 0 笔 / 0%**——那会被读成"这个 bot 什么都没做"，
 * 而事实是"这个模式本来就不看这些数据"。
 *
 * 旧版首页那一整套"多机注册表"界面（卡片 + 四个弹窗 + 五个写接口 + 8 个 ref）
 * 已整批删除：进程不由本系统管理，也没有"再加一台"这回事了。
 */

import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ApiFailure, NetworkError, UnauthorizedError, api, fetchConfig } from '../api/client'
import type { CurvePoint, InstanceOverview, OverviewOut, PositionOut } from '../api/types'
import { useAppMode } from '../composables/useAppMode'
import { usePolling } from '../composables/usePolling'
import { price, signed, tone } from '../composables/useFormat'
import BotStatusCard from '../components/BotStatusCard.vue'
import LastErrorBanner from '../components/LastErrorBanner.vue'
import ModeSwitchDialog from '../components/ModeSwitchDialog.vue'
import StatePanel from '../components/StatePanel.vue'
import SummaryStrip from '../components/SummaryStrip.vue'
import TopBar from '../components/TopBar.vue'

// 曲线组件带 echarts（约 350 KB）：异步加载，别让首屏为一个可能空着的图白等。
// 它零改动被复用（`curve` / `series` / `currency` 三个 props 就是为这里定的）。
const EquityCurveChart = defineAsyncComponent(() => import('../components/EquityCurveChart.vue'))

/** 预览只给前 5 行：看板上要判断「有没有风险敞口」，不需要看全表 */
const PREVIEW_ROWS = 5

const router = useRouter()
const { badge, state: mode, isShell, isTrade, isSwitching, onModeSettled } = useAppMode()

const overview = ref<OverviewOut | null>(null)
const fetchError = ref<string | null>(null)
const fetchedAt = ref(0)
const now = ref(Date.now())
const spinning = ref(false)
const switchOpen = ref(false)
/** 观察模式下交易所密钥是否为空；取不到就当作「不知道」，不出提示（不臆造结论） */
const keyMissing = ref(false)

/* ------------------------------------------------------------------ *
 * 取数
 * ------------------------------------------------------------------ */

/**
 * 一次快照。`signal` 来自 usePolling：页面卸载时 abort，回包不会再落到已卸载的组件上。
 *
 * 错误分三档处理：
 *   - `UnauthorizedError` → 回登录页（会话真没了）
 *   - `aborted` / `duringSwitch` → **静默**：这是我们自己取消的，或是重启窗口的必然结果
 *   - `network` → 顶部错误条 + 保留上一次数据（轮询会自己重试，页面不白屏）
 */
async function loadOverview(signal?: AbortSignal): Promise<void> {
  try {
    overview.value = await api.overview({ signal })
    fetchError.value = null
    fetchedAt.value = Date.now()
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      void router.push('/login')
      return
    }
    if (error instanceof ApiFailure && (error.kind === 'aborted' || error.duringSwitch)) return
    if (error instanceof NetworkError) {
      fetchError.value = '无法连接服务，请确认 freqtrade 进程在运行（正在重试）'
      return
    }
    fetchError.value = error instanceof Error ? error.message : '读取看板数据失败'
  }
}

async function refresh(): Promise<void> {
  spinning.value = true
  try {
    await loadOverview()
  } finally {
    window.setTimeout(() => {
      spinning.value = false
    }, 500)
  }
}

// usePolling 首次挂载即执行一次，不要再单独 onMounted，否则首屏会并发两次请求
usePolling((signal) => loadOverview(signal), 10_000)
/** 只驱动"数据更新于 X 秒前"的文案，不参与任何日期推导 */
usePolling(() => {
  now.value = Date.now()
}, 1_000)

const updatedText = computed(() => {
  if (!fetchedAt.value) return '正在获取数据…'
  const s = Math.max(0, Math.floor((now.value - fetchedAt.value) / 1000))
  return s < 2 ? '刚刚更新' : `数据更新于 ${s} 秒前`
})

/* ------------------------------------------------------------------ *
 * 派生
 * ------------------------------------------------------------------ */

/** 只有一个 bot：`instances` 恒为一项，但保持判空，避免上游契约收紧时整页崩 */
const inst = computed<InstanceOverview | null>(() => overview.value?.instances[0] ?? null)
const totals = computed(() => overview.value?.totals ?? null)
const currency = computed(() => inst.value?.stake_currency ?? null)

/**
 * 「观察模式不读取交易数据」的唯一判定。
 *
 * 两个来源都要认：模式 store（`/app/info`，10s 轮询）与本次快照的错误位
 * （`not_ready` 已经在聚合层被折进 `error.kind`）。只认其中一个会漏：
 * 刚切完模式时 store 可能还没刷新，而快照已经先一步给出 not_ready。
 */
const observeOnly = computed(
  () => isShell.value || inst.value?.error?.kind === 'not_ready',
)

const observeTitle = computed(() =>
  isShell.value ? '观察模式不读取交易数据' : '还没拿到交易数据',
)

const observeDetail = computed(() => {
  if (isShell.value) {
    return '观察模式只跑 API 与界面，不连交易所、不产生交易数据，所以下面的数字一律显示 —。切到交易模式后这里才会画出权益与持仓。'
  }
  if (isTrade.value && mode.tradingActive !== true) {
    return '进程已在交易模式，但还没开始交易（可能在加载策略或等交易所响应）。这段时间拿不到交易数据，稍后会自动刷新。'
  }
  return '后端返回「未就绪」，暂时读不到交易数据。稍后会自动重试；持续如此请到运维页看日志。'
})

/**
 * 两种情况要合成一条错误条，否则用户会看到两条红字说同一件事：
 *   1. `fetchError`：请求整体抛出来了（非 ApiFailure / 401 前置失败）
 *   2. `inst.error`：6 个端点**全部**失败时聚合层给的那一档
 *      （部分失败不走这里——那种失败由对应字段的 `null` 表达，页面显示 `—` 即可）
 *
 * `not_ready` 不算错误（观察模式的正常结果），已由 observeOnly 单独接管。
 */
const backendError = computed<string | null>(() => {
  const error = inst.value?.error
  if (!error || error.kind === 'not_ready') return null
  return error.detail || '读取交易数据失败'
})

const errorText = computed<string | null>(() => fetchError.value ?? backendError.value)

/** 模式条的说明文案：模式名由 store 统一判定（徽章、弹窗读的是同一个函数） */
const modeDetail = computed(() => {
  if (!mode.loaded) return '正在读取 bot 状态…'
  if (!mode.reachable) return '读不到 /app/info：进程可能正在重启或已退出。'
  if (isShell.value) return '只运行 API 与界面，不连接交易所，也不产生交易数据。'
  if (isTrade.value && mode.tradingActive !== true) return '已切到交易模式，正在等待开始交易。'
  if (mode.dryRun === false) return '实盘：真实资金在交易，每一次下单都会成交。'
  if (mode.dryRun === true) return '模拟盘（dry-run）：不涉及真实资金。'
  return '已切到交易模式。'
})

const switchCta = computed(() => (isTrade.value ? '返回观察模式' : '进入交易模式'))

/**
 * 密钥未填的轻量提示：只在观察模式下有意义。
 *
 * 观察模式本来就不连交易所，密钥空着不影响它跑；但用户下一步多半是"切到交易模式"，
 * 那时才会因为缺密钥回退。提前一句提示比让他失败一次再回来查要省事得多。
 * 不做三步引导卡（已定）：一句话 + 一个入口，够了。
 */
const showKeyHint = computed(
  () => isShell.value && keyMissing.value && mode.reachable && !isSwitching.value,
)

async function loadKeyState(): Promise<void> {
  if (!isShell.value) {
    keyMissing.value = false
    return
  }
  try {
    const out = await fetchConfig()
    const exchange = out.config['exchange']
    const raw =
      exchange && typeof exchange === 'object' ? (exchange as Record<string, unknown>)['key'] : undefined
    // 掩码 `***redacted***` 是非空字符串，会被正确判为「已配置」
    keyMissing.value = !(typeof raw === 'string' && raw.trim().length > 0)
  } catch {
    // 取不到配置就不提示：宁可不说，也不要凭猜测说「你没填密钥」
    keyMissing.value = false
  }
}

watch(isShell, () => void loadKeyState(), { immediate: true })

/**
 * 权益曲线点位：`日末权益 = 当日起始本金 + 当日盈亏`。
 *
 * 三条硬约束：
 *   1. `daily` 在 mappers 层已经**升序**（上游 `/daily` 是倒序）——这里绝不再 reverse/sort，
 *      二次排序会让"看起来对但其实翻过两次"的 bug 永久藏住。
 *   2. `starting_balance === null` → `value: null`（曲线断开）。**不补 0、不插值、不补前值**：
 *      补 0 会在图上画出一次断崖式暴跌，那是伪造的行情。
 *   3. 序列 id 用 `inst.id`（`'main'`），与 `series[].id` 一致，否则图例点空了没有线。
 */
const curve = computed<CurvePoint[]>(() => {
  const current = inst.value
  if (!current || !current.daily) return []
  return current.daily.map((point) => ({
    series_id: current.id,
    date: point.date,
    value: point.starting_balance === null ? null : point.starting_balance + point.abs_profit,
  }))
})

const series = computed<{ id: string; name: string; equity: number | null }[]>(() => {
  const current = inst.value
  if (!current) return []
  return [{ id: current.id, name: current.name, equity: current.equity_bot }]
})

/** 有点、且至少一个点有值才画：全是 null 的图只剩坐标轴，比空态更让人困惑 */
const hasCurve = computed(() => curve.value.some((point) => point.value !== null))

const curveEmptyText = computed(() => {
  if (observeOnly.value) return '观察模式不读取交易数据，切到交易模式后这里才会出现曲线。'
  if (inst.value?.daily === null) return '拿不到每日盈亏数据，曲线暂时画不出来。'
  return '近 30 天没有可用的数据点。'
})

/* ------------------------------------------------------------------ *
 * 持仓预览
 * ------------------------------------------------------------------ */

const previewRows = computed<PositionOut[]>(() => (inst.value?.open_positions ?? []).slice(0, PREVIEW_ROWS))
const openCount = computed<number | null>(() => inst.value?.open_trades ?? null)

const previewEmptyText = computed(() => {
  if (observeOnly.value) return '观察模式不读取持仓数据。'
  if (inst.value?.open_positions === null) return '拿不到持仓数据（显示 — ，不等于没有持仓）。'
  if (openCount.value === 0) return '当前没有未平仓持仓。'
  return '没有可展示的持仓行。'
})

/** ISO Z → `MM-DD HH:mm`：只裁显示，不做时区换算（与「今日 (UTC)」同口径） */
function stamp(iso: string): string {
  if (!iso) return '—'
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`
}

/* ------------------------------------------------------------------ *
 * 导航与切换
 * ------------------------------------------------------------------ */

function goConfig(): void {
  // 配置页属于后续批次：路由还没注册时退到运维页（那里有日志），不做成死按钮
  const resolved = router.resolve('/config')
  void router.push(resolved.matched.length > 0 ? '/config' : '/ops')
}

function goOps(): void {
  void router.push('/ops')
}

function openSwitch(): void {
  switchOpen.value = true
}

/**
 * 切换结束后主动补一次：进程重启期间轮询被跳过（见 usePolling），
 * 若等 10s 定时器，用户会对着上一次的空数据发呆十几秒。
 */
let unsubscribe: (() => void) | null = null
onMounted(() => {
  unsubscribe = onModeSettled((phase) => {
    if (phase === 'success' || phase === 'slow') void refresh()
  })
})

onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribe = null
})
</script>

<template>
  <div class="page">
    <TopBar :updated="updatedText" :busy="spinning" @refresh="refresh" />

    <main class="main">
      <!-- 1 模式条：一句话说清现在在干什么 + 唯一的模式入口（徽章在顶栏，这里不重复画） -->
      <section class="modebar card fade-up">
        <div class="modebar-main">
          <span class="eyebrow">当前模式</span>
          <p class="modebar-title">
            <i class="dot" :class="`t-${badge.tone}`" aria-hidden="true" />
            {{ badge.label }}
          </p>
          <p class="modebar-desc">{{ modeDetail }}</p>
        </div>
        <button class="btn btn-secondary" type="button" :disabled="isSwitching" @click="openSwitch">
          {{ switchCta }}
        </button>
      </section>

      <!-- 2 后端原文错误（仅 last_error 非空时出现；原文不改写不截断） -->
      <LastErrorBanner @retry="refresh" @go-config="goConfig" @go-ops="goOps" />

      <!-- 2.5 观察模式 + 密钥为空：轻量提示，不做引导卡 -->
      <div v-if="showKeyHint" class="notice">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3.5 2.8 19.5h18.4L12 3.5Z" />
          <path d="M12 9.5v4M12 16.6h.01" />
        </svg>
        <p class="notice-text">
          还没填交易所密钥。观察模式不受影响，但切到交易模式会因为缺密钥而回退。
        </p>
        <button class="btn btn-secondary btn-sm" type="button" @click="goConfig">去配置</button>
      </div>

      <StatePanel
        v-if="errorText"
        variant="inline"
        tone="error"
        :title="errorText"
        action="重试"
        @action="refresh"
      />

      <!-- 首屏骨架：只在「还没有任何数据 + 没有错误」时出现 -->
      <template v-if="!inst && !errorText">
        <div class="card sk-summary">
          <div v-for="i in 5" :key="i">
            <div class="skeleton" style="width: 56px; height: 11px" />
            <div class="skeleton" style="width: 100%; max-width: 112px; height: 26px; margin-top: 12px" />
          </div>
        </div>
        <div class="card sk-block">
          <div class="skeleton" style="width: 30%; height: 16px" />
          <div class="skeleton" style="width: 100%; height: 180px; margin-top: 18px" />
        </div>
      </template>

      <template v-else-if="inst">
        <!-- 3 Bot 状态卡：它是谁、连在哪、跑什么策略、前端有没有部署 -->
        <BotStatusCard :overview="inst" class="stack" />

        <!-- 观察模式 / 未就绪：一行原因，说清「下面的 — 不是零」 -->
        <StatePanel
          v-if="observeOnly"
          variant="inline"
          tone="info"
          :title="observeTitle"
          action="切换模式"
          @action="openSwitch"
        >
          {{ observeDetail }}
        </StatePanel>

        <!-- 4 汇总条 -->
        <SummaryStrip v-if="totals" :totals="totals" class="stack" />

        <!-- 5 权益曲线 -->
        <section class="block card stack">
          <header class="block-head">
            <h2>权益曲线</h2>
            <span class="block-sub">近 30 天 · 日末 bot 权益</span>
          </header>
          <EquityCurveChart
            v-if="hasCurve"
            :curve="curve"
            :series="series"
            :currency="currency"
            class="chart"
          />
          <p v-else class="block-empty">{{ curveEmptyText }}</p>
        </section>

        <!-- 6 持仓预览（前 5 行 + 查看全部） -->
        <section class="block card stack">
          <header class="block-head">
            <h2>持仓预览</h2>
            <span class="block-sub num">
              未平仓 {{ openCount ?? '—' }} 笔<template v-if="openCount !== null && openCount > PREVIEW_ROWS">
                · 仅显示前 {{ PREVIEW_ROWS }} 行</template
              >
            </span>
            <RouterLink class="block-link" to="/positions">查看全部</RouterLink>
          </header>

          <div v-if="previewRows.length" class="tbl-wrap">
            <table class="tbl">
              <thead>
                <tr>
                  <th scope="col">交易对</th>
                  <th scope="col" class="r">开仓价</th>
                  <th scope="col" class="r">当前价</th>
                  <th scope="col" class="r">浮动</th>
                  <th scope="col" class="r">开仓时间</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in previewRows" :key="row.trade_id">
                  <td>
                    <span class="pair">{{ row.pair }}</span>
                    <span class="side" :class="row.side === 'short' ? 's-short' : 's-long'">
                      {{ row.side === 'short' ? '空' : '多' }}
                    </span>
                    <span v-if="row.has_open_order" class="tag">有挂单</span>
                  </td>
                  <td class="r num">{{ price(row.open_rate) }}</td>
                  <td class="r num">{{ price(row.current_rate) }}</td>
                  <td class="r num" :class="tone(row.unrealized_pnl)">
                    {{ signed(row.unrealized_pnl) }}
                    <span class="cur">{{ currency ?? '' }}</span>
                  </td>
                  <td class="r num time" :title="row.open_time">{{ stamp(row.open_time) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="block-empty">{{ previewEmptyText }}</p>
        </section>
      </template>
    </main>

    <ModeSwitchDialog
      :open="switchOpen"
      @close="switchOpen = false"
      @go-ops="goOps"
      @go-config="goConfig"
    />
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  padding-bottom: var(--space-2xl);
}

.main {
  display: flex;
  flex-direction: column;
  gap: var(--space-lg);
  max-width: 1180px;
  margin: 0 auto;
  padding: 28px var(--space-lg) 0;
}

.stack {
  margin: 0;
}

/* ---------- 模式条 ---------- */
.modebar {
  display: flex;
  align-items: center;
  gap: var(--space-lg);
  padding: 16px 20px;
}

.modebar-main {
  min-width: 0;
}

.modebar-title {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 2px;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.015em;
}

.modebar-title .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 16%, transparent);
}

.t-muted {
  color: var(--text-tertiary);
}

.t-up {
  color: var(--up);
}

.t-down {
  color: var(--down);
}

.t-warn {
  color: var(--warn);
}

.modebar-desc {
  margin-top: 3px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.modebar .btn {
  flex: none;
  margin-left: auto;
}

/* ---------- 密钥提示 ---------- */
.notice {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px 10px 14px;
  border: 1px solid color-mix(in srgb, var(--warn) 22%, transparent);
  border-radius: var(--radius-inner);
  background: color-mix(in srgb, var(--warn) 7%, transparent);
}

.notice svg {
  flex: none;
  width: 17px;
  height: 17px;
  fill: none;
  stroke: var(--warn);
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.notice-text {
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
  line-height: 1.45;
  color: var(--text-secondary);
}

/* ---------- 区块 ---------- */
.block {
  padding: 20px 22px 22px;
}

.block-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: var(--space-md);
}

.block-head h2 {
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.015em;
}

.block-sub {
  font-size: 12.5px;
  color: var(--text-tertiary);
}

.block-link {
  margin-left: auto;
  font-size: 13px;
  font-weight: 500;
  color: var(--accent);
  text-decoration: none;
  white-space: nowrap;
}

.block-link:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}

.block-empty {
  padding: 34px var(--space-md);
  border-radius: var(--radius-inner);
  background: color-mix(in srgb, var(--text) 3%, transparent);
  font-size: 13.5px;
  line-height: 1.5;
  text-align: center;
  color: var(--text-tertiary);
}

/* 图高固定：echarts 在 0 高度容器里初始化会量到 0×0，之后 resize 也救不回来 */
.chart {
  display: block;
  height: 300px;
}

/* ---------- 预览表 ---------- */
.tbl-wrap {
  overflow-x: auto;
}

.tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 13.5px;
}

.tbl th {
  padding: 0 10px 8px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-tertiary);
  text-align: left;
  white-space: nowrap;
}

.tbl td {
  padding: 9px 10px;
  border-top: 1px solid var(--border);
  white-space: nowrap;
}

.tbl th:first-child,
.tbl td:first-child {
  padding-left: 0;
}

.tbl th:last-child,
.tbl td:last-child {
  padding-right: 0;
}

.tbl .r {
  text-align: right;
}

.pair {
  font-weight: 550;
}

.side {
  display: inline-block;
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 600;
  line-height: 17px;
}

.s-long {
  color: var(--up);
  background: color-mix(in srgb, var(--up) 12%, transparent);
}

.s-short {
  color: var(--down);
  background: color-mix(in srgb, var(--down) 12%, transparent);
}

.tag {
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 5px;
  font-size: 11px;
  line-height: 17px;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--text) 8%, transparent);
}

.cur {
  font-size: 11.5px;
  font-weight: 400;
  color: var(--text-tertiary);
}

.time {
  color: var(--text-secondary);
}

/* ---------- 骨架 ---------- */
.sk-summary {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: var(--space-lg);
  min-height: 132px;
  padding: 26px 28px;
}

.sk-block {
  padding: 22px 24px;
}

@media (max-width: 900px) {
  .sk-summary {
    grid-template-columns: repeat(2, 1fr);
  }

  .modebar {
    flex-wrap: wrap;
  }

  .modebar .btn {
    margin-left: 0;
  }
}

@media (max-width: 560px) {
  .main {
    padding: 22px var(--space-md) 0;
  }

  .block {
    padding: 18px 16px;
  }

  .chart {
    height: 240px;
  }
}
</style>
