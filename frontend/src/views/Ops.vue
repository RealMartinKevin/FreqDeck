<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { MAIN_ID, NetworkError, UnauthorizedError, api, errorDetailText } from '../api/client'
import { ApiFailure } from '../api/client'
import type { ErrorDetailSource } from '../api/client'
import type { LogLine, LogsOut, PairlistOut, ShowConfigOut, StrategyOut, SysinfoOut } from '../api/types'
import { usePolling } from '../composables/usePolling'
import TopBar from '../components/TopBar.vue'
import { t } from '../i18n'

type Tab = 'logs' | 'system' | 'strategy' | 'pairlist'
/** 级别筛选是**阈值**语义（INFO+ = INFO 及以上），不是等值匹配 */
type Level = 'ALL' | 'INFO' | 'WARNING' | 'ERROR'

const router = useRouter()

const tab = ref<Tab>('logs')

const logs = ref<LogsOut | null>(null)
const sysinfo = ref<SysinfoOut | null>(null)
const config = ref<ShowConfigOut | null>(null)
const strategy = ref<StrategyOut | null>(null)
const pairlist = ref<PairlistOut | null>(null)

// v-if="pairlist" 会把 v-else 分支里的 pairlist 窄化成 null，
// 模板里再读 pairlist.reason 会被 TS 判成 never；走 computed 绕开这个窄化。
// 带上 status 供 errorDetailText 把 {n} 换成真实 HTTP 码。
const pairlistReason = computed<ErrorDetailSource>(() =>
  !pairlist.value || pairlist.value.reason === null
    ? null
    : { detail: pairlist.value.reason, status: pairlist.value.status },
)

const pageError = ref<ErrorDetailSource>(null)
const busy = ref(false)
const fetchedAt = ref(0)
const now = ref(Date.now())

const level = ref<Level>('ALL')
const followTail = ref(true)
const autoRefresh = ref(true)
const logBox = ref<HTMLElement | null>(null)

const LEVELS: { key: Level; label: string }[] = [
  { key: 'ALL', label: '全部' },
  { key: 'INFO', label: 'INFO+' },
  { key: 'WARNING', label: 'WARN+' },
  { key: 'ERROR', label: 'ERROR' },
]

/** 阈值：选中的级别是下限，达到或更严重都显示 */
const LEVEL_FLOOR: Record<Level, number> = { ALL: 0, INFO: 20, WARNING: 30, ERROR: 40 }
/** 上游级别名 → 严重度。未知级别按 INFO 处理（既不放大也不吞掉） */
const LEVEL_SEVERITY: Record<string, number> = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  WARN: 30,
  ERROR: 40,
  CRITICAL: 50,
}

function severityOf(raw: string): number {
  return LEVEL_SEVERITY[raw.toUpperCase()] ?? 20
}

/**
 * 级别筛选**在前端做**：上游 `/logs` 只接受 `limit`，没有 level 参数
 * （`obs.ts` 的同名参数是等值匹配，给不了「INFO+ 含 WARN/ERROR」的阈值语义）。
 * 因此这里拉全量再筛，切级别不发请求，也不会因为换了级别把缓冲区的行弄丢。
 */
const visibleLines = computed<LogLine[]>(() => {
  const lines = logs.value?.lines ?? []
  const floor = LEVEL_FLOOR[level.value]
  return floor === 0 ? lines : lines.filter((line) => severityOf(line.level) >= floor)
})

/** 被筛掉的行数：显示在计数里，让「筛完只剩 3 行」有解释 */
const filteredOut = computed(() => Math.max(0, (logs.value?.lines.length ?? 0) - visibleLines.value.length))

// 模板里不能写 TS 类型断言，tab 定义放这里
const TABS: { k: Tab; l: string }[] = [
  { k: 'logs', l: '日志' },
  { k: 'system', l: '系统' },
  { k: 'strategy', l: '策略' },
  { k: 'pairlist', l: '选币' },
]

const updatedText = computed(() => {
  if (!fetchedAt.value) return t('正在获取…')
  const s = Math.max(0, Math.floor((now.value - fetchedAt.value) / 1000))
  return s < 2 ? t('刚刚更新') : t('数据更新于 {n} 秒前', { n: s })
})

