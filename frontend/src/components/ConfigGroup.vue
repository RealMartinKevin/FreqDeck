<script setup lang="ts">
import { t } from '../i18n'

/**
 * 配置页的分组卡片：锚点 id + 组级错误挂载点。
 *
 * 为什么错误要挂在**组**上而不只是字段上：后端 400 的 `detail` 常常一口气说
 * 好几个键（如白名单里某一对不合法），逐字段拆解会丢信息；而全挂在页面顶部，
 * 用户就得自己在 30 个字段里找。组是「一眼能扫到」的最小单位。
 */

const props = defineProps<{
  /** 锚点 id（对应左侧导航的 `#group-xxx`） */
  id: string
  title: string
  desc?: string
  /** 该组内任一字段被后端拒绝时的原文 */
  error?: string | null
  /** 组内未保存字段数：>0 时标题旁出现圆点 */
  dirtyCount?: number
}>()
</script>

<template>
  <section :id="`group-${props.id}`" class="card group">
    <header class="head">
      <div class="titles">
        <h2 class="title">
          {{ t(props.title) }}
          <span v-if="(props.dirtyCount ?? 0) > 0" class="count" :title="t('{n} 项未保存', { n: props.dirtyCount ?? 0 })">
            {{ props.dirtyCount }}
          </span>
        </h2>
        <p v-if="props.desc" class="desc">{{ t(props.desc) }}</p>
      </div>
    </header>

    <p v-if="props.error" class="err" role="alert">{{ props.error }}</p>

    <div class="body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.group {
  padding: var(--space-md) var(--space-lg) var(--space-sm);
  /* 顶栏 64px + 一点余量：锚点跳转时标题不能被 sticky 顶栏盖住 */
  scroll-margin-top: 84px;
}

.head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-sm);
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
}

.title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
}

.desc {
  margin-top: 3px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-tertiary);
}

.err {
  margin-top: 10px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--down) 24%, transparent);
  border-radius: var(--radius-inner);
  background: color-mix(in srgb, var(--down) 6%, transparent);
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--down);
  user-select: text;
}

.body {
  display: flex;
  flex-direction: column;
}
</style>
