<script setup lang="ts">
/**
 * `last_error` 警示条。
 *
 * 为什么原文必须**一字不改**：这是后端把「交易所密钥错」「策略 import 失败」
 * 「pairlist 加载超时」全部折叠进同一个字符串的唯一通道。前端一旦改写、
 * 只取第一行、或者把 traceback 过滤掉，用户就失去了唯一能定位问题的信息。
 * 所以这里只做**显示层折叠**（默认 3 行），文本本身原样保留，复制出来与后端一致。
 *
 * 为什么默认折叠而不是直接展开：last_error 里常带完整 traceback，展开会把首屏
 * 挤成一屏代码；但「看不到内容」和「看不到全部内容」是两回事——所以有展开按钮。
 *
 * 切换模式期间不显示：那时 `last_error` 是上一次尝试留下的旧值，
 * 在重启过程中挂着一条红字，会被读成「这次也失败了」。
 */

import { t } from '../i18n'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useAppMode } from '../composables/useAppMode'

const props = defineProps<{
  /** 覆盖 store 里的 `last_error`（测试/预览用）；不传则读 store */
  error?: string | null
  /** 重试：由页面决定重试什么（重新取数 or 再切一次模式） */
  retryLabel?: string
}>()

const emit = defineEmits<{ retry: []; goConfig: []; goOps: [] }>()

const { lastError, isSwitching } = useAppMode()

/** 折叠时显示的行数：3 行足够看出「是什么错」，又不至于占掉首屏 */
const COLLAPSED_LINES = 3

const text = computed(() => {
  const raw = props.error === undefined ? lastError.value : props.error
  return typeof raw === 'string' && raw.trim() ? raw : ''
})

const visible = computed(() => text.value.length > 0 && !isSwitching.value)

const expanded = ref(false)
const overflowing = ref(false)
const copied = ref(false)
const bodyEl = ref<HTMLElement | null>(null)

/**
 * 判断「折叠后是否还有内容被藏起来」。
 * 用 `scrollHeight` 对比 `line-height × 行数`：这两种量在展开/折叠态下都成立，
 * 不必先切回折叠态再量（那样会闪一下）。
 */
function measure(): void {
  const el = bodyEl.value
  if (!el) {
    overflowing.value = false
    return
  }
  const style = window.getComputedStyle(el)
  const lineHeight = Number.parseFloat(style.lineHeight)
  const perLine = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 18
  overflowing.value = el.scrollHeight > perLine * COLLAPSED_LINES + 2
}

onMounted(() => {
  void nextTick(measure)
})

watch(text, () => {
  expanded.value = false
  copied.value = false
  void nextTick(measure)
})

watch(expanded, () => {
  void nextTick(measure)
})

async function copy(): Promise<void> {
  const value = text.value
  if (!value) return
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
    } else {
      copyByTextarea(value)
    }
    copied.value = true
    window.setTimeout(() => {
      copied.value = false
    }, 1600)
  } catch {
    // 非安全上下文（http + 非 localhost）下 clipboard 不可用：退回 execCommand
    try {
      copyByTextarea(value)
      copied.value = true
      window.setTimeout(() => {
        copied.value = false
      }, 1600)
    } catch {
      copied.value = false
    }
  }
}

function copyByTextarea(value: string): void {
  const area = document.createElement('textarea')
  area.value = value
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  document.execCommand('copy')
  document.body.removeChild(area)
}
</script>

<template>
  <section v-if="visible" class="banner" role="alert">
    <div class="head">
      <span class="mark" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7.5v5.5M12 16.4h.01" />
        </svg>
      </span>
      <div class="titles">
        <p class="title">{{ t('后端报告的错误') }}</p>
        <p class="sub">{{ t('这是 freqtrade 返回的原文，未做任何改写；需要排查时请完整复制。') }}</p>
      </div>
      <div class="head-actions">
        <button class="btn btn-secondary btn-sm" type="button" @click="copy">
          {{ copied ? t('已复制') : t('复制原文') }}
        </button>
        <button
          v-if="overflowing"
          class="btn btn-secondary btn-sm"
          type="button"
          :aria-expanded="expanded"
          @click="expanded = !expanded"
        >
          {{ expanded ? t('收起') : t('展开全部') }}
        </button>
      </div>
    </div>

    <pre ref="bodyEl" class="raw" :class="{ clamped: !expanded }">{{ text }}</pre>

    <div class="foot">
      <button class="btn btn-secondary btn-sm" type="button" @click="emit('retry')">
        {{ props.retryLabel ?? t('重试') }}
      </button>
      <button class="btn btn-secondary btn-sm" type="button" @click="emit('goConfig')">{{ t('去配置') }}</button>
      <button class="btn btn-secondary btn-sm" type="button" @click="emit('goOps')">{{ t('看日志') }}</button>
      <span class="hint">{{ t('改完配置后需要重新切换模式才会生效。') }}</span>
    </div>
  </section>
</template>

<style scoped>
.banner {
  padding: 14px 16px 12px;
  border: 1px solid color-mix(in srgb, var(--down) 24%, transparent);
  border-radius: var(--radius-inner);
  background: color-mix(in srgb, var(--down) 6%, transparent);
}

.head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.mark {
  display: flex;
  flex: none;
  color: var(--down);
}

.mark svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.titles {
  min-width: 0;
}

.title {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.sub {
  margin-top: 2px;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--text-secondary);
}

.head-actions {
  display: flex;
  flex: none;
  gap: 6px;
  margin-left: auto;
}

/* 原文容器：等宽、可选中、自动换行；折叠只裁高度，绝不裁字符 */
.raw {
  max-height: 340px;
  margin: 10px 0 0;
  padding: 10px 12px;
  overflow: auto;
  border-radius: var(--radius-inner);
  border: 1px solid color-mix(in srgb, var(--down) 16%, transparent);
  background: var(--card-solid);
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}

.raw.clamped {
  /* 3 行 × 1.55 行高 + 上下内边距：折叠态只露出开头，用户能看出是什么错 */
  max-height: calc(3 * 1.55em + 20px);
  overflow: hidden;
}

.foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.hint {
  font-size: 12.5px;
  color: var(--text-tertiary);
}

@media (max-width: 640px) {
  .head {
    flex-wrap: wrap;
  }

  .head-actions {
    margin-left: 0;
  }
}
</style>
