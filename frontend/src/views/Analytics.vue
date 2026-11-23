<script setup lang="ts">
/**
 * 统计页：**9 个段各自独立**。
 *
 * 上游每个统计端点都会单独失败（观察模式下全是 `not_ready`），所以页面不能「一段挂了整页空」，
 * 也不能把「没取到」写成 0 / 0% —— 那会让人以为策略这期真的打成平手。
 * 每一段要么给数，要么给 `—` + 一句原因，两者之外的第三种呈现（0）是错的。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { MAIN_ID, NetworkError, UnauthorizedError, api } from '../api/client'
import type { AnalyticsOut, PairPerf, PeriodPoint, TagPerf } from '../api/types'
import { pct, signed, tone } from '../composables/useFormat'
import { usePolling } from '../composables/usePolling'
import TopBar from '../components/TopBar.vue'

const router = useRouter()

const days = ref(30)
const data = ref<AnalyticsOut | null>(null)
const loading = ref(false)
const pageError = ref<string | null>(null)
const fetchedAt = ref(0)
const now = ref(Date.now())

const WINDOWS = [
  { d: 7, label: '7 天' },
  { d: 30, label: '30 天' },
  { d: 90, label: '90 天' },
]

/** 段名 → 中文。键与适配层 `AnalyticsOut.errors{}` 的键逐一对应 */
const SEGMENT_LABELS: Record<string, string> = {
  profit: '总盈亏',
  stats: '出场统计',
  performance: '按币对',
  entries: '入场标签',
  exits: '出场标签',
  mix_tags: '标签组合',
  daily: '日盈亏',
  weekly: '周盈亏',
  monthly: '月盈亏',
}

const updatedText = computed(() => {
  if (!fetchedAt.value) return '正在获取…'
  const s = Math.max(0, Math.floor((now.value - fetchedAt.value) / 1000))
  return s < 2 ? '刚刚更新' : `数据更新于 ${s} 秒前`
})

// ------------------------------------------------------------------ 逐段状态
// 适配层的 errors 值是 `"<kind>: <detail>"`，kind 在前，所以用前缀判断 not_ready。
/** 段失败原文；null = 这一段没报错 */
function segError(key: string): string | null {
  return data.value?.errors?.[key] ?? null
}

/** 段说明：观察模式说「不读交易数据」，其它失败给原文，没失败但为空就直说为空 */
function segNote(key: string): string {
  const raw = segError(key)
  if (raw === null) return '这一段目前没有数据（不是加载失败）'
  if (raw.startsWith('not_ready')) return '观察模式不读取交易数据'
  return `未取到：${raw}`
}

/** true = 不是故障（观察模式 / 本段确实为空），用次要色；false = 真失败，用警示色 */
function segSoft(key: string): boolean {
  const raw = segError(key)
  return raw === null || raw.startsWith('not_ready')
}

// ------------------------------------------------------------------ 总盈亏
const all = computed(() => data.value?.profit_all?.all ?? null)
const currency = computed(() => data.value?.stake_currency ?? '')
/** 金额单位后缀：币种未知（观察模式取不到 /balance）时整个括号不出现，别留一个空 `（）` */
const unitSuffix = computed(() => (currency.value ? `（${currency.value}）` : ''))

/** 胜率优先用上游 winrate（百分数），没有就用胜/负笔数自算；两者都缺才是 null */
const winrate = computed<number | null>(() => {
  const a = all.value
  if (!a) return null
  if (typeof a.winrate === 'number') return a.winrate
  const w = a.winning_trades ?? null
  const l = a.losing_trades ?? null
  if (w === null || l === null || w + l === 0) return null
  return (w / (w + l)) * 100
})

const tradeCount = computed<number | null>(() => all.value?.closed_trade_count ?? null)

