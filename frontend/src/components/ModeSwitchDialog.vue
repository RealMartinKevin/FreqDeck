<script setup lang="ts">
/**
 * 模式切换确认 + 中断期进度 + 四结局。
 *
 * 关键约束（设计 §7）：
 *   - 实盘（`dry_run === false`）切到交易模式时，必须键入精确大写 `LIVE` 才可点确认。
 *     不做勾选框：勾选是「顺手点一下」，键入是「我知道我在做什么」。
 *   - 进度文案固定「正在重启进程（约 5–15 秒）」，并且**期间不弹任何全局网络错误**
 *     ——重启时 fetch 必然失败，那不是故障，是过程。
 *   - 结局必须诚实：`accepted:false`、回退（last_error）、连不上，三种结论三种文案，
 *     绝不把它们都说成「切换成功」。
 */

import { computed, ref, watch } from 'vue'
import Modal from './Modal.vue'
import StatePanel from './StatePanel.vue'
import { SWITCH_PROGRESS_TEXT } from '../api/client'
import type { AppMode } from '../api/types'
import { useAppMode } from '../composables/useAppMode'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; goOps: []; goConfig: [] }>()

const { state, switchState, beginConfirm, resetSwitch, switchTo } = useAppMode()

/** 目标模式：现在在交易模式就回观察，否则去交易 */
const target = computed<AppMode>(() => (state.mode === 'trade' ? 'shell' : 'trade'))

const goingLive = computed(() => target.value === 'trade')
const toLiveCaption = computed(() => (state.dryRun === false ? '进入交易模式（实盘）' : '进入交易模式（模拟）'))
const title = computed(() => (goingLive.value ? toLiveCaption.value : '返回观察模式'))

/** 实盘确认：只有 dry_run 明确为 false 时才要求键入，未知(false? null)时不拦 */
const needsLiveTyping = computed(() => goingLive.value && state.dryRun === false)
const typed = ref('')
const canConfirm = computed(() => !needsLiveTyping.value || typed.value === 'LIVE')

const phase = computed(() => switchState.phase)
const busy = computed(() => phase.value === 'switching' || phase.value === 'slow')

watch(
  () => props.open,
  (open) => {
    if (open) {
      typed.value = ''
      resetSwitch()
    }
  },
)

async function confirm() {
  if (!canConfirm.value || busy.value) return
  beginConfirm(target.value)
  await switchTo(target.value)
}

function close() {
  // 切换进行中不允许关闭：关了也仍在重启，重开时看不到进度反而更慌
  if (busy.value) return
  resetSwitch()
  emit('close')
}
</script>

