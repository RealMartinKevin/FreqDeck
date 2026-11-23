<script setup lang="ts">
import { t } from '../i18n'
import { computed } from 'vue'
import type { OverviewTotals } from '../api/types'
import { money, signed, tone } from '../composables/useFormat'

const props = defineProps<{ totals: OverviewTotals }>()

/**
 * 「总权益」用的是 **bot 权益**（`/balance.total_bot`），不是账户总额（`total`）。
 *
 * 两个口径会差一笔钱：手动划进账户的钱在 `total` 里、在 `total_bot` 里不算。
 * 实测两者差 9.98（998.10 vs 988.12），若不说明，用户会拿这个数去对交易所账单，
 * 然后发现「对不上」——而数字本身是对的，错的是它被读成了什么。
 * 所以标题文案必须写清口径，且用 title 给出完整解释（视觉上不加长标签）。
 */
const equityTitle = 'bot 权益（/balance.total_bot）：只算这台 bot 自己的资金，不含手动划入账户的金额；账户总额含手动划入'

/**
 * 交易状态的唯一判定处。
 *
 * 只有一个 bot 时「运行 0/1」毫无信息量（读过一次就不会变），而观察模式下那个 `0`
 * 还会被读成「没有持仓/没在跑」的负面结论。所以这里只说状态，不给分数。
 * 四档互斥由 `mapOverviewTotals()` 保证，这里只做翻译。
 */
const state = computed<{ label: string; tone: 'up' | 'warn' | 'muted' }>(() => {
  const totals = props.totals
  if (totals.unreachable > 0) return { label: t('不可达'), tone: 'warn' }
  if (totals.running > 0) return { label: t('正在交易'), tone: 'up' }
  if (totals.paused > 0) return { label: t('已暂停'), tone: 'warn' }
  return { label: t('未在交易'), tone: 'muted' }
})
</script>

<template>
  <section class="card strip fade-up">
    <div class="hero">
      <span class="eyebrow" :title="t(equityTitle)">{{ t('总权益') }}</span>
      <div class="big num" :title="t(equityTitle)">
        {{ money(props.totals.equity_total) }}
        <span v-if="props.totals.equity_total !== null" class="cur">
          {{ props.totals.equity_currency ?? '' }}
        </span>
      </div>
      <span class="hint">{{ t('含未平仓浮动 · 不含手动划入') }}</span>
    </div>

    <div class="stats">
      <div class="cell">
        <span class="k" :title="t('按 UTC 自然日聚合；Freqtrade 以 UTC 切分交易日')">{{ t('今日 (UTC)') }}</span>
        <div class="mid num" :class="tone(props.totals.today_realized)">
          {{ signed(props.totals.today_realized) }}
        </div>
        <span class="hint" :title="props.totals.today_complete ? '' : t('未拿到今日数据，合计不完整')">
          {{ t('已平仓') }}
          <template v-if="!props.totals.today_complete">· {{ t('不完整') }}</template>
        </span>
      </div>

      <div class="cell">
        <span class="k" :title="t('已平仓净盈亏累计')">{{ t('已实现') }}</span>
        <div class="mid num" :class="tone(props.totals.realized_pnl)">
          {{ signed(props.totals.realized_pnl) }}
        </div>
        <span class="hint">{{ t('累计') }}</span>
      </div>

      <div class="cell">
        <span class="k" :title="t('未平仓浮动')">{{ t('未实现') }}</span>
        <div class="mid num" :class="tone(props.totals.unrealized_pnl)">
          {{ signed(props.totals.unrealized_pnl) }}
        </div>
        <span class="hint">{{ t('浮动') }}</span>
      </div>

      <div class="cell">
        <span class="k" :title="t('bot 当前是否在交易（不做启停操作，只看状态）')">{{ t('交易状态') }}</span>
        <div class="mid" :class="`tone-${state.tone}`">{{ state.label }}</div>
        <span class="hint counts">
          <!-- 0 与 null 不能混：null 是「不知道有几笔」，0 是「确实没有持仓」 -->
          <RouterLink class="jump" to="/positions">{{ t('{n} 笔持仓', { n: props.totals.open_trades ?? '—' }) }}</RouterLink>
        </span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.strip {
  display: grid;
  grid-template-columns: minmax(260px, 1.25fr) 3fr;
  gap: var(--space-xl);
  padding: 26px 28px;
}

.hero {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding-right: var(--space-xl);
  border-right: 1px solid var(--border);
}

.big {
  font-size: 46px;
  font-weight: 600;
  line-height: 1.08;
  letter-spacing: -0.03em;
}

.cur {
  font-size: 14px;
  font-weight: 500;
  letter-spacing: 0;
  color: var(--text-tertiary);
}

.stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-lg);
  align-items: start;
}

.cell {
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

.mid {
  font-size: 22px;
  font-weight: 600;
  line-height: 1.35;
  letter-spacing: -0.02em;
}

/* 状态是词不是数字：等宽数字字体对中文词没有意义，去掉 .num 观感更稳 */
.tone-up {
  color: var(--up);
}

.tone-warn {
  color: var(--warn);
}

.tone-muted {
  color: var(--text-tertiary);
}

.counts {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 汇总条里唯一可点的数字：下划线只在 hover 出现，平时保持"数据"而不是"按钮"的观感 */
.jump {
  color: inherit;
  text-decoration: none;
  border-bottom: 1px dashed transparent;
}

.jump:hover {
  color: var(--accent);
  border-bottom-color: color-mix(in srgb, var(--accent) 45%, transparent);
}

@media (max-width: 1080px) {
  .strip {
    grid-template-columns: 1fr;
    gap: var(--space-lg);
  }
  .hero {
    padding-right: 0;
    padding-bottom: var(--space-md);
    border-right: none;
    border-bottom: 1px solid var(--border);
  }
  .big {
    font-size: 40px;
  }
}

@media (max-width: 720px) {
  .strip {
    padding: 20px;
  }
  .stats {
    grid-template-columns: 1fr 1fr;
    gap: var(--space-md) var(--space-lg);
  }
  .mid {
    font-size: 20px;
  }
}
</style>
