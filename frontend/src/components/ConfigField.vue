<script setup lang="ts">
/**
 * 单个配置字段的渲染器：按 `ConfigFieldSpec.kind` 分派。
 *
 * 设计约束（§6.4）：
 *   - `stake_amount` 可能是**字符串** `'unlimited'`：控件二选一，提交时保持字符串，
 *     绝不 `Number('unlimited')`（会变成 NaN，后端回 422，用户看不懂）。
 *   - `minimal_roi` 的键是**字符串分钟**：行编辑器，必须含 `0`，按分钟升序，提交前转回对象。
 *   - `max_open_trades` 只能是 `-1` 或 `≥1`（`0` 会被后端拒）。
 *   - `api_server.enabled` 只读恒 true：在界面上关掉它等于把当前 UI 自己关掉。
 *   - 本地校验只做「形态预检」给即时反馈，**最终以后端 400 的原文为准**
 *     （`detail` 由页面挂到字段/分组上，这里不吞、不改写）。
 *
 * 密钥类字段一律委派给 SecretField / TokenField：掩码的「不可编辑」语义
 * 必须由专门的控件保证，普通 input 一旦把 `***redacted***` 放进 value 就会出事。
 */

import { t } from '../i18n'
import { computed, onMounted, ref, watch } from 'vue'
import type { ConfigFieldSpec } from '../api/types'
import SecretField from './SecretField.vue'
import TokenField from './TokenField.vue'

const props = defineProps<{
  field: ConfigFieldSpec
  /** draft 里的当前值 */
  value: unknown
  dirty: boolean
  error?: string | null
  /** 服务端声明该路径只能重启生效 */
  restartOnly?: boolean
  /** 密钥：用户已给出新值 */
  replaced?: boolean
}>()

const emit = defineEmits<{
  change: [path: string, value: unknown]
  replace: [path: string, value: string]
  clear: [path: string]
}>()

/** 没有异步来源的 select（`timeframe`）用静态候选：常见周期全覆盖，仍允许当前值不在表内 */
const STATIC_OPTIONS: Record<string, string[]> = {
  timeframe: ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w'],
}

const path = computed(() => props.field.path)
const isSignalToken = computed(() => path.value === 'app.signal_token')

/* ---------------- 本地编辑态 ---------------- */

const text = ref('')
const boolValue = ref(false)
const selected = ref('')
const rows = ref<{ min: string; roi: string }[]>([])
const options = ref<string[]>([])
const optionsFailed = ref(false)
const localTip = ref<string | null>(null)

function toText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

/** 数字输入 → number；空串/非有限值 → null（调用方据此决定要不要 emit） */
function parseNumber(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}

function syncFromProps(): void {
  text.value = toText(props.value)
  boolValue.value = props.value === true
  selected.value = typeof props.value === 'string' ? props.value : ''
  localTip.value = null

  if (props.field.kind === 'roi') {
    const source = props.value
    const list: { min: string; roi: string }[] = []
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
        list.push({ min: String(key), roi: toText(value) })
      }
    }
    list.sort((a, b) => Number(a.min) - Number(b.min))
    // 必须含 0：缺了就补一行空的，提示用户填，而不是替他编一个值
    if (!list.some((row) => Number(row.min) === 0)) list.unshift({ min: '0', roi: '' })
    rows.value = list
  }
}

watch(() => props.value, syncFromProps, { immediate: true })

onMounted(async () => {
  const loader = props.field.options
  if (!loader) {
    options.value = STATIC_OPTIONS[path.value] ?? []
    return
  }
  try {
    options.value = await loader()
  } catch {
    // 下拉来源失败就降级成文本框：候选拿不到不该让整页不能编辑（设计 §6.4 G2）
    optionsFailed.value = true
  }
})

const selectOptions = computed(() => {
  const list = [...options.value]
  if (selected.value && !list.includes(selected.value)) list.unshift(selected.value)
  return list
})

/* ---------------- 提交 ---------------- */

