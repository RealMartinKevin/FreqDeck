<script setup lang="ts">
import { t } from '../i18n'
import { computed } from 'vue'
import type { CandlesOut } from '../api/types'
import StatePanel from './StatePanel.vue'

const props = defineProps<{
  data: CandlesOut | null
  /** 距上次成功拉取的秒数；由页面驱动，组件不自己计时 */
  ageSeconds: number | null
}>()

// `invalid_pair` 不在这里：它是 400 走 client 的 catch，永远不会出现在 200 的 reason 里，
// 恢复入口在页面上（见 CandleChart 对 errorStatus===400 的处理）
const emit = defineEmits<{ retry: [] }>()

type Tone = 'warn' | 'error' | 'info' | 'muted'

interface ReasonView {
  tone: Tone
  title: string
  detail: string
  /** 空串 = 不提供动作（unauthorized 明确不给重试，重试只会再被拒） */
  action: string
  /** true = 整块替换图区；false = 图照常画，只在上方加一条提示 */
  blocking: boolean
}

// 文案与视觉严格照 02 §3.4：一个 reason 一种说法，三页共用同一套 StatePanel
const REASONS: Record<string, ReasonView> = {
  empty_window: {
    tone: 'warn',
    title: '上游没有返回 K 线',
    detail: '机器人可能刚启动，还没完成指标预热。预热完成后重新拉取即可，不用改配置。',
    action: '重新拉取',
    blocking: true,
  },
  api_unreachable: {
    tone: 'error',
    title: '无法连接交易接口',
    detail: '可能未启动或端口不通。进程停了不代表历史无效，可先去持仓明细看历史。',
    action: '重试',
    blocking: true,
  },
  unauthorized: {
    tone: 'error',
    title: 'API 凭据被拒绝',
    detail: '请检查用户名与密码。这与「连不上」是两回事。',
    action: '',
    blocking: true,
  },
  timeframe_unavailable: {
    tone: 'warn',
    title: '没有这个粒度的数据可看',
    detail: '上游只缓存 bot 自身的粒度，5m 也只能从 1m 派生。',
    action: '',
    blocking: true,
  },
  schema_mismatch: {
    tone: 'warn',
    title: '这批数据缺少策略指标列',
    detail: '只画了价格，没有开平仓与拦截标记。策略可能改过指标。',
    action: '',
    blocking: false,
  },
}

/** 缺列名（如 l2_block）；空串 = 列完整 */
const missingText = computed(() => (props.data?.scope.overlay_missing ?? []).join('、'))

const view = computed<ReasonView | null>(() => {
  const reason = props.data?.reason
  if (!reason) return null
  const known = REASONS[reason]
  if (known) {
    if (reason === 'timeframe_unavailable') {
      const base = props.data?.base_timeframe ?? t('未知')
      return { ...known, detail: t('当前配置的粒度是 {base}，没有 {tf} 的数据可看。{detail}', { base, tf: String(props.data?.timeframe), detail: t(known.detail) }) }
    }
    // 缺的列名才是用户能拿去改策略的信息，拼进同一条提示，不再叠第二个提示条
    if (reason === 'schema_mismatch' && missingText.value) {
      return { ...known, detail: t('{detail}缺少：{missing}。', { detail: t(known.detail), missing: missingText.value }) }
    }
    return known
  }
  return { tone: 'error', title: t('拉取 K 线失败'), detail: reason, action: t('重试'), blocking: true }
})

const supportLines = computed(() => {
  const seen = new Set<string>()
  for (const bar of props.data?.bars ?? []) if (bar.support) seen.add(bar.support.line)
  return [...seen]
})

const isDerived = computed(() => Boolean(props.data?.derived_from))
const showLegend = computed(() => Boolean(props.data?.bars.length))

function shortUtc(iso: string | null): string {
  // 后端一律出 ISO Z，切片就够；不在这里做时区换算，否则最早就不是 UTC 的最早了
  if (!iso) return '—'
  return iso.slice(5, 16).replace('T', ' ')
}
</script>

<template>
  <section class="scope-bar">
    <StatePanel
      v-if="view && view.blocking"
      :tone="view.tone"
      :title="t(view.title)"
      :action="t(view.action)"
      @action="emit('retry')"
    >
      {{ t(view.detail) }}
    </StatePanel>

    <template v-else>
      <!-- 提示条不挡图：缺指标列时价格仍然要能看（E10） -->
      <StatePanel v-if="view" variant="inline" :tone="view.tone" :title="t(view.title)">
        {{ t(view.detail) }}
      </StatePanel>
      <!-- 只缺 l2_* 时 reason 仍是 null：标记照画，只是少了归因信息，不能降级成空态 -->
      <StatePanel
        v-else-if="missingText"
        variant="inline"
        tone="warn"
        :title="t('这批数据缺少覆盖层需要的列')"
      >
        {{ t('标记与价格照常绘制，但缺少：{missing}。策略可能改过指标名。', { missing: missingText }) }}
      </StatePanel>

      <div v-if="data" class="line">
        <span class="num">{{ t('共 {n} 根', { n: data.scope.bar_count }) }}</span>
        <span class="sep">·</span>
        <span class="num">{{ t('最早 {time}', { time: shortUtc(data.scope.earliest_time) }) }}</span>
        <span class="sep">·</span>
        <span class="num">{{ t('末根 {time} (UTC)', { time: shortUtc(data.scope.latest_time) }) }}</span>
        <span class="sep">·</span>
        <span class="num">{{ t('上游窗口 {n} 根', { n: data.scope.upstream_length }) }}</span>
        <span v-if="data.scope.truncated" class="hint">· {{ t('上游只保留了最近 {n} 根', { n: data.scope.upstream_length }) }}</span>
        <span v-if="ageSeconds !== null" class="age num">· {{ t('拉取于 {n}s 前', { n: ageSeconds ?? '' }) }}</span>
        <span v-if="data.limit_requested > data.limit_effective" class="hint">
          · {{ t('已按 {n} 根返回', { n: data.limit_effective }) }}
        </span>
      </div>

      <div v-if="showLegend" class="legend">
        <span class="key"><i class="dot up" />{{ t('开仓 / 平空') }}</span>
        <span class="key"><i class="dot down" />{{ t('平仓 / 开空') }}</span>
        <span v-for="line in supportLines" :key="line" class="key">
          <i class="dash" />{{ line }}
        </span>
        <span v-if="isDerived" class="muted">{{ t('派生视图（{from} → {to}）不含标记', { from: data?.derived_from ?? '', to: data?.timeframe ?? '' }) }}</span>
      </div>
    </template>
  </section>
</template>

<style scoped>
.scope-bar {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  margin-bottom: var(--space-sm);
}

.line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
}

.sep {
  color: var(--text-tertiary);
}

.age {
  color: var(--text-tertiary);
}

.legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-md);
  font-size: 12.5px;
  color: var(--text-secondary);
}

.key {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.dot.up {
  background: var(--up);
}

.dot.down {
  background: var(--down);
}

/* 支撑线是"策略意图"不是涨跌，用 accent 虚线；用 border-top 画一小段即可，不引 SVG */
.dash {
  width: 16px;
  height: 0;
  border-top: 1.5px dashed var(--accent);
}
</style>
