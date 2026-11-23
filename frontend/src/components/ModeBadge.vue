<script setup lang="ts">
/**
 * 四态模式徽章（灰观察 / 绿模拟 / 红实盘 / 黄启动中）。
 *
 * 判定逻辑**不在这里**：`describeMode()` 是唯一来源（`ft/mode.ts`），
 * 看板模式条、弹窗、顶栏读的是同一个函数，避免三处各判一次、各自算错一种组合。
 *
 * 注意：这里**不出现「启动」「停止」**。进程是否活着不是用户能操作的对象，
 * 用户能改变的只有「模式」；说成启停开关必然引出「我点了启动但没在交易」的疑问。
 */

import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAppMode } from '../composables/useAppMode'
import ModeSwitchDialog from './ModeSwitchDialog.vue'

const { badge, isSwitching } = useAppMode()
const router = useRouter()

const open = ref(false)

const hint = computed(() => (badge.value.tone === 'muted' ? '点击切换模式' : badge.value.title))

function onClose() {
  open.value = false
}

function goOps() {
  open.value = false
  void router.push('/ops')
}

/**
 * 「去配置」：配置页属于后续批次，路由还没注册时退到运维页——
 * 那里有日志，能直接看到启动失败的原因。**不做成死按钮**：点了没反应
 * 会被当成界面坏了。
 */
function goConfigure() {
  open.value = false
  const resolved = router.resolve('/config')
  void router.push(resolved.matched.length > 0 ? '/config' : '/ops')
}
</script>

<template>
  <div class="wrap">
    <button
      class="badge"
      :class="[`t-${badge.tone}`, { switching: isSwitching }]"
      type="button"
      :title="hint"
      @click="open = true"
    >
      <i class="dot" aria-hidden="true" />
      <span class="label">{{ badge.label }}</span>
      <svg class="chev" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9 6l6 6-6 6" />
      </svg>
    </button>

    <ModeSwitchDialog :open="open" @close="onClose" @go-ops="goOps" @go-config="goConfigure" />
  </div>
</template>

<style scoped>
.wrap {
  display: inline-flex;
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px 5px 9px;
  border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, currentColor 8%, transparent);
  font-size: 12.5px;
  font-weight: 550;
  letter-spacing: -0.005em;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 0.2s var(--ease), border-color 0.2s var(--ease);
}

.badge:hover {
  background: color-mix(in srgb, currentColor 14%, transparent);
}

.badge:focus-visible {
  outline: 2px solid color-mix(in srgb, currentColor 40%, transparent);
  outline-offset: 2px;
}

/* 灰 = 观察；绿 = 模拟；红 = 实盘（风险，不是亏损）；黄 = 启动中 */
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

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 2.5px color-mix(in srgb, currentColor 18%, transparent);
}

.label {
  color: var(--text);
}

.t-muted .label {
  color: var(--text-secondary);
}

.chev {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.6;
}

/* 切换中：呼吸一下，表示这条命令还在进行（不会假装已经切好） */
.switching .dot {
  animation: pulse 1.2s var(--ease) infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
</style>
