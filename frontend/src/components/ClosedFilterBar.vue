<script setup lang="ts">
import { t } from '../i18n'
import type { TradesFacets } from '../api/types'
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    exitReason: string
    pair: string
    from: string
    to: string
    limit: number
    /** 选项只来自响应 facets（过滤前全集），前端不自己拼候选值 */
    facets: TradesFacets
    busy?: boolean
  }>(),
  { busy: false },
)

const emit = defineEmits<{
  'update:exitReason': [value: string]
  'update:pair': [value: string]
  'update:from': [value: string]
  'update:to': [value: string]
  'update:limit': [value: number]
  reset: []
}>()

const PAGE_SIZES = [100, 250, 500]

const dirty = computed(
  () => !!(props.exitReason || props.pair || props.from || props.to),
)
</script>

<template>
  <div class="bar">
    <label class="field">
      <span class="label">{{ t('平仓原因') }}</span>
      <select
        class="input sel"
        :value="props.exitReason"
        :disabled="props.busy"
        @change="emit('update:exitReason', ($event.target as HTMLSelectElement).value)"
      >
        <option value="">{{ t('全部') }}</option>
        <option v-for="value in props.facets.exit_reasons" :key="value" :value="value">{{ value }}</option>
      </select>
    </label>

    <label class="field">
      <span class="label">pair</span>
      <select
        class="input sel"
        :value="props.pair"
        :disabled="props.busy"
        @change="emit('update:pair', ($event.target as HTMLSelectElement).value)"
      >
        <option value="">{{ t('全部') }}</option>
        <option v-for="value in props.facets.pairs" :key="value" :value="value">{{ value }}</option>
      </select>
    </label>

    <label class="field">
      <span class="label">{{ t('平仓日期 (UTC)') }}</span>
      <span class="range">
        <input
          class="input sel"
          type="date"
          :value="props.from"
          :disabled="props.busy"
          @change="emit('update:from', ($event.target as HTMLInputElement).value)"
        />
        <span class="dash">→</span>
        <input
          class="input sel"
          type="date"
          :value="props.to"
          :disabled="props.busy"
          @change="emit('update:to', ($event.target as HTMLInputElement).value)"
        />
      </span>
    </label>

    <label class="field">
      <span class="label">{{ t('每页') }}</span>
      <select
        class="input sel"
        :value="String(props.limit)"
        :disabled="props.busy"
        @change="emit('update:limit', Number(($event.target as HTMLSelectElement).value))"
      >
        <option v-for="size in PAGE_SIZES" :key="size" :value="String(size)">{{ size }}</option>
      </select>
    </label>

    <button class="btn btn-secondary btn-sm reset" type="button" :disabled="props.busy || !dirty" @click="emit('reset')">
      {{ t('重置') }}
    </button>
  </div>
</template>

<style scoped>
.bar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--space-md);
  margin-bottom: var(--space-md);
}

.field {
  display: flex;
  flex-direction: column;
}

.label {
  margin-bottom: 6px;
}

.sel {
  width: auto;
  min-width: 120px;
  min-height: 36px;
  padding: 7px 10px;
  font-size: 13px;
}

.range {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.dash {
  color: var(--text-tertiary);
}

.reset {
  margin-left: auto;
  min-height: 36px;
}
</style>
