<script setup lang="ts">
import { computed } from 'vue'
import type { OpenPositionRow, PositionsOut } from '../api/types'
import { money, pct, price, qty, signed, tone } from '../composables/useFormat'
import StatePanel from './StatePanel.vue'
import TableShell from './TableShell.vue'

const props = withDefaults(
  defineProps<{
    rows: OpenPositionRow[]
    /**
     * 单实例世界的可用性列表：长度恒为 1（适配层保证每个实例都出现）。
     * 保留成数组是为了「不可用时在表下补一行说明」这块逻辑不用改判断方式。
     */
    availability?: PositionsOut['availability']
    /** 空态文案由页面给：全部无仓 / 观察模式没在交易 是两件事，不能共用一句 */
    emptyText?: string
    busy?: boolean
  }>(),
  { availability: () => [], emptyText: '当前没有未平仓持仓', busy: false },
)

const emit = defineEmits<{ action: [row: OpenPositionRow]; detail: [row: OpenPositionRow] }>()

// 未平仓的可用性枚举与已平仓那套完全不同，文案不能共用（混了会把"凭据错"说成"库没找到"）
const AVAIL: Record<string, string> = {
  api_unreachable: '无法连接交易接口，可能未启动或端口不通',
  unauthorized: 'API 凭据被拒绝，请检查登录用户名与密码',
  timeout: '交易接口响应超时（超过 3 秒）',
  // 观察模式：端点本身是好的，是 bot 没在交易。不能并进 unknown（那会说成"原因未知"）
  not_ready: '当前未在交易模式：观察模式不连接交易所，所以没有持仓数据',
  unknown: '状态未知：未完成探测，或持仓查询失败',
}

const abnormal = computed(() => props.availability.filter((entry) => entry.available !== 'ok'))

/** 接口给 ISO Z，界面只到分钟并注明 UTC；秒留在 title 里 */
function shortTime(iso: string): string {
  return iso ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : '—'
}
</script>

<template>
  <div>
    <TableShell :empty="!props.rows.length" :dim="props.busy">
      <template #head>
        <tr>
          <th class="l">交易对</th>
          <th class="l">方向</th>
          <th>开仓价</th>
          <th>当前价</th>
          <th>未实现</th>
          <th>ROE</th>
          <th>距止损</th>
          <th>开仓时间 (UTC)</th>
          <th class="extra">数量</th>
          <th class="extra">保证金</th>
          <th class="extra l">入场标签</th>
          <th />
        </tr>
      </template>

      <template #body>
        <tr v-for="row in props.rows" :key="row.trade_id">
          <td class="l">
            <!-- 币对本身就是「看这一笔」的入口：比再加一列按钮省横向空间 -->
            <button class="pairlink" type="button" :title="`查看 ${row.pair} 的订单与自定义数据`"
              @click="emit('detail', row)">
              {{ row.pair }}
            </button>
          </td>
          <td class="l">
            {{ row.side === 'long' ? '做多' : '做空' }}
            <span v-if="row.leverage !== null" class="lev num">· {{ row.leverage }}x</span>
          </td>
          <td class="num">
            {{ price(row.open_rate) }}
            <!-- 窄屏把保证金并进这里：信息换位置，不丢 -->
            <span class="sub num">保证金 {{ money(row.stake_amount) }}</span>
          </td>
          <td class="num">{{ price(row.current_rate) }}</td>
          <td class="num" :class="tone(row.unrealized_abs)">{{ signed(row.unrealized_abs) }}</td>
          <td class="num" :class="tone(row.roe_pct)">{{ pct(row.roe_pct) }}</td>
          <td class="num">{{ pct(row.stoploss_distance_pct, 2, false) }}</td>
          <td class="num" :title="row.open_time">{{ shortTime(row.open_time) }}</td>
          <td class="num extra">{{ qty(row.amount) }}</td>
          <td class="num extra">{{ money(row.stake_amount) }}</td>
          <td class="l extra">
            <span v-if="row.enter_tag" class="tag" :title="row.enter_tag">{{ row.enter_tag }}</span>
            <span v-else class="muted">—</span>
          </td>
          <td class="act">
            <!-- 未平仓的操作是「仓位动作」（强制平仓 / 取消挂单），复盘属于已平仓 -->
            <button class="btn btn-secondary btn-sm" type="button" @click="emit('action', row)">操作</button>
          </td>
        </tr>
      </template>

      <template #empty>
        <p class="hint">{{ props.emptyText }}</p>
      </template>
    </TableShell>

    <StatePanel
      v-for="entry in abnormal"
      :key="entry.instance_id"
      class="note"
      variant="inline"
      tone="warn"
      :title="AVAIL[entry.available] ?? entry.available"
    >
      <span :title="entry.reason ?? ''">{{ entry.reason ?? '没有更多细节' }}</span>
    </StatePanel>
  </div>
</template>

<style scoped>
/* 对齐写在列定义旁边：数字列必须挂 .num（tabular-nums），否则纵向对不齐 */
th,
td {
  text-align: right;
}

.l {
  text-align: left;
}

.lev,
.muted {
  color: var(--text-tertiary);
}

/* 看起来是文本、行为是链接：表格里加实心按钮会把视觉重心从数字上挪走 */
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

.tag {
  display: inline-block;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
  color: var(--text-secondary);
}

.act {
  padding-right: 12px;
}

.note {
  margin-top: var(--space-sm);
}

.sub {
  display: none;
  margin-top: 2px;
  font-size: 11.5px;
  color: var(--text-tertiary);
}

/* ≤1439 砍列不横向滚动：滚动会把 pair 挤出视野，逐笔对照当场断掉 */
@media (max-width: 1439px) {
  .extra {
    display: none;
  }

  .sub {
    display: block;
  }
}
</style>