// ------------------------------------------------------------------ 金额口径
/**
 * 本页所有「盈亏」一律用 **USDT 绝对额**（`profit_abs`），不用 `profit`。
 *
 * 原因：`/performance` 的 `profit` 是**百分数**（-0.3 = -0.3%），而 `/entries` `/exits`
 * `/mix_tags` 干脆**没有** `profit` 字段（只有 `profit_abs`）。三个面板都叫「盈亏」，
 * 单位混着来用户没法横向比较，也读不出「这笔到底亏了多少钱」。
 *
 * 缺字段 → null（显示 —），绝不落到 `NaN`。
 */
function pnlOf(raw: number | undefined): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

/** 排序/条宽用：未知当 0（宽度为 0 的条虽然不显眼，但不会画成 NaN%） */
function pnlMag(raw: number | undefined): number {
  const v = pnlOf(raw)
  return v === null ? 0 : Math.abs(v)
}

// ------------------------------------------------------------------ 按币对
const pairRows = computed<PairPerf[]>(() => {
  const rows = data.value?.performance ?? []
  // 只取绝对盈亏最大的 12 个：单向排序会把另一端整段丢掉（最赚的排前面、最亏的沉到底），
  // 所以两端各取若干再按 pair 去重合并
  const key = (row: PairPerf) => pnlOf(row.profit_abs) ?? 0
  const top = [...rows].sort((a, b) => key(b) - key(a)).slice(0, 8)
  const bottom = [...rows].sort((a, b) => key(a) - key(b)).slice(0, 4)
  const seen = new Set<string>()
  const merged = [...top, ...bottom].filter((r) => (seen.has(r.pair) ? false : (seen.add(r.pair), true)))
  return merged.sort((a, b) => key(b) - key(a)).slice(0, 12)
})

const pairMax = computed(() => Math.max(1e-9, ...pairRows.value.map((r) => pnlMag(r.profit_abs))))

// ------------------------------------------------------------------ 出场原因
const exitRows = computed(() =>
  Object.entries(data.value?.stats?.exit_reasons ?? {})
    .map(([reason, st]) => ({
      reason,
      wins: st.wins ?? 0,
      losses: st.losses ?? 0,
      winrate: st.wins + st.losses > 0 ? ((st.wins ?? 0) / ((st.wins ?? 0) + (st.losses ?? 0))) * 100 : null,
    }))
    .sort((a, b) => b.wins + b.losses - (a.wins + a.losses)),
)

const maxTradesInExit = computed(() => Math.max(1, ...exitRows.value.map((r) => r.wins + r.losses)))

// ------------------------------------------------------------------ 标签三段
/** entries / exits / mix_tags 形状相同（`TagPerf[]`），只有用来标识的字段不同 */
const entryRows = computed<TagPerf[]>(() => data.value?.entries ?? [])
const exitTagRows = computed<TagPerf[]>(() => data.value?.exits ?? [])
const mixRows = computed<TagPerf[]>(() => data.value?.mix_tags ?? [])

function tagLabel(row: TagPerf): string {
  return row.mix_tag ?? row.enter_tag ?? row.exit_reason ?? '—'
}

function tagCount(row: TagPerf): string {
  return row.count === undefined ? '—' : String(row.count)
}

/** 每段的最大绝对值，用来给行内小条算宽度（0 会让宽度除零，故兜 1e-9） */
function tagMax(rows: TagPerf[]): number {
  return Math.max(1e-9, ...rows.map((r) => pnlMag(r.profit_abs)))
}

// ------------------------------------------------------------------ 周期
/** 近 12 根：周/月柱状图只画最近 12 个周期，更早的对当下判断没有帮助 */
function periods(key: 'weekly' | 'monthly'): PeriodPoint[] {
  const points = data.value?.[key]?.data ?? []
  return points.slice(-12)
}

const weeklyRows = computed(() => periods('weekly'))
const monthlyRows = computed(() => periods('monthly'))
const weeklyMax = computed(() => Math.max(1e-9, ...weeklyRows.value.map((p) => Math.abs(p.abs_profit))))
const monthlyMax = computed(() => Math.max(1e-9, ...monthlyRows.value.map((p) => Math.abs(p.abs_profit))))

/** 日盈亏：最近 14 天，倒序（最新在上）——「今天怎么样」是最常看的一眼 */
const dailyRows = computed(() => [...(data.value?.daily?.data ?? [])].slice(-14).reverse())