function handle(e: unknown, fallback: string): ErrorDetailSource {
  if (e instanceof UnauthorizedError) {
    void router.push('/login')
    return null
  }
  if (e instanceof NetworkError) return t('无法连接交易接口')
  if (e instanceof ApiFailure) return e
  return (e as Error).message || fallback
}

/**
 * 日志轮询只在本 tab 激活时跑：运维页默认停在日志，切走就别再打上游。
 * 不带 level：级别筛选在本地做（见 visibleLines）。
 */
async function loadLogs() {
  if (tab.value !== 'logs') return
  try {
    logs.value = await api.logs(MAIN_ID, { limit: 400 })
    pageError.value = null
    fetchedAt.value = Date.now()
  } catch (e) {
    const msg = handle(e, t('加载日志失败'))
    if (msg) pageError.value = msg
  }
}

async function loadTab() {
  if (tab.value === 'logs') return loadLogs()
  busy.value = true
  pageError.value = null
  try {
    if (tab.value === 'system') {
      // 配置与系统信息一起取：系统页要显示版本/运行模式，单靠 sysinfo 不够
      const [info, cfg] = await Promise.all([api.sysinfo(MAIN_ID), api.instanceConfig(MAIN_ID)])
      sysinfo.value = info
      config.value = cfg
    } else if (tab.value === 'pairlist') {
      pairlist.value = await api.pairlist(MAIN_ID)
    } else {
      // 策略名由适配层自己解析（/app/info → /show_config 回退），页面不必再传
      strategy.value = await api.strategyInfo(MAIN_ID)
    }
    fetchedAt.value = Date.now()
  } catch (e) {
    const msg = handle(e, t('加载失败'))
    if (msg) pageError.value = msg
  } finally {
    busy.value = false
  }
}

async function refresh() {
  busy.value = true
  await loadTab()
  window.setTimeout(() => (busy.value = false), 400)
}

// 日志自动刷新：3s。用 ref 而不是重建轮询，暂停时只是跳过这一轮（不发请求）
usePolling(async () => {
  now.value = Date.now()
  if (!autoRefresh.value || tab.value !== 'logs') return
  await loadLogs()
}, 3000)

/** 只在用户本来就停在底部时才自动跟随，否则会把人从他正在看的那一行拽走 */
async function stickToBottom() {
  if (!followTail.value) return
  await nextTick()
  const el = logBox.value
  if (el) el.scrollTop = el.scrollHeight
}

watch(() => visibleLines.value.length, stickToBottom)

function onScroll() {
  const el = logBox.value
  if (!el) return
  // 距底部 24px 内算「在看最新」，往上翻即停止跟随
  followTail.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24
}

function levelClass(lv: string): string {
  const v = lv.toUpperCase()
  if (v === 'ERROR' || v === 'CRITICAL') return 'lv-error'
  if (v === 'WARNING') return 'lv-warn'
  if (v === 'DEBUG') return 'lv-debug'
  return 'lv-info'
}

/** 时间列只留时分秒：日期在同一次会话里几乎不变，省下的宽度给正文 */
function shortTime(ts: string): string {
  const m = ts.match(/(\d{2}:\d{2}:\d{2}(?:,\d+)?)/)
  return m ? m[1] : ts
}

const CONFIG_GROUPS: { title: string; keys: string[] }[] = [
  {
    title: '运行',
    keys: ['version', 'runmode', 'state', 'strategy', 'strategy_version', 'timeframe', 'dry_run', 'trading_mode', 'margin_mode'],
  },
  {
    title: '资金与风险',
    keys: ['stake_currency', 'stake_amount', 'available_capital', 'max_open_trades', 'stoploss', 'trailing_stop', 'trailing_stop_positive', 'trailing_stop_positive_offset', 'trailing_only_offset_is_reached'],
  },
  {
    title: '订单',
    keys: ['order_types', 'unfilledtimeout', 'entry_pricing', 'exit_pricing', 'stoploss_on_exchange', 'force_entry_enable', 'position_adjustment_enable', 'max_entry_position_adjustment'],
  },
  { title: '交易所', keys: ['exchange', 'demo_trading', 'short_allowed', 'proxy_coin'] },
]

function configGroups(cfg: Record<string, unknown> | null) {
  if (!cfg) return []
  return CONFIG_GROUPS.map((g) => ({
    title: g.title,
    rows: g.keys.filter((k) => k in cfg).map((k) => ({ key: k, value: cfg[k] })),
  })).filter((g) => g.rows.length)
}

