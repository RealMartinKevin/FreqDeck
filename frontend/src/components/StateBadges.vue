<script setup lang="ts">
import { computed } from 'vue'
import type { ApiState, BotState, ProcessState } from '../api/types'

const props = defineProps<{
  process: ProcessState
  api: ApiState
  bot: BotState
}>()

type Tone = 'up' | 'down' | 'warn' | 'muted'

interface Badge {
  label: string
  tone: Tone
  title: string
}

/**
 * 三枚状态徽章（进程 / API / 交易）。
 *
 * 措辞是**事实陈述**，不带「由本系统托管」这类语义：单实例改造后本控制台
 * 不再托管 freqtrade 进程（它是用户自己起的长运行实例），说成托管会误导用户
 * 去这里找「重启进程」的按钮。
 *
 * 同时避开「启动 / 停止」：`stopped` 是「未在交易」，不是「服务停了」——
 * 观察模式下的进程一直活着，只是没连交易所。
 */
const PROCESS: Record<ProcessState, Badge> = {
  running: { label: '运行中', tone: 'up', title: '进程：freqtrade 进程正在运行' },
  exited: { label: '已退出', tone: 'down', title: '进程：进程已退出（可能崩溃或被外部中断）' },
  unknown: { label: '未知', tone: 'warn', title: '进程：暂时无法确定进程状态' },
  not_managed: { label: '外部进程', tone: 'muted', title: '进程：该进程由外部自行启动，本控制台不参与其进程管理' },
}

const API: Record<ApiState, Badge> = {
  // unknown 是「还没测过」，不是失败：用中性灰，避免每次重启都闪一片假红灯
  unknown: { label: '检测中', tone: 'muted', title: 'API：尚未完成首次探测' },
  ok: { label: '正常', tone: 'up', title: 'API：Freqtrade REST API 可正常访问' },
  unreachable: { label: '不可达', tone: 'down', title: 'API：连接不上 Freqtrade REST API' },
  unauthorized: { label: '凭据无效', tone: 'warn', title: 'API：用户名或密码被拒绝' },
  error: { label: '异常', tone: 'warn', title: 'API：请求返回错误' },
}

const BOT: Record<BotState, Badge> = {
  running: { label: '正在交易', tone: 'up', title: '交易：策略正在运行并允许开仓' },
  paused: { label: '暂停开仓', tone: 'warn', title: '交易：策略运行中，但暂停开新仓' },
  stopped: { label: '未在交易', tone: 'down', title: '交易：策略未在交易，不会开仓（观察模式属正常）' },
  unknown: { label: '未知', tone: 'muted', title: '交易：暂时无法确定交易状态' },
}

const badges = computed<Badge[]>(() => [
  PROCESS[props.process] ?? PROCESS.unknown,
  API[props.api] ?? API.error,
  BOT[props.bot] ?? BOT.unknown,
])
</script>

<template>
  <div class="badges">
    <span
      v-for="b in badges"
      :key="b.label + b.title"
      class="badge"
      :class="`t-${b.tone}`"
      :title="b.title"
    >
      <i class="dot" />
      {{ b.label }}
    </span>
  </div>
</template>

<style scoped>
.badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* 三枚并列，视觉权重一致：任何一个都不该比另外两个更抢眼 */
.badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px 3px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  font-size: 11.5px;
  font-weight: 500;
  letter-spacing: 0;
  line-height: 1.5;
  white-space: nowrap;
}

.dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 2.5px color-mix(in srgb, currentColor 16%, transparent);
}

.t-up {
  color: var(--up);
  background: color-mix(in srgb, var(--up) 8%, transparent);
  border-color: color-mix(in srgb, var(--up) 16%, transparent);
}

.t-down {
  color: var(--down);
  background: color-mix(in srgb, var(--down) 8%, transparent);
  border-color: color-mix(in srgb, var(--down) 16%, transparent);
}

.t-warn {
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 9%, transparent);
  border-color: color-mix(in srgb, var(--warn) 18%, transparent);
}

.t-muted {
  color: var(--text-tertiary);
  background: color-mix(in srgb, var(--text) 5%, transparent);
  border-color: color-mix(in srgb, var(--text) 8%, transparent);
}
</style>
