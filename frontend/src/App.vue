<template>
  <RouterView />
  <!--
    GPL-3.0 归属声明：本项目是 freqtrade 的衍生作品，界面里保留指向上游的署名。
    刻意做得低调（次要色、12px、非粘性），不影响任何页面读数据。
  -->
  <footer class="power-footer">
    Powered by
    <a href="https://github.com/freqtrade/freqtrade" target="_blank" rel="noopener noreferrer">Freqtrade</a>
  </footer>
</template>

<style scoped>
.power-footer {
  padding: var(--space-lg) var(--space-md) var(--space-xl);
  text-align: center;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-tertiary);
}

.power-footer a {
  color: inherit;
  text-decoration: none;
  border-bottom: 1px solid var(--border-strong);
}

.power-footer a:hover {
  color: var(--text-secondary);
}
</style>
