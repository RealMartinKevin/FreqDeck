<script setup lang="ts">
import { LOCALES, locale, setLocale, t, type Locale } from '../i18n'

// 分段控件只给最短标签：顶栏空间有限，完整语言名放 title 里。
const LABELS: Record<Locale, string> = { 'zh-CN': '中', 'en-US': 'EN' }
const NAMES: Record<Locale, string> = { 'zh-CN': '简体中文', 'en-US': 'English' }
</script>

<template>
  <div class="locale-switch" role="group" :aria-label="t('界面语言')">
    <button
      v-for="code in LOCALES"
      :key="code"
      class="seg"
      :class="{ active: locale === code }"
      type="button"
      :aria-pressed="locale === code"
      :title="NAMES[code]"
      @click="setLocale(code)"
    >
      {{ LABELS[code] }}
    </button>
  </div>
</template>

<style scoped>
/*
 * Apple 风格分段控件：极轻的凹槽底 + 选中项白片和一层微阴影，
 * 用现有设计令牌，明暗主题自动适配。选中态不用 accent 实色——
 * 语言切换是同级偏好切换，不该抢主操作的视觉重量。
 */
.locale-switch {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--text) 6%, transparent);
}

.seg {
  position: relative;
  min-width: 32px;
  height: 28px;
  padding: 0 9px;
  border: 0;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.01em;
  line-height: 1;
  cursor: pointer;
  transition:
    background-color 0.25s var(--ease),
    color 0.25s var(--ease),
    box-shadow 0.25s var(--ease),
    transform 0.2s var(--ease);
}

/* 把点击区扩到 44px，视觉尺寸仍保持顶栏的紧凑节奏 */
.seg::after {
  content: '';
  position: absolute;
  inset: -8px -2px;
}

.seg:hover:not(.active) {
  color: var(--text);
}

.seg.active {
  background: var(--card-solid);
  color: var(--text);
  box-shadow:
    0 1px 3px rgba(0, 0, 0, 0.12),
    inset 0 0 0 0.5px var(--border);
}

.seg:active {
  transform: scale(0.94);
}

.seg:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