function emitText(raw: string): void {
  text.value = raw
  if (props.field.kind === 'number') {
    const parsed = parseNumber(raw)
    if (parsed === null) {
      localTip.value = raw.trim() ? t('请输入数字') : t('不能为空')
      return
    }
    localTip.value = validateNumber(parsed)
    // stoploss 允许负、max_open_trades 只能是 -1 或 ≥1：形态不合法就先不提交，
    // 但**不阻止用户继续输入**（他可能正打到一半）
    if (localTip.value) return
    emit('change', path.value, parsed)
    return
  }
  emit('change', path.value, raw)
}

function validateNumber(value: number): string | null {
  if (path.value === 'max_open_trades') {
    if (!Number.isInteger(value) || (value !== -1 && value < 1)) return t('只能是 -1（不限）或 ≥ 1 的整数')
    return null
  }
  if (path.value === 'tradable_balance_ratio') {
    if (!(value > 0) || value > 1) return t('取值应在 (0, 1] 之间，如 0.99')
    return null
  }
  if (path.value === 'stoploss') {
    if (!(value < 0) || value <= -1) return t('止损应为负数，如 -0.1 表示 -10%')
    return null
  }
  if (path.value === 'api_server.listen_port') {
    if (!Number.isInteger(value) || value < 1 || value > 65535) return t('端口应在 1-65535 之间')
    return null
  }
  return null
}

/** `stake_amount`：`'unlimited'` ↔ 数字，两者语义不同，不能互相转换 */
const stakeUnlimited = computed(() => props.value === 'unlimited')

function setStakeUnlimited(next: boolean): void {
  if (next) {
    localTip.value = null
    emit('change', path.value, 'unlimited')
    return
  }
  // 切回固定金额时给一个合法起点：0 会被后端拒，先填一个正数让用户改
  emit('change', path.value, 100)
}

function emitLines(raw: string): void {
  text.value = raw
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (path.value === 'exchange.pair_whitelist') {
    const bad = lines.find((line) => !line.includes('/'))
    localTip.value = bad ? t('「{bad}」缺少斜杠，格式应为 BASE/QUOTE（如 BTC/USDT）。最终以后端校验为准', { bad }) : null
  }
  emit('change', path.value, lines)
}

function emitBool(next: boolean): void {
  boolValue.value = next
  emit('change', path.value, next)
}

function emitSelect(next: string): void {
  selected.value = next
  emit('change', path.value, next)
}

/** ROI 行 → `{ "0": 0.1 }`：键必须是字符串分钟、按数值升序 */
function emitRoi(): void {
  const valid = rows.value.filter((row) => row.min.trim() !== '' && row.roi.trim() !== '')
  const numeric = valid
    .map((row) => ({ min: Number(row.min), roi: Number(row.roi) }))
    .filter((row) => Number.isFinite(row.min) && Number.isFinite(row.roi))

  if (!numeric.some((row) => row.min === 0)) {
    localTip.value = t('ROI 必须包含 0 分钟（持仓即开始生效的那一档）')
    return
  }
  localTip.value = null
  numeric.sort((a, b) => a.min - b.min)
  const out: Record<string, number> = {}
  for (const row of numeric) out[String(row.min)] = row.roi
  emit('change', path.value, out)
}

function addRow(): void {
  const last = rows.value[rows.value.length - 1]
  const nextMin = last ? String(Number(last.min) + 10) : '10'
  rows.value = [...rows.value, { min: nextMin, roi: '' }]
}

function removeRow(index: number): void {
  // 0 那一行不许删：删了 minimal_roi 就非法，后端会 400
  if (Number(rows.value[index]?.min) === 0) return
  rows.value = rows.value.filter((_, i) => i !== index)
  emitRoi()
}
</script>