/** 对象/数组按 JSON 展开，标量原样；布尔值显示为「是/否」比 true/false 更好扫读 */
function display(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? t('是') : t('否')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function pct(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—'
  return `${v.toFixed(1)}%`
}

/** 负载是小数，两位足够；null/undefined 一律 —，不写成 0.00 */
function fmt2(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : v.toFixed(2)
}

/** 锁定到期时间：只到分钟，时间和日期都保留（跨日锁看不出来会误判已释放） */
function shortTs(ts: string | undefined): string {
  if (!ts) return '—'
  const iso = ts.includes('T') ? ts : ts.replace(' ', 'T')
  const d = new Date(iso.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`)
  if (Number.isNaN(d.getTime())) return ts
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

// 单实例化：没有实例维度可切换，进页面直接取当前 tab 的数据
onMounted(() => void loadTab())

watch(tab, () => void loadTab())
</script>

<template>
  <TopBar :updated="updatedText" :busy="busy" @refresh="refresh" />

  <main class="page">
    <section class="card head fade-up">
      <div class="title-block">
        <h1 class="page-title">{{ t('运维') }}</h1>
        <p class="muted small">
          {{ t('日志 / 系统 / 策略 / 选币都不依赖交易模式，观察模式下照样能看——排查启动失败先看这里。') }}
        </p>
      </div>

      <nav class="tabs" :aria-label="t('运维视图')">
        <button
          v-for="tabDef in TABS"
          :key="tabDef.k"
          class="tab"
          :class="{ on: tab === tabDef.k }"
          type="button"
          @click="tab = tabDef.k"
        >
          {{ t(tabDef.l) }}
        </button>
      </nav>
    </section>

    <p v-if="pageError" class="notice">{{ errorDetailText(pageError) }}</p>

    <!-- 日志 -->
    <section v-show="tab === 'logs'" class="card panel fade-up">
      <header class="panel-head">
        <div class="filters">
          <button
            v-for="l in LEVELS"
            :key="l.key"
            class="chip"
            :class="{ on: level === l.key }"
            type="button"
            @click="level = l.key"
          >
            {{ t(l.label) }}
          </button>
        </div>
        <div class="meta">
          <span v-if="logs?.available === 'ok'" class="muted small num">
            {{ t('已显示 {n} / 共 {total} 行', { n: visibleLines.length, total: logs.total }) }}<template v-if="filteredOut > 0">{{ t('（级别筛掉 {n} 行）', { n: filteredOut }) }}</template>
          </span>
          <label class="toggle">
            <input v-model="autoRefresh" type="checkbox" />
            <span>{{ t('自动刷新') }}</span>
          </label>
          <label class="toggle">
            <input v-model="followTail" type="checkbox" @change="stickToBottom" />
            <span>{{ t('跟随最新') }}</span>
          </label>
        </div>
      </header>

      <div v-if="logs && logs.available !== 'ok'" class="empty">
        <p class="empty-title">{{ t('取不到日志') }}</p>
        <p class="muted">{{ logs.reason === null ? t('bot 当前不可达') : errorDetailText({ detail: logs.reason, status: logs.status }) }}</p>
        <p v-if="logs.available === 'unsupported'" class="muted small">
          {{ t('该 bot 的 Freqtrade 版本可能没有日志端点，可以直接看 logfile。') }}
        </p>
      </div>

      <div v-else-if="logs && visibleLines.length === 0" class="empty">
        <p class="empty-title">{{ t('没有匹配的日志') }}</p>
        <p class="muted">
          {{ logs.lines.length === 0 ? t('上游缓冲区暂时没有日志行。') : t('当前级别筛选下没有记录，试试放宽级别。') }}
        </p>
      </div>

      <div v-else ref="logBox" class="logbox" @scroll="onScroll">
        <div v-for="(line, idx) in visibleLines" :key="idx" class="logline" :class="levelClass(line.level)">
          <span class="ts num">{{ shortTime(line.ts_text) }}</span>
          <span class="lv">{{ line.level }}</span>
          <span class="msg">{{ line.message }}</span>
        </div>
      </div>
    </section>

    <!-- 系统 -->
    <section v-show="tab === 'system'" class="grid fade-up">
      <div class="card panel">
        <h2 class="panel-title">{{ t('资源') }}</h2>
        <template v-if="sysinfo && sysinfo.available === 'ok' && sysinfo.sysinfo">
          <div class="gauges">
            <div class="gauge">
              <span class="muted small">{{ t('CPU · {n} 核', { n: sysinfo.sysinfo.cpu_count ?? '—' }) }}</span>
              <strong class="num">{{ pct(sysinfo.sysinfo.cpu_avg) }}</strong>
              <div class="bar"><i :style="{ width: `${Math.min(100, sysinfo.sysinfo.cpu_avg ?? 0)}%` }" /></div>
            </div>
            <div class="gauge">
              <span class="muted small">{{ t('内存') }}</span>
              <strong class="num">{{ pct(sysinfo.sysinfo.ram_pct) }}</strong>
              <div class="bar"><i :style="{ width: `${Math.min(100, sysinfo.sysinfo.ram_pct ?? 0)}%` }" /></div>
            </div>
          </div>

          <div v-if="sysinfo.sysinfo.cpu_load_avg" class="load">
            <div class="loadrow">
              <span class="muted small">{{ t('系统负载') }}</span>
              <span class="num">
                1m {{ fmt2(sysinfo.sysinfo.cpu_load_avg['1m']) }}
                · 5m {{ fmt2(sysinfo.sysinfo.cpu_load_avg['5m']) }}
                · 15m {{ fmt2(sysinfo.sysinfo.cpu_load_avg['15m']) }}
              </span>
            </div>
            <p class="muted small">
              {{ t('负载是「运行中 + 等待中」的进程数，除以核数才是相对压力；单看绝对值没意义。') }}
            </p>
          </div>
        </template>
        <div v-else class="empty">
          <p class="empty-title">{{ t('取不到系统信息') }}</p>
          <p class="muted">{{ !sysinfo || sysinfo.reason === null ? t('bot 当前不可达') : errorDetailText({ detail: sysinfo.reason, status: sysinfo.status }) }}</p>
        </div>
      </div>

      <div class="card panel">
        <h2 class="panel-title">{{ t('运行配置') }}</h2>
        <template v-if="config && config.available === 'ok' && config.config">
          <div v-for="g in configGroups(config.config)" :key="g.title" class="group">
            <h3 class="group-title">{{ t(g.title) }}</h3>
            <div v-for="row in g.rows" :key="row.key" class="kvrow">
              <span class="k mono">{{ row.key }}</span>
              <span class="v num">{{ display(row.value) }}</span>
            </div>
          </div>
        </template>
        <div v-else class="empty">
          <p class="empty-title">{{ t('取不到配置') }}</p>
          <p class="muted">{{ !config || config.reason === null ? t('bot 当前不可达') : errorDetailText({ detail: config.reason, status: config.status }) }}</p>
        </div>
      </div>
    </section>

    <!-- 策略 -->
    <section v-show="tab === 'strategy'" class="card panel fade-up">
      <h2 class="panel-title">
        {{ t('策略参数') }}
        <span v-if="strategy?.strategy" class="tag">{{ strategy.strategy }}</span>
      </h2>
      <template v-if="strategy && strategy.available === 'ok' && strategy.info">
        <p class="muted small">
          {{ t('时间框架') }} <strong class="mono">{{ strategy.info.timeframe ?? '—' }}</strong>
          {{ t('· 可优化参数 {n} 项', { n: strategy.info.params?.length ?? 0 }) }}
        </p>
        <table v-if="strategy.info.params?.length" class="tbl">
          <thead>
            <tr>
              <th>{{ t('参数') }}</th>
              <th class="right">{{ t('当前值') }}</th>
              <th>{{ t('类型') }}</th>
              <th>{{ t('空间') }}</th>
              <th class="right">{{ t('范围') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in strategy.info.params" :key="p.name">
              <td class="mono">{{ p.name }}</td>
              <td class="right num">{{ display(p.value) }}</td>
              <td class="mono small">{{ p.param_type ?? '—' }}</td>
              <td class="mono small">{{ p.space ?? '—' }}</td>
              <td class="right num small">
                {{ p.low ?? '—' }} ~ {{ p.high ?? '—' }}
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted small">{{ t('该策略没有声明可优化参数。') }}</p>
        <p class="muted small note">
          {{ t('这里列的是 `IntParameter` / `DecimalParameter` 这类可优化参数，不是策略的全部类属性。') }}
        </p>
      </template>
      <div v-else class="empty">
        <p class="empty-title">{{ t('取不到策略参数') }}</p>
        <p class="muted">{{ !strategy || strategy.reason === null ? t('bot 可能还没加载完策略') : errorDetailText({ detail: strategy.reason, status: strategy.status }) }}</p>
        <p class="muted small">{{ t('上游只在 running / paused 状态下返回策略信息。') }}</p>
      </div>
    </section>
    <!-- 选币 -->
    <section v-show="tab === 'pairlist'" class="grid fade-up">
      <div class="card panel">
        <h2 class="panel-title">
          {{ t('白名单') }}
          <span class="tag">{{ t('{n} 个', { n: pairlist?.whitelist.length ?? 0 }) }}</span>
        </h2>
        <template v-if="pairlist">
          <div v-if="pairlist.whitelist_method.length" class="chain">
            <template v-for="(m, i) in pairlist.whitelist_method" :key="`${m}-${i}`">
              <span class="chainstep mono">{{ m }}</span>
              <span v-if="i < pairlist.whitelist_method.length - 1" class="arrow">›</span>
            </template>
          </div>
          <div v-if="pairlist.whitelist.length" class="chips">
            <span v-for="p in pairlist.whitelist" :key="p" class="pchtag mono">{{ p }}</span>
          </div>
          <p v-else class="muted small">{{ t('本轮还没有选出交易对（选币可能尚未跑完，或过滤后为空）。') }}</p>
          <p class="muted small note">
            {{ t('这是') }}<strong>{{ t('本轮') }}</strong>{{ t('的选币结果，动态选币每轮都可能换批；上面的链路就是 config 里的 pairlist 顺序。') }}
          </p>
        </template>
        <div v-else class="empty">
          <p class="empty-title">{{ t('取不到白名单') }}</p>
          <p class="muted">{{ pairlistReason === null ? t('bot 当前不可达') : errorDetailText(pairlistReason) }}</p>
        </div>
      </div>

      <div class="card panel">
        <h2 class="panel-title">{{ t('黑名单与临时锁定') }}</h2>
        <template v-if="pairlist">
          <h3 class="group-title">{{ t('黑名单规则（正则，不是具体币对）') }}</h3>
          <div v-for="b in pairlist.blacklist" :key="b" class="kvrow">
            <span class="k mono">{{ b }}</span>
          </div>
          <p v-if="!pairlist.blacklist.length" class="muted small">{{ t('没有黑名单规则。') }}</p>
          <p class="muted small">
            {{ t('展开后命中 {n} 个交易对。', { n: pairlist.blacklist_expanded.length }) }}
          </p>

          <h3 class="group-title spaced">{{ t('临时锁定') }}</h3>
          <table v-if="pairlist.locks.length" class="tbl">
            <thead>
              <tr><th>pair</th><th>{{ t('方向') }}</th><th>{{ t('原因') }}</th><th class="right">{{ t('到期') }}</th></tr>
            </thead>
            <tbody>
              <tr v-for="l in pairlist.locks" :key="l.id">
                <td class="mono">{{ l.pair }}</td>
                <td class="mono small">{{ l.side }}</td>
                <td class="small">{{ l.reason ?? '—' }}</td>
                <td class="right num small">{{ shortTs(l.lock_end_time) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="muted small">{{ t('当前没有被锁定的交易对。') }}</p>
          <p class="muted small note">
            {{ t('锁定有到期时间，到点自动释放；它不是黑名单，别当成"永久不能交易"。') }}
          </p>
        </template>
        <div v-else class="empty">
          <p class="empty-title">{{ t('取不到屏蔽信息') }}</p>
          <p class="muted">{{ pairlistReason === null ? t('bot 当前不可达') : errorDetailText(pairlistReason) }}</p>
        </div>
      </div>
    </section>
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

.small {
  font-size: 12.5px;
}

.tabs {
  display: flex;
  gap: 2px;
}

.tab {
  padding: 7px 14px;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.2s var(--ease), color 0.2s var(--ease);
}

.tab:hover {
  background: color-mix(in srgb, var(--text) 6%, transparent);
  color: var(--text);
}

.tab.on {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  color: var(--accent);
}

.panel {
  padding: 18px 20px 20px;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
  flex-wrap: wrap;
  margin-bottom: var(--space-sm);
}

.panel-title {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-bottom: var(--space-md);
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.tag {
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  color: var(--accent);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  font-weight: 500;
}

.filters {
  display: flex;
  gap: 4px;
}

.chip {
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.18s var(--ease), color 0.18s var(--ease);
}

.chip:hover {
  background: color-mix(in srgb, var(--text) 6%, transparent);
}

.chip.on {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border-color: color-mix(in srgb, var(--accent) 30%, transparent);
  color: var(--accent);
}

.meta {
  display: flex;
  align-items: center;
  gap: var(--space-md);
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--text-secondary);
  cursor: pointer;
}

.logbox {
  max-height: min(62vh, 620px);
  overflow: auto;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-inner);
  background: var(--bg-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.55;
}

.logline {
  display: grid;
  grid-template-columns: 78px 62px minmax(0, 1fr);
  gap: 10px;
  padding: 1px 0;
  border-radius: 4px;
}

.logline:hover {
  background: color-mix(in srgb, var(--text) 4%, transparent);
}

.ts {
  color: var(--text-tertiary);
}

.lv {
  font-weight: 600;
  font-size: 11.5px;
  letter-spacing: 0.02em;
}

.msg {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--text);
}

.lv-error .lv,
.lv-error .msg {
  color: var(--down);
}

.lv-warn .lv,
.lv-warn .msg {
  color: var(--warn);
}

.lv-debug .msg,
.lv-debug .lv {
  color: var(--text-tertiary);
}

.lv-info .lv {
  color: var(--text-secondary);
}

.grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
  gap: var(--space-md);
  align-items: start;
}

.gauges {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-md);
  margin-bottom: var(--space-md);
}

.gauge {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.gauge strong {
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.bar {
  height: 6px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--text) 8%, transparent);
  overflow: hidden;
}

.bar i {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: var(--accent);
  transition: width 0.4s var(--ease);
}

.kv,
.params {
  width: 100%;
  border-collapse: collapse;
}

.tbl {
  width: 100%;
  border-collapse: collapse;
}

.tbl th {
  padding: 6px 8px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-tertiary);
  text-align: left;
  border-bottom: 1px solid var(--border);
}

.tbl td {
  padding: 7px 8px;
  font-size: 13px;
  border-bottom: 1px solid var(--border);
}

.tbl tr:last-child td {
  border-bottom: none;
}

.load {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: var(--space-sm);
  border-top: 1px solid var(--border);
}

.loadrow {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-md);
  font-size: 13px;
}

.note {
  margin-top: var(--space-sm);
}

.chain {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: var(--space-md);
}

.chainstep {
  padding: 3px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--bg-secondary);
  font-size: 11.5px;
  color: var(--text-secondary);
}

.arrow {
  color: var(--text-tertiary);
  font-size: 14px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.pchtag {
  padding: 4px 10px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--up) 10%, transparent);
  color: var(--up);
  font-size: 12px;
}

.group-title.spaced {
  margin-top: var(--space-lg);
}

.kv th {
  padding: 6px 8px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-tertiary);
  text-align: left;
  border-bottom: 1px solid var(--border);
}

.kv td {
  padding: 6px 8px;
  font-size: 13px;
  border-bottom: 1px solid var(--border);
}

.kv tr:last-child td {
  border-bottom: none;
}

.right {
  text-align: right;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.group + .group {
  margin-top: var(--space-md);
}

.group-title {
  margin-bottom: 4px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-tertiary);
  letter-spacing: 0.02em;
}

.kvrow {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-md);
  padding: 4px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  font-size: 13px;
}

.kvrow:last-child {
  border-bottom: none;
}

.k {
  color: var(--text-secondary);
  font-size: 12.5px;
  overflow-wrap: anywhere;
}

.v {
  color: var(--text);
  text-align: right;
  overflow-wrap: anywhere;
}

.empty {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--space-lg) 0;
  text-align: center;
}

.empty-title {
  font-size: 14px;
  font-weight: 500;
}

.notice {
  padding: 10px 14px;
  border-radius: var(--radius-inner);
  background: color-mix(in srgb, var(--warn) 10%, transparent);
  color: var(--warn);
  font-size: 13px;
}

@media (max-width: 900px) {
  .grid {
    grid-template-columns: 1fr;
  }

  .logline {
    grid-template-columns: 70px 56px minmax(0, 1fr);
    gap: 8px;
  }
}

@media (max-width: 640px) {
  .page {
    padding: var(--space-md) var(--space-md) var(--space-2xl);
  }

  .head {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