<template>
  <Modal :open="open" @close="close">
    <div class="head">
      <h2 class="title">{{ title }}</h2>
      <button class="x" type="button" aria-label="关闭" :disabled="busy" @click="close">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" /></svg>
      </button>
    </div>

    <!-- 确认态：说明会发生什么 -->
    <template v-if="phase === 'idle' || phase === 'confirming'">
      <p class="lead">
        <template v-if="goingLive">
          进程会重启并开始连接交易所。重启期间（约 5–15 秒）本页面会短暂失去连接，这是正常过程。
        </template>
        <template v-else>
          进程会重启为观察模式：只保留 API 与界面，<b>不再连接交易所、不产生交易数据</b>。已有持仓不会被平掉。
        </template>
      </p>

      <StatePanel v-if="goingLive && state.dryRun === false" variant="inline" tone="warn" title="这是实盘">
        实盘模式下每一次下单都会使用真实资金。确认请在下方键入 <code>LIVE</code>。
      </StatePanel>

      <label v-if="needsLiveTyping" class="live">
        <span class="label">键入 LIVE 以确认</span>
        <input v-model="typed" class="input" type="text" placeholder="LIVE" autocomplete="off" spellcheck="false" />
      </label>

      <div class="actions">
        <button class="btn btn-secondary" type="button" @click="close">取消</button>
        <button
          class="btn"
          :class="goingLive && state.dryRun === false ? 'btn-danger' : 'btn-primary'"
          type="button"
          :disabled="!canConfirm"
          @click="confirm"
        >
          {{ title }}
        </button>
      </div>
    </template>

    <!-- 进行中：只给进度，不给任何红色错误 -->
    <template v-else-if="busy">
      <div class="progress">
        <span class="spinner" aria-hidden="true" />
        <div>
          <p class="ptitle">{{ SWITCH_PROGRESS_TEXT }}</p>
          <p class="psub">已等待 {{ Math.round(switchState.elapsedMs / 1000) }} 秒 · 期间不显示网络错误</p>
        </div>
      </div>
      <p v-if="phase === 'slow'" class="lead">
        进程已经切到目标模式，但还没开始交易。可能在加载策略或交易所响应慢，仍在继续等待。
      </p>
    </template>

    <!-- 成功 -->
    <template v-else-if="phase === 'success'">
      <StatePanel variant="inline" tone="info" title="已切换">
        现在是{{ state.mode === 'trade' ? (state.dryRun === false ? '交易模式（实盘）' : '交易模式（模拟）') : '观察模式' }}。
      </StatePanel>
      <div class="actions">
        <button class="btn btn-primary" type="button" @click="close">完成</button>
      </div>
    </template>

    <!-- 慢启动 -->
    <template v-else-if="phase === 'slow'">
      <StatePanel variant="inline" tone="warn" title="启动很慢">
        进程已在目标模式，但还没开始交易。去运维页看日志能知道卡在哪一步。
      </StatePanel>
      <div class="actions">
        <button class="btn btn-secondary" type="button" @click="close">关闭</button>
        <button class="btn btn-primary" type="button" @click="emit('goOps')">去运维</button>
      </div>
    </template>

    <!-- 回退失败：原文照展示 -->
    <template v-else-if="phase === 'reverted'">
      <StatePanel variant="inline" tone="error" title="启动失败，已回退到观察模式" />
      <pre class="raw">{{ switchState.message }}</pre>
      <div class="actions">
        <button class="btn btn-secondary" type="button" @click="close">关闭</button>
        <button class="btn btn-secondary" type="button" @click="emit('goConfig')">去配置</button>
        <button class="btn btn-primary" type="button" @click="confirm">重试</button>
      </div>
    </template>

    <!-- 连不上 -->
    <template v-else>
      <StatePanel variant="inline" tone="error" title="仍未恢复">
        刷新页面重试；如果进程已退出，请到启动它的终端查看日志。
      </StatePanel>
      <div class="actions">
        <button class="btn btn-secondary" type="button" @click="emit('goOps')">去运维</button>
        <button class="btn btn-primary" type="button" @click="close">关闭</button>
      </div>
    </template>
  </Modal>
</template>

<style scoped>
.head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-md);
  margin-bottom: var(--space-md);
}

.title {
  font-size: 19px;
  font-weight: 600;
  letter-spacing: -0.015em;
}

.x {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  margin-left: auto;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
}

.x:hover:not(:disabled) {
  background: color-mix(in srgb, var(--text) 7%, transparent);
  color: var(--text);
}

.x:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.x svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
}

.lead {
  margin: 0 0 var(--space-md);
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.live {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: var(--space-md) 0 0;
}

.label {
  font-size: 12.5px;
  color: var(--text-secondary);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-sm);
  margin-top: var(--space-lg);
}

.progress {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  padding: var(--space-md);
  border-radius: var(--radius-inner);
  background: color-mix(in srgb, var(--accent) 7%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 18%, transparent);
}

.ptitle {
  font-size: 14px;
  font-weight: 550;
}

.psub {
  margin-top: 2px;
  font-size: 12.5px;
  color: var(--text-tertiary);
}

.spinner {
  width: 18px;
  height: 18px;
  flex: none;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--accent) 25%, transparent);
  border-top-color: var(--accent);
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* 后端原文：等宽、可换行、可选中复制，绝不截断 */
.raw {
  max-height: 180px;
  margin: var(--space-sm) 0 0;
  padding: var(--space-sm);
  overflow: auto;
  border-radius: var(--radius-inner);
  border: 1px solid var(--border);
  background: var(--bg-secondary);
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}

code {
  padding: 1px 5px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--text) 8%, transparent);
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12.5px;
}
</style>