<template>
  <!-- 密钥：掩码语义由专用控件兜住 -->
  <TokenField
    v-if="props.field.kind === 'secret' && isSignalToken"
    :value="props.value"
    :replaced="!!props.replaced"
    :error="props.error ?? null"
    @set="(value: string) => emit('replace', path, value)"
  />

  <SecretField
    v-else-if="props.field.kind === 'secret'"
    :path="path"
    :label="props.field.label"
    :value="props.value"
    :replaced="!!props.replaced"
    :hint="props.field.hint"
    :error="props.error ?? null"
    @replace="(p: string, value: string) => emit('replace', p, value)"
    @clear="(p: string) => emit('clear', p)"
  />

  <!-- 只读 -->
  <div v-else-if="props.field.kind === 'readonly'" class="field">
    <div class="head">
      <span class="label">{{ t(props.field.label) }}</span>
      <span class="ro">{{ toText(props.value) || '—' }}</span>
    </div>
    <p v-if="props.field.hint" class="hint">{{ t(props.field.hint) }}</p>
  </div>

  <!-- 布尔 -->
  <div v-else-if="props.field.kind === 'bool'" class="field">
    <div class="head">
      <label class="label check">
        <input type="checkbox" :checked="boolValue" @change="emitBool(($event.target as HTMLInputElement).checked)" />
        {{ t(props.field.label) }}
      </label>
      <span v-if="props.restartOnly" class="tag warn">{{ t('需重启') }}</span>
    </div>
    <p v-if="props.field.hint" class="hint">{{ t(props.field.hint) }}</p>
    <p v-if="props.error" class="err">{{ props.error }}</p>
  </div>

  <!-- 行列表（白名单 / 黑名单 / CORS） -->
  <div v-else-if="props.field.kind === 'lines'" class="field">
    <div class="head">
      <span class="label">{{ t(props.field.label) }}</span>
      <span v-if="props.dirty" class="tag">{{ t('已修改') }}</span>
      <span v-if="props.restartOnly" class="tag warn">{{ t('需重启') }}</span>
    </div>
    <textarea
      class="input area"
      rows="4"
      spellcheck="false"
      :value="text"
      :class="{ bad: !!props.error }"
      @input="emitLines(($event.target as HTMLTextAreaElement).value)"
    />
    <p v-if="props.field.hint" class="hint">{{ t(props.field.hint) }}</p>
    <p v-if="localTip" class="tip">{{ localTip }}</p>
    <p v-if="props.error" class="err">{{ props.error }}</p>
  </div>

  <!-- ROI 行编辑器 -->
  <div v-else-if="props.field.kind === 'roi'" class="field">
    <div class="head">
      <span class="label">{{ t(props.field.label) }}</span>
      <span v-if="props.dirty" class="tag">{{ t('已修改') }}</span>
    </div>
    <div class="roi">
      <div class="roi-head">
        <span>{{ t('持仓分钟') }}</span>
        <span>{{ t('收益率') }}</span>
        <span />
      </div>
      <div v-for="(row, index) in rows" :key="index" class="roi-row">
        <input
          class="input num"
          type="number"
          min="0"
          step="1"
          :value="row.min"
          :disabled="Number(row.min) === 0"
          @input="
            rows[index].min = ($event.target as HTMLInputElement).value;
            emitRoi()
          "
        />
        <input
          class="input num"
          type="number"
          step="0.01"
          :value="row.roi"
          placeholder="0.1"
          @input="
            rows[index].roi = ($event.target as HTMLInputElement).value;
            emitRoi()
          "
        />
        <button
          class="btn btn-secondary btn-sm"
          type="button"
          :disabled="Number(row.min) === 0"
          @click="removeRow(index)"
        >
          {{ t('删除') }}
        </button>
      </div>
      <button class="btn btn-secondary btn-sm add" type="button" @click="addRow">{{ t('添加一档') }}</button>
    </div>
    <p v-if="props.field.hint" class="hint">{{ t(props.field.hint) }}</p>
    <p v-if="localTip" class="tip">{{ localTip }}</p>
    <p v-if="props.error" class="err">{{ props.error }}</p>
  </div>

  <!-- stake_amount：'unlimited' 与数字是两种语义，二选一 -->
  <div v-else-if="path === 'stake_amount'" class="field">
    <div class="head">
      <span class="label">{{ t(props.field.label) }}</span>
      <span v-if="props.dirty" class="tag">{{ t('已修改') }}</span>
    </div>
    <div class="choices">
      <label class="choice">
        <input type="radio" :checked="stakeUnlimited" @change="setStakeUnlimited(true)" />
        unlimited{{ t('（按最大持仓数均分余额）') }}
      </label>
      <label class="choice">
        <input type="radio" :checked="!stakeUnlimited" @change="setStakeUnlimited(false)" />
        {{ t('固定金额') }}
      </label>
    </div>
    <input
      v-if="!stakeUnlimited"
      class="input num"
      type="number"
      step="any"
      :value="text"
      :class="{ bad: !!props.error }"
      @input="emitText(($event.target as HTMLInputElement).value)"
    />
    <p v-if="props.field.hint" class="hint">{{ t(props.field.hint) }}</p>
    <p v-if="props.error" class="err">{{ props.error }}</p>
  </div>

  <!-- 下拉（异步来源失败 → 降级文本） -->
  <div v-else-if="props.field.kind === 'select' && !optionsFailed" class="field">
    <div class="head">
      <span class="label">{{ t(props.field.label) }}</span>
      <span v-if="props.dirty" class="tag">{{ t('已修改') }}</span>
      <span v-if="props.restartOnly" class="tag warn">{{ t('需重启') }}</span>
    </div>
    <select class="input" :value="selected" @change="emitSelect(($event.target as HTMLSelectElement).value)">
      <option v-if="!selected" value="">{{ t('请选择') }}</option>
      <option v-for="option in selectOptions" :key="option" :value="option">{{ option }}</option>
    </select>
    <p v-if="props.field.hint" class="hint">{{ t(props.field.hint) }}</p>
    <p v-if="props.error" class="err">{{ props.error }}</p>
  </div>

  <!-- text / number / 降级后的 select -->
  <div v-else class="field">
    <div class="head">
      <span class="label">{{ t(props.field.label) }}</span>
      <span v-if="props.dirty" class="tag">{{ t('已修改') }}</span>
      <span v-if="props.restartOnly" class="tag warn">{{ t('需重启') }}</span>
    </div>
    <input
      class="input"
      :class="{ num: props.field.kind === 'number', bad: !!props.error }"
      :type="props.field.kind === 'number' ? 'number' : 'text'"
      :step="props.field.kind === 'number' ? 'any' : undefined"
      :value="text"
      spellcheck="false"
      autocomplete="off"
      @input="emitText(($event.target as HTMLInputElement).value)"
    />
    <p v-if="props.field.hint" class="hint">{{ t(props.field.hint) }}</p>
    <p v-if="localTip" class="tip">{{ localTip }}</p>
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

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.label {
  font-size: 13.5px;
  font-weight: 500;
}

.check {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.check input {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
}

.tag {
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  font-size: 11px;
  font-weight: 500;
  color: var(--accent);
}

.tag.warn {
  background: color-mix(in srgb, var(--warn) 12%, transparent);
  color: var(--warn);
}

.input.bad {
  border-color: color-mix(in srgb, var(--down) 45%, transparent);
}

.area {
  min-height: 92px;
  padding: 10px 12px;
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 13px;
  line-height: 1.6;
  resize: vertical;
}

.ro {
  margin-left: auto;
  font-size: 13px;
  color: var(--text-secondary);
}

.hint {
  margin-top: 5px;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--text-tertiary);
}

.tip {
  margin-top: 5px;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--warn);
}

.err {
  margin-top: 6px;
  font-size: 12.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--down);
}

.choices {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-bottom: 8px;
}

.choice {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
}

.choice input {
  accent-color: var(--accent);
}

.roi {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.roi-head,
.roi-row {
  display: grid;
  grid-template-columns: 120px 1fr 72px;
  gap: 8px;
  align-items: center;
}

.roi-head {
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.roi-row .btn {
  min-height: 38px;
  padding: 6px 10px;
}

.add {
  align-self: flex-start;
  margin-top: 2px;
}
</style>
