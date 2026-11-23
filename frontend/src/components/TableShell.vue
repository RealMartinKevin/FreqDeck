<script setup lang="ts">
/**
 * 两张明细表共用：滚动容器 + sticky 表头/首列 + 空态插槽。
 * 只负责结构与层级，不管对齐与配色——列定义留在各自的表里，否则这个文件会变成第二个表格库。
 */
withDefaults(defineProps<{ empty?: boolean; dim?: boolean }>(), { empty: false, dim: false })
</script>

<template>
  <div v-if="empty && $slots.empty" class="empty-slot"><slot name="empty" /></div>
  <div v-else class="shell">
    <div class="scroll" :class="{ dim }">
      <table class="tbl">
        <thead>
          <slot name="head" />
        </thead>
        <tbody>
          <slot name="body" />
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.shell {
  border: 1px solid var(--border);
  border-radius: var(--radius-inner);
  background: var(--card-solid);
  overflow: hidden;
}

.scroll {
  overflow-x: auto;
}

/* 刷新时表体降透明度而不是清空：数字原地替换才看得清哪一列变了 */
.dim {
  opacity: 0.6;
}

.tbl {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 13px;
}

/* 用 :deep 是因为 th/td 由使用方以插槽传入，不属于本组件的编译作用域 */
.tbl :deep(thead th) {
  position: sticky;
  top: 0;
  z-index: var(--z-sticky-head);
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-tertiary);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
}

.tbl :deep(tbody td) {
  padding: 10px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  white-space: nowrap;
}

.tbl :deep(tbody tr:last-child td) {
  border-bottom: none;
}

/* 首列 sticky：横向滚动时实例名必须一直在，否则跨实例比较当场断掉 */
.tbl :deep(tr > :first-child) {
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--card-solid);
  box-shadow: var(--shadow-col);
}

.tbl :deep(thead tr > :first-child) {
  z-index: calc(var(--z-sticky-head) + 1);
  background: var(--bg-tertiary);
}

.tbl :deep(tbody tr:hover td:not(:first-child)) {
  background: color-mix(in srgb, var(--text) 3%, transparent);
}

.empty-slot {
  padding: 48px var(--space-lg);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-inner);
  text-align: center;
  color: var(--text-secondary);
}
</style>
