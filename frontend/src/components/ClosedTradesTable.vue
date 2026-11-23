<script setup lang="ts">
import { computed } from 'vue'
import type { ClosedTradeRow, TradesOut } from '../api/types'
import { duration, pct, price, signed, tone } from '../composables/useFormat'
import TableShell from './TableShell.vue'

const props = withDefaults(
  defineProps<{
    result: TradesOut
    /**
     * 单实例世界里实例名是常量，因此**不再占一列**：一列 100% 相同的值只会挤掉
     * 真正要对照的数字。prop 保留是为了不动调用方（`TradesOut.instance_name` 仍是契约字段）。
     */
    instanceName: string
    emptyText?: string
    busy?: boolean
  }>(),
  { emptyText: '还没有已平仓交易', busy: false },
)

const emit = defineEmits<{ page: [offset: number]; review: [row: ClosedTradeRow]; detail: [row: ClosedTradeRow] }>()

/** SQLite 里是无时区 UTC 文本，后端已转 ISO Z；界面只到分钟，秒进 title */
function shortTime(iso: string | null): string {
  return iso ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : '—'
}

// 常见值给中文，未知值原样透出：把技术标识藏起来会让人查不到日志
const EXIT_TEXT: Record<string, string> = {
  roi: '止盈',
  stop_loss: '止损',
  trailing_stop_loss: '移动止损',
  force_exit: '强制退出',
  exit_signal: '信号退出',
  emergency_exit: '紧急退出',
  liquidation: '强平',
}

const reason = (code: string | null): string => (code === null ? '—' : (EXIT_TEXT[code] ?? code))

const total = computed(() => props.result.total)
// 页数用截断后生效的 limit：用 limit_requested 在 >500 时会算出不存在的页
const pages = computed(() => Math.max(1, Math.ceil(total.value / props.result.limit)))
// 越界时不要显示「5 / 4」这种自相矛盾的页码，配上下面的空态文案已足够说明发生了什么
const page = computed(() => Math.min(pages.value, Math.floor(props.result.offset / props.result.limit) + 1))
// 越界翻页：行是空的但总数是真的（筛完变少或者别人删了记录）
const beyond = computed(() => props.result.rows.length === 0 && total.value > 0)

function go(delta: number) {
  emit('page', Math.max(0, props.result.offset + delta * props.result.limit))
}
</script>

<template>
  <div>
    <TableShell :empty="!props.result.rows.length" :dim="props.busy">
      <template #head>
        <tr>
          <th class="l">交易对</th>
          <th class="l">方向</th>
          <th>平仓价</th>
          <th>平仓时间 (UTC)</th>
          <th class="l">原因</th>
          <th>盈亏</th>
          <th>ROE</th>
          <th>持仓时长</th>
          <th />
        </tr>
      </template>

      <template #body>
        <tr v-for="row in props.result.rows" :key="row.trade_id">
          <td class="l">
            <button class="pairlink" type="button" :title="`查看 ${row.pair} 的订单明细（来自交易接口）`"
              @click="emit('detail', row)">
              {{ row.pair }}
            </button>
          </td>
          <td class="l">
            {{ row.side === 'long' ? '做多' : '做空' }}
            <span v-if="row.leverage !== null" class="lev num">· {{ row.leverage }}x</span>
          </td>
          <td class="num">
            {{ price(row.close_rate) }}
            <!-- 开仓价降为次行：两列对照才看得出这笔赚在开仓价还是平仓价 -->
            <span class="sub num">开 {{ price(row.open_rate) }}</span>
          </td>
          <td class="num" :title="row.close_time ?? ''">{{ shortTime(row.close_time) }}</td>
          <td class="l">
            {{ reason(row.exit_reason) }}
            <span v-if="row.enter_tag" class="sub tag" :title="row.enter_tag">{{ row.enter_tag }}</span>
          </td>
          <td class="num" :class="tone(row.pnl_abs)">{{ signed(row.pnl_abs) }}</td>
          <td class="num" :class="tone(row.roe_pct)">{{ pct(row.roe_pct) }}</td>
          <td class="num">{{ duration(row.duration_seconds) }}</td>
          <td class="act">
            <!-- 复盘要有「一段完整的开平仓」才成立：已平仓才是它的正确归属 -->
            <button class="btn btn-secondary btn-sm" type="button" @click="emit('review', row)">复盘</button>
          </td>
        </tr>
      </template>

      <template #empty>
        <p v-if="beyond" class="hint">这一页没有数据，可能被过滤掉了</p>
        <p v-else class="hint">{{ props.emptyText }}</p>
      </template>
    </TableShell>

    <div class="foot">
      <span class="num total">共 {{ total }} 条</span>
      <button
        class="btn btn-secondary btn-sm"
        type="button"
        :disabled="props.busy || props.result.offset <= 0"
        @click="go(-1)"
      >
        上一页
      </button>
      <span class="num pager">{{ page }} / {{ pages }}</span>
      <button
        class="btn btn-secondary btn-sm"
        type="button"
        :disabled="props.busy || props.result.offset + props.result.limit >= total"
        @click="go(1)"
      >
        下一页
      </button>
    </div>
  </div>
</template>

<style scoped>
th,
td {
  text-align: right;
}

.l {
  text-align: left;
}

/* 操作列右内边距与未平仓表一致，两张表切换时按钮不会左右跳 */
.act {
  padding-right: 12px;
  white-space: nowrap;
}

.lev {
  color: var(--text-tertiary);
}

.pairlink {
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  border-bottom: 1px dashed transparent;
}

.pairlink:hover {
  color: var(--accent);
  border-bottom-color: color-mix(in srgb, var(--accent) 45%, transparent);
}

.sub {
  display: block;
  margin-top: 2px;
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.tag {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.foot {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  justify-content: flex-end;
  margin-top: var(--space-md);
  font-size: 13px;
  color: var(--text-secondary);
}

.total {
  margin-right: auto;
}

.pager {
  min-width: 52px;
  text-align: center;
}

@media (max-width: 1439px) {
  .tag {
    display: none;
  }
}
</style>
