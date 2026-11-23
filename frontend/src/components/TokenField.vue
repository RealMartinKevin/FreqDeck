<script setup lang="ts">
/**
 * 信号令牌控件（`app.signal_token`）。
 *
 * 这个字段与普通密钥不同：**后端只回掩码，永远看不到明文**。所以 UI 只提供三件事：
 * 看状态（已配置/未配置）、生成一枚新的、清除。
 *
 * 明文「只展示一次」的含义：
 *   - 明文由**浏览器**用 `crypto.getRandomValues(32 字节)` 生成并转 hex，
 *     只在内存里存活到用户关掉/离开本页，**不写 localStorage、不回显于任何请求参数**；
 *   - 生成后先给用户看、给复制，再由操作条的「保存」发 `PUT {app:{signal_token}}`；
 *   - 保存成功后后端只剩掩码，本地这块明文也就可以丢了——所以下面在
 *     「值变成掩码」时保留一个仅本次可见的提示块，让用户还有机会复制，
 *     但刷新/离开页面后不復存在。
 */

import { computed, ref, watch } from 'vue'
import { isRedacted } from '../api/ft/normalize'

const props = defineProps<{
  /** draft 里的当前值：掩码 / 空串 / 用户刚生成的明文 */
  value: unknown
  replaced: boolean
  error?: string | null
}>()

const emit = defineEmits<{ set: [value: string] }>()

/** 浏览器生成的明文；仅内存，刷新即失 */
const plain = ref<string | null>(null)
/** 明文已随「保存」提交过（此时值已变回掩码，但用户可能还没复制） */
const savedOnce = ref(false)
const copied = ref(false)
const dismissed = ref(false)

const current = computed(() => (typeof props.value === 'string' ? props.value : ''))
const configured = computed(() => isRedacted(current.value))
const stateLabel = computed(() => {
  if (plain.value && !dismissed.value) return savedOnce.value ? '已保存（本次可见）' : '新令牌已生成（未保存）'
  return configured.value ? '已配置' : '未配置'
})

const stateTone = computed(() => {
  if (plain.value && !dismissed.value) return 'warn'
  return configured.value ? 'up' : 'muted'
})

/**
 * 保存成功后 `value` 变回掩码：把「已提交」这件事记下来，
 * 明文块保留到用户自己关掉（或离开页面），否则用户还没来得及复制就没了。
 */
watch(configured, (isConfigured) => {
  if (isConfigured && plain.value) savedOnce.value = true
})

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

function generate(): void {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const token = toHex(bytes)
  plain.value = token
  savedOnce.value = false
  dismissed.value = false
  copied.value = false
  emit('set', token)
}

function clear(): void {
  plain.value = null
  savedOnce.value = false
  dismissed.value = false
  emit('set', '')
}

async function copy(): Promise<void> {
  const value = plain.value
  if (!value) return
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value)
    else fallbackCopy(value)
    copied.value = true
    window.setTimeout(() => (copied.value = false), 1600)
  } catch {
    fallbackCopy(value)
    copied.value = true
  }
}

function fallbackCopy(value: string): void {
  const area = document.createElement('textarea')
  area.value = value
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  document.body.appendChild(area)
  area.select()
  document.execCommand('copy')
  document.body.removeChild(area)
}

function dismissPlain(): void {
  dismissed.value = true
  savedOnce.value = false
  plain.value = null
}
</script>

<template>
  <div class="field" :class="{ invalid: !!props.error }">
    <div class="row">
      <span class="label">信号令牌</span>
      <span class="state" :class="`t-${stateTone}`">
        <i class="dot" aria-hidden="true" />
        {{ stateLabel }}
      </span>
    </div>

    <p class="hint">
      外部系统用 `<code>X-Signal-Token</code>` 头调用 `/api/v1/signal/*`。后端只存掩码，明文只在生成时可见。
    </p>

    <div v-if="plain && !dismissed" class="plain">
      <code class="token">{{ plain }}</code>
      <div class="plain-actions">
        <button class="btn btn-secondary btn-sm" type="button" @click="copy">
          {{ copied ? '已复制' : '复制' }}
        </button>
        <button class="btn btn-secondary btn-sm" type="button" @click="dismissPlain">我已保存，隐藏</button>
      </div>
      <p class="warnline">
        {{ savedOnce ? '已保存。明文只在本页可见，刷新或离开后就拿不到了——请先复制。' : '点下方「保存」后生效；明文刷新即失，请先复制。' }}
      </p>
    </div>

    <div class="actions">
      <button class="btn btn-secondary btn-sm" type="button" @click="generate">
        {{ configured ? '重新生成' : '生成令牌' }}
      </button>
      <button v-if="configured" class="btn btn-secondary btn-sm" type="button" @click="clear">清除</button>
    </div>

    <p v-if="props.error" class="err">{{ props.error }}</p>
  </div>
</template>

<style scoped>
.field {
  padding: 12px 0;
}

.invalid {
  background: color-mix(in srgb, var(--down) 4%, transparent);
  border-radius: var(--radius-inner);
  padding-inline: 10px;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.label {
  font-size: 13.5px;
  font-weight: 500;
}

.state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
}

.state .dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 2.5px color-mix(in srgb, currentColor 16%, transparent);
}

.t-up {
  color: var(--up);
}

.t-warn {
  color: var(--warn);
}

.t-muted {
  color: var(--text-tertiary);
}

.hint {
  margin-top: 6px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-tertiary);
}

.hint code {
  padding: 1px 4px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--text) 7%, transparent);
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11.5px;
}

.plain {
  margin-top: 10px;
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--warn) 24%, transparent);
  border-radius: var(--radius-inner);
  background: color-mix(in srgb, var(--warn) 6%, transparent);
}

.token {
  display: block;
  padding: 6px 8px;
  overflow-x: auto;
  border-radius: 8px;
  background: var(--card-solid);
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11.5px;
  line-height: 1.5;
  white-space: nowrap;
  user-select: all;
}

.plain-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.warnline {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--warn);
}

.actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.err {
  margin-top: 6px;
  font-size: 12.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--down);
}
</style>
