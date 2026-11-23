<script setup lang="ts">
import { t } from '../i18n'
import { computed, ref, watch } from 'vue'
import { api, errorDetailText, ApiFailure } from '../api/client'
import type { ErrorDetailSource } from '../api/client'
import type { TradeDetail, TradeDetailOut, TradeOrder } from '../api/types'
import { duration, qty, signed, tone } from '../composables/useFormat'
import Modal from './Modal.vue'

const props = defineProps<{ open: boolean; instanceId: string; tradeId: number | null }>()
const emit = defineEmits<{ close: [] }>()

const data = ref<TradeDetailOut | null>(null)
const loading = ref(false)
const error = ref<ErrorDetailSource>(null)
const showCustom = ref(false)

const trade = computed<TradeDetail | null>(() => data.value?.trade ?? null)

const orders = computed<TradeOrder[]>(() => {
  const list = trade.value?.orders
  return Array.isArray(list) ? list : []
})

/** 开/平时间在不同版本里叫 open_date / open_time，取值做回退而不是赌一个字段名 */
function timeOf(t: TradeDetail | null, which: 'open' | 'close'): string | null {
  if (!t) return null
  const v = which === 'open' ? (t.open_date ?? t.open_time) : (t.close_date ?? t.close_time)
  return typeof v === 'string' ? v : null
}

/** 上游时间是 "2026-11-05 05:12:00"（UTC 无时区标记），直接 new Date 会被当本地时间 */
function fmt(ts: string | null): string {
  if (!ts) return '—'
  const iso = ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ts
  return d.toLocaleString('zh-CN', { hour12: false })
}

const heldSeconds = computed<number | null>(() => {
  const a = timeOf(trade.value, 'open')
  const b = timeOf(trade.value, 'close')
  if (!a || !b) return null
  const toMs = (s: string) => new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').getTime()
  const delta = (toMs(b) - toMs(a)) / 1000
  return Number.isFinite(delta) && delta >= 0 ? delta : null
})

async function load() {
  if (!props.open || !props.tradeId || !props.instanceId) return
  loading.value = true
  error.value = null
  data.value = null
  try {
    data.value = await api.tradeDetail(props.instanceId, props.tradeId)
    if (data.value.available !== 'ok') {
      error.value =
        data.value.reason === null
          ? t('交易接口当前不可达')
          : { detail: data.value.reason, status: data.value.status }
    }
  } catch (e) {
    error.value = e instanceof ApiFailure ? e : t('加载交易详情失败')
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.open, props.tradeId, props.instanceId],
  () => {
    showCustom.value = false
    if (props.open) void load()
  },
)

function orderSide(o: TradeOrder): 'buy' | 'sell' {
  return o.ft_order_side === 'sell' ? 'sell' : 'buy'
}

function fmtNum(v: number | null | undefined, digits = 6): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return v.toLocaleString('zh-CN', { maximumFractionDigits: digits })
}
</script>