function barHeight(v: number, max: number): string {
  // 最小可见高度 2px：绝对值极小的柱子完全不可见会被误认为"没有这笔"
  return `${Math.max(2, (Math.abs(v) / max) * 100)}%`
}

function handle(e: unknown): string | null {
  if (e instanceof UnauthorizedError) {
    void router.push('/login')
    return null
  }
  return e instanceof NetworkError ? '无法连接交易接口' : (e as Error).message || '加载统计失败'
}

async function load() {
  loading.value = true
  try {
    // 单实例化：instanceId 形参保留在适配层签名里，这里固定 MAIN_ID
    data.value = await api.analytics(MAIN_ID, { days: days.value, weeks: 12, months: 12 })
    pageError.value = null
    fetchedAt.value = Date.now()
    now.value = Date.now()
  } catch (e) {
    const msg = handle(e)
    if (msg) pageError.value = msg
  } finally {
    loading.value = false
  }
}

function pickWindow(d: number) {
  if (days.value === d) return
  days.value = d
  void load()
}

usePolling(() => {
  now.value = Date.now()
}, 1_000)
onMounted(() => void load())
</script>

<template>
  <TopBar :updated="updatedText" :busy="loading" @refresh="load" />

  <main class="page">
    <section class="card head fade-up">
      <div class="title-block">
        <h1 class="page-title">统计</h1>
        <p class="muted small">
          数据全部来自 bot 的交易接口，逐段独立：某一段取不到只影响它自己。
        </p>
      </div>
      <div class="windows">
        <button
          v-for="w in WINDOWS"
          :key="w.d"
          class="chip"
          :class="{ on: days === w.d }"
          type="button"
          @click="pickWindow(w.d)"
        >
          {{ w.label }}
        </button>
      </div>
    </section>

    <p v-if="pageError" class="notice">{{ pageError }}</p>

    <!-- 段全挂且不是「观察模式」：给整页结论（观察模式不进这里，逐段显示 — 更有用） -->
    <div v-if="data && data.available !== 'ok' && data.available !== 'not_ready'" class="card empty-card">
      <p class="empty-title">取不到统计数据</p>
      <p class="muted">{{ data.reason ?? 'bot 当前不可达' }}</p>
      <p class="muted small">统计全部来自 bot 的交易接口，进程停止时只能看本地的已平仓明细。</p>
    </div>

    <template v-else>
      <!-- ① 总盈亏 -->
      <section class="card kpis fade-up">
        <template v-if="all">
          <div class="kpi">
            <span class="k">已实现盈亏</span>
            <div class="v num" :class="tone(all.profit_closed_coin ?? null)">
              {{ signed(all.profit_closed_coin ?? null) }}
              <span class="cur">{{ currency }}</span>
            </div>
            <span class="hint">累计已平仓</span>
          </div>
          <div class="kpi">
            <span class="k">胜率</span>
            <div class="v num">{{ winrate === null ? '—' : pct(winrate, 1, false) }}</div>
            <span class="hint">
              {{ all.winning_trades ?? '—' }} 胜 / {{ all.losing_trades ?? '—' }} 负
            </span>
          </div>
          <div class="kpi">
            <span class="k">已平仓笔数</span>
            <div class="v num">{{ tradeCount ?? '—' }}</div>
            <span class="hint">avg {{ all.avg_duration ?? '—' }}</span>
          </div>
          <div class="kpi">
            <span class="k">Profit factor</span>
            <div class="v num">{{ all.profit_factor != null ? all.profit_factor.toFixed(2) : '—' }}</div>
            <span class="hint">Sharpe {{ all.sharpe != null ? all.sharpe.toFixed(2) : '—' }}</span>
          </div>
          <div class="kpi">
            <span class="k">最大回撤</span>
            <div class="v num down">
              {{ all.max_drawdown != null ? pct(-Math.abs(all.max_drawdown) * 100, 2, false) : '—' }}
            </div>
            <span class="hint">历史峰值到谷底</span>
          </div>
        </template>
        <div v-else class="seg-empty">
          <span class="seg-dash num">—</span>
          <span class="seg-note" :class="{ warn: !segSoft('profit') }">
            {{ SEGMENT_LABELS.profit }}：{{ segNote('profit') }}
          </span>
        </div>
      </section>

      <section class="grid">
        <!-- ② 按币对 -->
        <div class="card panel">
          <h2 class="panel-title">按币对盈亏{{ unitSuffix }}</h2>
          <div v-if="pairRows.length" class="bars">
            <div v-for="r in pairRows" :key="r.pair" class="barrow">
              <span class="pair mono">{{ r.pair.replace('/USDT:USDT', '') }}</span>
              <div class="track">
                <i
                  class="fill"
                  :class="(pnlOf(r.profit_abs) ?? 0) >= 0 ? 'pos' : 'neg'"
                  :style="{ width: `${(pnlMag(r.profit_abs) / pairMax) * 100}%` }"
                />
              </div>
              <span class="amt num" :class="tone(pnlOf(r.profit_abs))">{{ signed(pnlOf(r.profit_abs)) }}</span>
            </div>
          </div>
          <p v-else class="seg-note" :class="{ warn: !segSoft('performance') }">{{ segNote('performance') }}</p>
        </div>

        <!-- ③ 出场原因 -->
        <div class="card panel">
          <h2 class="panel-title">出场原因</h2>
          <table v-if="exitRows.length" class="tbl">
            <thead>
              <tr>
                <th>原因</th>
                <th class="right">胜</th>
                <th class="right">负</th>
                <th class="right">胜率</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in exitRows" :key="r.reason">
                <td>
                  <span class="mono">{{ r.reason }}</span>
                  <div class="mini"><i :style="{ width: `${((r.wins + r.losses) / maxTradesInExit) * 100}%` }" /></div>
                </td>
                <td class="right num up">{{ r.wins }}</td>
                <td class="right num down">{{ r.losses }}</td>
                <td class="right num">{{ r.winrate === null ? '—' : pct(r.winrate, 0, false) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="seg-note" :class="{ warn: !segSoft('stats') }">{{ segNote('stats') }}</p>
        </div>
      </section>

      <!-- ④⑤⑥ 标签三段：入场 / 出场 / 组合 -->
      <section class="grid three">
        <div class="card panel">
          <h2 class="panel-title">入场标签</h2>
          <table v-if="entryRows.length" class="tbl">
            <thead>
              <tr><th>标签</th><th class="right">笔数</th><th class="right">盈亏{{ unitSuffix }}</th></tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in entryRows" :key="`e-${i}`">
                <td class="mono ellip" :title="tagLabel(r)">{{ tagLabel(r) }}</td>
                <td class="right num">{{ tagCount(r) }}</td>
                <td class="right num" :class="tone(pnlOf(r.profit_abs))">{{ signed(pnlOf(r.profit_abs)) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="seg-note" :class="{ warn: !segSoft('entries') }">{{ segNote('entries') }}</p>
        </div>

        <div class="card panel">
          <h2 class="panel-title">出场标签</h2>
          <table v-if="exitTagRows.length" class="tbl">
            <thead>
              <tr><th>标签</th><th class="right">笔数</th><th class="right">盈亏{{ unitSuffix }}</th></tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in exitTagRows" :key="`x-${i}`">
                <td class="mono ellip" :title="tagLabel(r)">{{ tagLabel(r) }}</td>
                <td class="right num">{{ tagCount(r) }}</td>
                <td class="right num" :class="tone(pnlOf(r.profit_abs))">{{ signed(pnlOf(r.profit_abs)) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="seg-note" :class="{ warn: !segSoft('exits') }">{{ segNote('exits') }}</p>
        </div>

        <div class="card panel">
          <h2 class="panel-title">标签组合{{ unitSuffix }}</h2>
          <div v-if="mixRows.length" class="bars">
            <div v-for="(r, i) in mixRows.slice(0, 10)" :key="`m-${i}`" class="barrow narrow">
              <span class="pair mono" :title="tagLabel(r)">{{ tagLabel(r) }}</span>
              <div class="track">
                <i
                  class="fill"
                  :class="(pnlOf(r.profit_abs) ?? 0) >= 0 ? 'pos' : 'neg'"
                  :style="{ width: `${(pnlMag(r.profit_abs) / tagMax(mixRows)) * 100}%` }"
                />
              </div>
              <span class="amt num" :class="tone(pnlOf(r.profit_abs))">{{ signed(pnlOf(r.profit_abs)) }}</span>
            </div>
          </div>
          <p v-else class="seg-note" :class="{ warn: !segSoft('mix_tags') }">{{ segNote('mix_tags') }}</p>
        </div>
      </section>

      <!-- ⑦ 日盈亏 -->
      <section class="card panel fade-up">
        <h2 class="panel-title">日盈亏（最近 14 天）</h2>
        <table v-if="dailyRows.length" class="tbl">
          <thead>
            <tr><th>日期 (UTC)</th><th class="right">笔数</th><th class="right">盈亏{{ unitSuffix }}</th></tr>
          </thead>
          <tbody>
            <tr v-for="d in dailyRows" :key="d.date">
              <td class="mono">{{ d.date }}</td>
              <td class="right num">{{ d.trade_count }}</td>
              <td class="right num" :class="tone(d.abs_profit)">{{ signed(d.abs_profit) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="seg-note" :class="{ warn: !segSoft('daily') }">{{ segNote('daily') }}</p>
      </section>

      <!-- ⑧⑨ 周 / 月 -->
      <section class="card panel fade-up">
        <h2 class="panel-title">周期盈亏</h2>
        <div class="periods">
          <div class="period">
            <span class="muted small">按周（近 12 周）</span>
            <div v-if="weeklyRows.length" class="cols">
              <div v-for="p in weeklyRows" :key="`w-${p.date}`" class="col" :title="`${p.date}  ${signed(p.abs_profit)} (${p.trade_count} 笔)`">
                <div class="colplot">
                  <i class="upbar" :style="{ height: p.abs_profit >= 0 ? barHeight(p.abs_profit, weeklyMax) : '0' }" />
                  <i class="downbar" :style="{ height: p.abs_profit < 0 ? barHeight(p.abs_profit, weeklyMax) : '0' }" />
                </div>
                <span class="collabel">{{ p.date.slice(5) }}</span>
              </div>
            </div>
            <p v-else class="seg-note" :class="{ warn: !segSoft('weekly') }">{{ segNote('weekly') }}</p>
          </div>

          <div class="period">
            <span class="muted small">按月（近 12 月）</span>
            <div v-if="monthlyRows.length" class="cols">
              <div v-for="p in monthlyRows" :key="`m-${p.date}`" class="col" :title="`${p.date}  ${signed(p.abs_profit)} (${p.trade_count} 笔)`">
                <div class="colplot">
                  <i class="upbar" :style="{ height: p.abs_profit >= 0 ? barHeight(p.abs_profit, monthlyMax) : '0' }" />
                  <i class="downbar" :style="{ height: p.abs_profit < 0 ? barHeight(p.abs_profit, monthlyMax) : '0' }" />
                </div>
                <span class="collabel">{{ p.date.slice(0, 7) }}</span>
              </div>
            </div>
            <p v-else class="seg-note" :class="{ warn: !segSoft('monthly') }">{{ segNote('monthly') }}</p>
          </div>
        </div>
        <p class="muted small note">
          柱子只表示幅度，正负分列在零轴上下；悬停可看具体金额与笔数。
        </p>
      </section>
    </template>
  </main>
</template>

<style scoped>
.page {
  max-width: 1180px;
  margin: 0 auto;
  padding: var(--space-lg) var(--space-lg) var(--space-2xl);
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
  flex-wrap: wrap;
  padding: 14px 18px;
}

.title-block {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.page-title {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.windows {
  display: flex;
  gap: 4px;
}

.chip {
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}

.chip:hover {
  background: color-mix(in srgb, var(--text) 6%, transparent);
}

.chip.on {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border-color: color-mix(in srgb, var(--accent) 30%, transparent);
  color: var(--accent);
}

.kpis {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: var(--space-lg);
  padding: 22px 24px;
}

.kpi {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.k {
  font-size: 12.5px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.v {
  font-size: 26px;
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: -0.02em;
}

.cur {
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0;
  color: var(--text-tertiary);
}

.hint {
  font-size: 12px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 段不可用：一个大破折号 + 一句原因。绝不用 0 顶替 */
.seg-empty {
  display: flex;
  grid-column: 1 / -1;
  align-items: center;
  gap: var(--space-md);
}

.seg-dash {
  font-size: 26px;
  font-weight: 600;
  color: var(--text-tertiary);
}

.seg-note {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-tertiary);
}

/* 真失败（不是观察模式）才用警示色：观察模式整页是正常状态，不该闪黄 */
.seg-note.warn {
  color: var(--warn);
}

.grid {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
  gap: var(--space-md);
  align-items: start;
}

.grid.three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.panel {
  padding: 18px 20px 20px;
}

.panel-title {
  margin-bottom: var(--space-md);
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.bars {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.barrow {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr) 92px;
  align-items: center;
  gap: var(--space-sm);
}

.barrow.narrow {
  grid-template-columns: 72px minmax(0, 1fr) 78px;
}

.pair {
  font-size: 12.5px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.track {
  height: 8px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--text) 6%, transparent);
  overflow: hidden;
}

.fill {
  display: block;
  height: 100%;
  border-radius: 4px;
  transition: width 0.4s var(--ease);
}

.fill.pos {
  background: var(--up);
}

.fill.neg {
  background: var(--down);
}

.amt {
  font-size: 12.5px;
  text-align: right;
}

.tbl {
  width: 100%;
  border-collapse: collapse;
}

.tbl th {
  padding: 6px 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-tertiary);
  text-align: left;
  border-bottom: 1px solid var(--border);
}

.tbl td {
  padding: 8px 6px;
  font-size: 13px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}

.tbl tr:last-child td {
  border-bottom: none;
}

.ellip {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.right {
  text-align: right;
}

.mini {
  margin-top: 4px;
  height: 3px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--text) 6%, transparent);
  overflow: hidden;
}

.mini i {
  display: block;
  height: 100%;
  background: color-mix(in srgb, var(--accent) 55%, transparent);
}

.periods {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-xl);
}

.period {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  min-width: 0;
}

.cols {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  height: 132px;
  padding-top: 6px;
}

.col {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.colplot {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  width: 100%;
  height: 108px;
}

.upbar,
.downbar {
  display: block;
  width: 100%;
  border-radius: 3px;
}

.upbar {
  background: var(--up);
}

.downbar {
  background: var(--down);
}

.collabel {
  font-size: 10.5px;
  color: var(--text-tertiary);
  white-space: nowrap;
  transform: scale(0.92);
}

.note {
  margin-top: var(--space-sm);
}

.notice {
  padding: 10px 14px;
  border-radius: var(--radius-inner);
  background: color-mix(in srgb, var(--warn) 10%, transparent);
  color: var(--warn);
  font-size: 13px;
}

.empty-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--space-xl);
  text-align: center;
}

.empty-title {
  font-size: 15px;
  font-weight: 500;
}

.small {
  font-size: 12.5px;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

@media (max-width: 1080px) {
  .kpis {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-md) var(--space-lg);
  }

  .grid,
  .grid.three {
    grid-template-columns: 1fr;
  }

  .periods {
    grid-template-columns: 1fr;
    gap: var(--space-lg);
  }
}

@media (max-width: 640px) {
  .page {
    padding: var(--space-md) var(--space-md) var(--space-2xl);
  }

  .kpis {
    grid-template-columns: 1fr 1fr;
    padding: 16px;
  }

  .v {
    font-size: 22px;
  }

  .barrow {
    grid-template-columns: 76px minmax(0, 1fr) 78px;
  }
}
</style>
