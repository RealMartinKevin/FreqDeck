<script setup lang="ts">
/**
 * Bot 状态卡：回答「这台 bot 到底是什么东西、现在在哪一步」。
 *
 * 数据来源有优先级：`/app/info`（mode store，10s 轮询）是权威来源，
 * 页面传下来的 `overview` 只用来补 `/app/info` 里没有的口径（如计价币、策略回退）；
 * 周期来自 `chartMeta`（`/app/info` 不含 timeframe，`/show_config` 的字段名太杂）。
 *
 * 措辞约束（设计 §7）：**不出现「启动」「停止」**。进程不是用户能操作的对象，
 * 界面只描述事实：「正在交易 / 未在交易 / 观察模式」。写成启停开关必然引出
 * 「我点了启动但没在交易」这种无解疑问——因为观察模式下进程本身是活的。
 */

import { t } from '../i18n'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { api } from '../api/client'
import type { InstanceOverview } from '../api/types'
import { useAppMode } from '../composables/useAppMode'

const props = defineProps<{
  /** 看板已拉到的快照：用它补 `/app/info` 没有的字段，避免状态卡自己再发一轮请求 */
  overview?: InstanceOverview | null
}>()

const { state, badge } = useAppMode()

/** 周期只有 `chartMeta` 一个干净来源（`/app/info` 不返回 timeframe） */
const timeframe = ref<string | null>(null)
let disposed = false

onMounted(async () => {
  try {
    const meta = await api.chartMeta('main')
    if (!disposed) timeframe.value = meta.timeframe
  } catch {
    // 观察模式下可能取不到：卡片该继续显示其它信息，不因为一个字段整块失败
    if (!disposed) timeframe.value = null
  }
})

onBeforeUnmount(() => {
  disposed = true
})

/** 空值统一显示「—」：null 是「不知道」，不是「零」，更不能编一个默认值 */
function dash(value: string | null | undefined): string {
  return typeof value === 'string' && value.trim() ? value : '—'
}

const exchange = computed(() => dash(state.exchange))
const strategy = computed(() => dash(state.strategy ?? props.overview?.strategy ?? null))
const currency = computed(() => dash(props.overview?.stake_currency ?? null))
const version = computed(() => dash(state.version))
const period = computed(() => dash(timeframe.value))
const runmode = computed(() => dash(state.runmode))

/**
 * 交易态三种取值 + 未知：
 * `trading_active === null`（还没读到）时显示「未知」，而不是乐观地写「正在交易」。
 */
const trading = computed<{ label: string; tone: string }>(() => {
  if (state.tradingActive === true) return { label: t('正在交易'), tone: 'up' }
  if (state.tradingActive === false) return { label: t('未在交易'), tone: 'warn' }
  return { label: t('未知'), tone: 'muted' }
})

/**
 * `ui_ready === false` 说明后端在 `app/static` 没找到前端产物：
 * 用户看到的界面来自 dev server 或旧部署，这解释了「我改了代码但界面没变」。
 */
const ui = computed<{ label: string; tone: string; hint: string | null }>(() => {
  if (state.uiReady === true) return { label: t('已部署'), tone: 'up', hint: null }
  if (state.uiReady === false) {
    return {
      label: t('未就绪'),
      tone: 'warn',
      hint: t('后端没在 app/static 找到前端产物：当前页面可能来自开发服务器，或 dist 还没放进去。'),
    }
  }
  return { label: t('未知'), tone: 'muted', hint: null }
})

const stateFilePath = computed(() => (state.stateFile === null ? null : state.stateFile))
const stateFileOpen = ref(false)
</script>