<template>
  <Modal :open="open" @close="emit('close')">
    <div class="detail">
      <header class="dhead">
        <div class="id">
          <span class="pair">{{ trade?.pair ?? t('加载中…') }}</span>
          <span v-if="trade" class="badge" :class="trade.is_open ? 'open' : 'closed'">
            {{ trade.is_open ? t('持仓中') : t('已平仓') }}
          </span>
          <span v-if="trade?.side" class="badge side" :class="trade.side === 'short' ? 'down' : 'up'">
            {{ trade.side === 'short' ? t('空') : t('多') }}
          </span>
        </div>
        <button class="x" type="button" :aria-label="t('关闭')" @click="emit('close')">✕</button>
      </header>

      <p v-if="loading" class="muted">{{ t('正在从交易接口读取…') }}</p>

      <div v-else-if="error" class="err">
        <p>{{ errorDetailText(error) }}</p>
        <p class="muted small">
          {{ t('详情来自交易接口，不是本地库：进程未在交易模式或该笔已被清理时读不到。已平仓明细请回持仓页看本地记录。') }}
        </p>
        <button class="btn btn-secondary btn-sm" type="button" @click="load">{{ t('重试') }}</button>
      </div>

      <template v-else-if="trade">
        <div class="stats">
          <div class="cell">
            <span class="k">{{ t('开仓均价') }}</span>
            <strong class="num">{{ fmtNum(trade.open_rate) }}</strong>
          </div>
          <div class="cell">
            <span class="k">{{ t('平仓均价') }}</span>
            <strong class="num">{{ fmtNum(trade.close_rate) }}</strong>
          </div>
          <div class="cell">
            <span class="k">{{ t('数量') }}</span>
            <strong class="num">{{ qty(trade.amount ?? null) }}</strong>
          </div>
          <div class="cell">
            <span class="k">{{ t('名义本金') }}</span>
            <strong class="num">{{ fmtNum(trade.stake_amount) }}</strong>
          </div>
          <div class="cell">
            <span class="k">{{ t('杠杆') }}</span>
            <strong class="num">{{ trade.leverage != null ? `${trade.leverage}×` : '—' }}</strong>
          </div>
          <div class="cell">
            <span class="k">{{ trade.is_open ? t('浮动盈亏') : t('已实现盈亏') }}</span>
            <strong class="num" :class="tone(trade.profit_abs ?? null)">
              {{ signed(trade.profit_abs ?? null) }}
            </strong>
          </div>
        </div>

        <dl class="meta">
          <div><dt>{{ t('开仓') }}</dt><dd class="num">{{ fmt(timeOf(trade, 'open')) }}</dd></div>
          <div><dt>{{ t('平仓') }}</dt><dd class="num">{{ fmt(timeOf(trade, 'close')) }}</dd></div>
          <div><dt>{{ t('持仓') }}</dt><dd class="num">{{ duration(heldSeconds) }}</dd></div>
          <div><dt>{{ t('入场标签') }}</dt><dd class="mono">{{ trade.enter_tag ?? '—' }}</dd></div>
          <div><dt>{{ t('出场原因') }}</dt><dd class="mono">{{ trade.exit_reason ?? '—' }}</dd></div>
          <div><dt>ID</dt><dd class="mono">{{ trade.trade_id }}</dd></div>
        </dl>

        <section class="orders">
          <h3 class="sub">{{ t('订单（{n}）', { n: orders.length }) }}</h3>
          <p v-if="!orders.length" class="muted small">{{ t('上游没有返回订单明细。') }}</p>
          <table v-else class="tbl">
            <thead>
              <tr>
                <th>{{ t('方向') }}</th>
                <th>{{ t('类型') }}</th>
                <th class="right">{{ t('价格') }}</th>
                <th class="right">{{ t('成交/数量') }}</th>
                <th>{{ t('状态') }}</th>
                <th>{{ t('撤单原因') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="o in orders" :key="o.order_id">
                <td>
                  <span class="side-dot" :class="orderSide(o) === 'buy' ? 'up' : 'down'" />
                  {{ orderSide(o) === 'buy' ? t('买') : t('卖') }}
                </td>
                <td class="mono small">{{ o.order_type ?? '—' }}</td>
                <td class="right num">{{ fmtNum(o.average ?? o.price) }}</td>
                <td class="right num">
                  {{ fmtNum(o.filled) }}<span class="muted"> / {{ fmtNum(o.amount) }}</span>
                </td>
                <td class="mono small">{{ o.status }}</td>
                <td class="mono small">
                  {{ o.ft_cancel_reason ?? '—' }}
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section v-if="data?.custom_data?.length" class="custom">
          <button class="linkbtn" type="button" @click="showCustom = !showCustom">
            {{ t('{action}策略自定义数据（{n}）', { action: showCustom ? t('收起') : t('展开'), n: data.custom_data.length }) }}
          </button>
          <pre v-if="showCustom" class="pre">{{ JSON.stringify(data.custom_data, null, 2) }}</pre>
        </section>
      </template>
    </div>
  </Modal>
</template>

<style scoped>
.detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}

.dhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
}

.id {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  min-width: 0;
}

.pair {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.badge {
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  font-size: 11.5px;
  font-weight: 500;
  background: color-mix(in srgb, var(--text) 7%, transparent);
  color: var(--text-secondary);
}

.badge.open {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
}

.badge.side.up {
  background: color-mix(in srgb, var(--up) 12%, transparent);
  color: var(--up);
}

.badge.side.down {
  background: color-mix(in srgb, var(--down) 12%, transparent);
  color: var(--down);
}

.x {
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 15px;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 8px;
}

.x:hover {
  background: color-mix(in srgb, var(--text) 7%, transparent);
  color: var(--text);
}

.stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-md);
  padding: var(--space-md);
  border-radius: var(--radius-inner);
  background: var(--bg-secondary);
}

.cell {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.k {
  font-size: 12px;
  color: var(--text-secondary);
}

.cell strong {
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.meta {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px var(--space-lg);
  margin: 0;
}

.meta > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-sm);
  padding-bottom: 4px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
}

.meta dt {
  font-size: 12.5px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.meta dd {
  margin: 0;
  font-size: 12.5px;
  text-align: right;
  overflow-wrap: anywhere;
}

.sub {
  margin-bottom: var(--space-sm);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}

.tbl {
  width: 100%;
  border-collapse: collapse;
}

.tbl th {
  padding: 5px 6px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-tertiary);
  text-align: left;
  border-bottom: 1px solid var(--border);
}

.tbl td {
  padding: 7px 6px;
  font-size: 12.5px;
  border-bottom: 1px solid var(--border);
}

.tbl tr:last-child td {
  border-bottom: none;
}

.right {
  text-align: right;
}

.side-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 4px;
  border-radius: 50%;
  vertical-align: middle;
}

.side-dot.up {
  background: var(--up);
}

.side-dot.down {
  background: var(--down);
}

.linkbtn {
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: 12.5px;
  cursor: pointer;
  padding: 0;
}

.pre {
  max-height: 220px;
  margin: var(--space-sm) 0 0;
  padding: 10px 12px;
  overflow: auto;
  border-radius: var(--radius-inner);
  background: var(--bg-secondary);
  font-size: 11.5px;
  line-height: 1.5;
}

.err {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-sm);
  font-size: 13px;
  color: var(--text-secondary);
}

.small {
  font-size: 12px;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.btn-sm {
  min-height: 34px;
  padding: 6px 14px;
  font-size: 13px;
}

@media (max-width: 560px) {
  .stats {
    grid-template-columns: 1fr 1fr;
  }

  .meta {
    grid-template-columns: 1fr;
  }
}
</style>
