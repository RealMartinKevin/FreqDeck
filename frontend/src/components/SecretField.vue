<script setup lang="ts">
/**
 * 密钥字段的三态控件（未配置 / 已配置（掩码）/ 用户填入新值）。
 *
 * 为什么不能做成普通 input：
 *   后端把已配置的密钥回成 `***redacted***`。若把它渲染进 input 让用户「顺便改改」，
 *   用户一动别的字段再保存，这串掩码就会被当成新值提交，**把真密钥覆盖成字面量**，
 *   下次登录 / 连交易所直接失败。所以：
 *     - 已配置时**只显示状态**，不把值放进可编辑控件；
 *     - 只有用户明确点「更换」并确认后，才 `emit('replace')` 把明文写进 draft，
 *       同时通知上层把这个 path 记进 `secretsReplaced`（掩码豁免的唯一来源）。
 *   未配置时后端回的是空串（不是掩码），所以「有值」要同时排除 `''` 与掩码。
 */

import { computed, ref, watch } from 'vue'
import { isRedacted } from '../api/ft/normalize'

const props = defineProps<{
  path: string
  label: string
  /** draft 里的当前值：`***redacted***` / `''` / 用户新值 */
  value: unknown
  /** 上层记录「用户已给出新值」（保存后生效） */
  replaced: boolean
  hint?: string
  error?: string | null
}>()

const emit = defineEmits<{
  replace: [path: string, value: string]
  clear: [path: string]
}>()

/** 允许「清除」的密钥：后端支持置空，其余密钥清空等于把交易所踢下线 */
const CLEARABLE = new Set(['app.signal_token', 'api_server.ws_token'])

const editing = ref(false)
const typed = ref('')

const text = computed(() => (typeof props.value === 'string' ? props.value : ''))
const configured = computed(() => isRedacted(text.value))
const hasPlain = computed(() => text.value !== '' && !isRedacted(text.value))
const clearable = computed(() => CLEARABLE.has(props.path) && (configured.value || hasPlain.value))

const stateLabel = computed(() => {
  if (props.replaced && hasPlain.value) return '已填入新值（保存后生效）'
  if (configured.value) return '已配置'
  if (hasPlain.value) return '已填入新值（保存后生效）'
  return '未配置'
})

const stateTone = computed(() => {
  if (props.replaced && hasPlain.value) return 'warn'
  if (configured.value) return 'up'
  return 'muted'
})

// 保存成功后上层会重新拉配置：此时值变回掩码，编辑态必须退出，否则输入框里还留着旧明文
watch(
  () => props.value,
  (next) => {
    if (isRedacted(next)) {
      editing.value = false
      typed.value = ''
    }
  },
)

function startEdit(): void {
  editing.value = true
  typed.value = ''
}

function cancelEdit(): void {
  editing.value = false
  typed.value = ''
}

function commit(): void {
  const value = typed.value.trim()
  if (!value) return
  emit('replace', props.path, value)
  editing.value = false
  typed.value = ''
}

function clear(): void {
  emit('clear', props.path)
}
</script>

<template>
  <div class="field" :class="{ invalid: !!props.error }">
    <div class="row">
      <span class="label">{{ props.label }}</span>
      <span class="state" :class="`t-${stateTone}`">
        <i class="dot" aria-hidden="true" />
        {{ stateLabel }}
      </span>
    </div>

    <div v-if="editing" class="editor">
      <input
        v-model="typed"
        class="input"
        :type="'text'"
        autocomplete="off"
        spellcheck="false"
        :placeholder="`新的${props.label}`"
        @keydown.enter.prevent="commit"
        @keydown.esc.prevent="cancelEdit"
      />
      <button class="btn btn-primary btn-sm" type="button" :disabled="!typed.trim()" @click="commit">确定</button>
      <button class="btn btn-secondary btn-sm" type="button" @click="cancelEdit">取消</button>
    </div>

    <div v-else class="actions">
      <button class="btn btn-secondary btn-sm" type="button" @click="startEdit">
        {{ configured ? '更换' : '设置' }}
      </button>
      <button v-if="clearable" class="btn btn-secondary btn-sm" type="button" @click="clear">清除</button>
      <span v-if="props.hint" class="hint">{{ props.hint }}</span>
    </div>

    <p v-if="props.error" class="err">{{ props.error }}</p>
  </div>
</template>

<style scoped>
.field {
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}

.field:last-child {
  border-bottom: none;
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

.editor {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.editor .input {
  flex: 1;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.hint {
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--text-tertiary);
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