<template>
  <section class="card status">
    <header class="head">
      <div>
        <p class="eyebrow">{{ t('Bot 状态') }}</p>
        <h2 class="name">freqtrade</h2>
      </div>
      <span class="mode" :class="`t-${badge.tone}`">
        <i class="dot" aria-hidden="true" />
        {{ badge.label }}
      </span>
    </header>

    <dl class="grid">
      <div class="cell">
        <dt>{{ t('交易所') }}</dt>
        <dd>{{ exchange }}</dd>
      </div>
      <div class="cell">
        <dt>{{ t('策略') }}</dt>
        <dd>{{ strategy }}</dd>
      </div>
      <div class="cell">
        <dt>{{ t('周期') }}</dt>
        <dd class="num">{{ period }}</dd>
      </div>
      <div class="cell">
        <dt>{{ t('计价币') }}</dt>
        <dd>{{ currency }}</dd>
      </div>
      <div class="cell">
        <dt>{{ t('运行模式') }}</dt>
        <dd>{{ runmode }}</dd>
      </div>
      <div class="cell">
        <dt>{{ t('版本') }}</dt>
        <dd class="num">{{ version }}</dd>
      </div>
      <div class="cell">
        <dt>{{ t('交易') }}</dt>
        <dd :class="`t-${trading.tone}`">{{ trading.label }}</dd>
      </div>
      <div class="cell">
        <dt>{{ t('前端') }}</dt>
        <dd :class="`t-${ui.tone}`">
          {{ ui.label }}
          <span v-if="ui.hint" class="tip" :title="ui.hint">?</span>
        </dd>
      </div>
    </dl>

    <p v-if="ui.hint" class="ui-hint">{{ ui.hint }}</p>

    <!-- 状态文件路径：排障时经常要人「去打开这个文件」，所以可展开可选中，但不占默认视野 -->
    <div v-if="stateFilePath" class="file">
      <button class="file-toggle" type="button" :aria-expanded="stateFileOpen" @click="stateFileOpen = !stateFileOpen">
        <svg :class="{ open: stateFileOpen }" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 6l6 6-6 6" />
        </svg>
        {{ t('状态文件') }}
      </button>
      <code v-if="stateFileOpen" class="path">{{ stateFilePath }}</code>
    </div>
    <p v-else class="file-missing">{{ t('状态文件路径：—（未从 /app/info 取到）') }}</p>
  </section>
</template>

<style scoped>
.status {
  padding: var(--space-md) var(--space-md) 14px;
}

.head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-sm);
  margin-bottom: 12px;
}

.name {
  margin-top: 2px;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.015em;
}

.mode {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  padding: 4px 10px 4px 9px;
  border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, currentColor 8%, transparent);
  font-size: 12px;
  font-weight: 550;
  white-space: nowrap;
}

.mode .dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 2.5px color-mix(in srgb, currentColor 16%, transparent);
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

.t-muted {
  color: var(--text-tertiary);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 10px 14px;
  margin: 0;
}

.cell {
  min-width: 0;
}

dt {
  font-size: 11.5px;
  font-weight: 500;
  letter-spacing: 0.01em;
  color: var(--text-tertiary);
}

dd {
  margin: 1px 0 0;
  overflow: hidden;
  font-size: 13.5px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 未知态用次要色：`—` 不该和真实数值一样醒目 */
dd.t-muted {
  color: var(--text-tertiary);
}

.tip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin-left: 3px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--text) 8%, transparent);
  font-size: 10px;
  font-weight: 600;
  color: var(--text-secondary);
  vertical-align: 1px;
  cursor: help;
}

.ui-hint {
  margin-top: 8px;
  padding: 7px 10px;
  border-radius: var(--radius-inner);
  background: color-mix(in srgb, var(--warn) 8%, transparent);
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--text-secondary);
}

.file {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}

.file-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: none;
  background: transparent;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
}

.file-toggle:hover {
  color: var(--text);
}

.file-toggle svg {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform 0.2s var(--ease);
}

.file-toggle svg.open {
  transform: rotate(90deg);
}

.path {
  display: block;
  margin-top: 6px;
  padding: 6px 8px;
  overflow-x: auto;
  border-radius: 8px;
  background: var(--bg-secondary);
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11.5px;
  line-height: 1.5;
  white-space: nowrap;
  user-select: text;
}

.file-missing {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  font-size: 12.5px;
  color: var(--text-tertiary);
}
</style>
