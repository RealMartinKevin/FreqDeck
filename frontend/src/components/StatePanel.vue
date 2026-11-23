<script setup lang="ts">
/**
 * 空态 / 错误态 / 提示条的唯一样式来源。
 * 三个新页面各自都要表达"没有数据"与"取不到数据"，如果各写一套，
 * 同一个 reason 在两页会呈现成两种视觉，用户会以为是两种错误。
 *
 * block  = 整块替换内容区（空窗口、连不上、0 实例）
 * inline = 内容照常渲染，只在旁边/上方补一行说明（缺列提示、部分实例不可用）
 */
withDefaults(
  defineProps<{
    variant?: 'block' | 'inline'
    tone?: 'warn' | 'error' | 'info' | 'muted'
    /** 一句话结论。明细走默认插槽，正文只留人话，原始报错收进 title */
    title?: string
    /** 右侧动作按钮文案；不给就不渲染按钮（如 unauthorized 明确不提供重试） */
    action?: string
  }>(),
  { variant: 'block', tone: 'muted', title: '', action: '' },
)

const emit = defineEmits<{ action: [] }>()
</script>

<template>
  <div class="panel" :class="[`v-${variant}`, `t-${tone}`]" :role="tone === 'error' ? 'alert' : undefined">
    <span class="mark" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9" />
        <path v-if="tone === 'error'" d="M12 7.5v5.5M12 16.4h.01" />
        <path v-else-if="tone === 'warn'" d="M12 8v4.5M12 16.2h.01" />
        <path v-else d="M8.5 12h7" />
      </svg>
    </span>

    <div class="body">
      <p v-if="title" class="title">{{ title }}</p>
      <div v-if="$slots.default" class="detail"><slot /></div>
    </div>

    <button v-if="action" class="btn btn-secondary btn-sm act" type="button" @click="emit('action')">
      {{ action }}
    </button>
  </div>
</template>

<style scoped>
.panel {
  --tone-color: var(--text-tertiary);
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  border: 1px solid color-mix(in srgb, var(--tone-color) 20%, transparent);
  border-radius: var(--radius-inner);
  background: color-mix(in srgb, var(--tone-color) 7%, transparent);
  color: var(--text);
}

.t-warn {
  --tone-color: var(--warn);
}

.t-error {
  --tone-color: var(--down);
}

.t-info {
  --tone-color: var(--accent);
}

/* 整块替换内容区时给足留白，它是这一屏唯一的内容，不能看着像一句旁注 */
.v-block {
  flex-direction: column;
  justify-content: center;
  gap: 10px;
  padding: 56px var(--space-lg);
  border-style: dashed;
  border-radius: var(--radius-card);
  text-align: center;
}

.v-inline {
  padding: 8px 10px 8px 12px;
  font-size: 13px;
}

.mark {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  color: var(--tone-color);
}

.v-block .mark {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--tone-color) 12%, transparent);
}

.mark svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
}

.body {
  min-width: 0;
}

.title {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.v-block .title {
  font-size: 17px;
}

.detail {
  margin-top: 4px;
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--text-secondary);
}

/* 块级面板的说明文字限宽：一行 100+ 字的长句没人读 */
.v-block .detail {
  max-width: 460px;
  margin-top: 6px;
  font-size: 14px;
}

.v-inline .detail {
  margin-top: 0;
  font-size: 13px;
}

.v-inline .mark svg {
  width: 15px;
  height: 15px;
}

.act {
  flex: none;
  margin-left: auto;
}

/* 块级面板里按钮跟着内容居中，不能贴到右下角 */
.v-block .act {
  margin-left: 0;
  margin-top: 4px;
}
</style>
