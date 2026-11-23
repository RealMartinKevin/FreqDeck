<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api/client'
import { useAppMode } from '../composables/useAppMode'
import { t } from '../i18n'
import ModeBadge from './ModeBadge.vue'
import LocaleSwitch from './LocaleSwitch.vue'

const props = withDefaults(
  defineProps<{
    /** 页面自己的「数据更新于 X 秒前」文案；不传则整块不占位 */
    updated?: string
    /** 刷新进行中，图标转一圈作为反馈（各页面的 loading 状态由页面自己持有） */
    busy?: boolean
  }>(),
  { updated: '', busy: false },
)

const emit = defineEmits<{ refresh: [] }>()

const route = useRoute()
const router = useRouter()

// 模式是全局状态：定时器由 store 自己保证幂等（多页面挂载/卸载不会叠加），
// 因此这里只在挂载时声明「我要这个数据」，不需要在卸载时停掉它。
const { startPolling } = useAppMode()
onMounted(() => {
  startPolling()
})

// 胶囊由路由表 meta.nav 生成：导航标签只写一次，加页面时不会漏改导航。
// meta.nav 存的是中文原文（i18n key），渲染时才翻译，切换语言无需重建路由。
// getRoutes() 保留注册顺序，因此这里的顺序 = router.ts 里的定义顺序。
const navs = computed(() =>
  router
    .getRoutes()
    .filter((r) => typeof r.meta.nav === 'string')
    .map((r) => ({ path: r.path, label: r.meta.nav as string })),
)

// 主题在 index.html 首帧前已按 localStorage 应用过，这里只读取当前值与切换
function initialTheme(): 'light' | 'dark' {
  const forced = document.documentElement.dataset.theme
  if (forced === 'light' || forced === 'dark') return forced
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

const theme = ref<'light' | 'dark'>(initialTheme())

function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = theme.value
  try {
    localStorage.setItem('ftm-theme', theme.value)
  } catch {
    /* 隐私模式下 localStorage 不可用，忽略 */
  }
}

/**
 * 登出：freqtrade 没有 logout 端点，**清本地令牌就是登出**。
 * 不再打任何网络请求——观察模式下后端可能正在重启，一个必然失败的请求
 * 会让「退出登录」看起来像坏了。
 */
async function logout() {
  await api.logout()
  await router.push('/login')
}
</script>

<template>
  <header class="topbar">
    <div class="bar">
      <div class="brand-block">
        <RouterLink class="brand" to="/">{{ t('Freqtrade 控制台') }}</RouterLink>
        <!-- 更新时间从 flex 流中移除，绝对定位在品牌名下方：不占用水平空间，
             导航/工具区位置恒定，数字变长也不会把右侧菜单顶走 -->
        <span v-if="props.updated" class="updated num">{{ props.updated }}</span>
      </div>

      <nav class="nav" :aria-label="t('主导航')">
        <RouterLink
          v-for="n in navs"
          :key="n.path"
          :to="n.path"
          class="pill"
          :class="{ active: route.path === n.path }"
          :aria-current="route.path === n.path ? 'page' : undefined"
        >
          {{ t(n.label) }}
        </RouterLink>
      </nav>

      <div class="tools">
        <!-- 模式徽章常驻顶栏：任何页面都能一眼看出「现在到底在干什么」 -->
        <ModeBadge class="mode-badge" />

        <button
          class="icon-btn"
          type="button"
          :title="t('刷新')"
          :aria-label="t('刷新')"
          @click="emit('refresh')"
        >
          <svg :class="{ spin: props.busy }" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4" />
          </svg>
        </button>

        <button
          class="icon-btn theme"
          type="button"
          :title="theme === 'dark' ? t('切换到浅色') : t('切换到深色')"
          :aria-label="t('切换主题')"
          @click="toggleTheme"
        >
          <svg v-if="theme === 'dark'" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
          </svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
          </svg>
        </button>

        <LocaleSwitch class="locale" />

        <button class="btn btn-secondary btn-sm" type="button" @click="logout">
          {{ t('退出登录') }}
        </button>
      </div>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  position: sticky;
  top: 0;
  z-index: var(--z-topbar);
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg) 76%, transparent);
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
}

.bar {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  max-width: 1180px;
  /* 高度自适应：有更新时间下标时两行内容（品牌+下标）总高约 40px，
     由 min-height 直接容纳并垂直居中，导航胶囊 y 恒定不跳 */
  min-height: 64px;
  padding: 0 var(--space-lg);
  margin: 0 auto;
}

.brand-block {
  /* 作为更新时间的定位锚点，但它自身仍参与 flex 流（只有品牌名占水平空间） */
  position: relative;
  display: flex;
  align-items: baseline;
  min-width: 0;
  /* 两行内容块的实际高度，交给父级 .bar 的 align-items:center 垂直居中 */
}

/* 32px 的标题栏在数据页上会喧宾夺主，压到 21px 让数字成为视觉主体 */
.brand {
  font-size: 21px;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.2;
  color: var(--text);
  text-decoration: none;
  white-space: nowrap;
}

/* 更新时间：绝对定位在品牌名正下方，作为品牌的下标副题。
   脱离 flex 流 → 不占水平空间 → 右侧导航/工具区位置恒定，
   数字位数变化（1s→10s→100s）也不会引起任何位移。
   与品牌名右缘对齐；过长时向左截断，同样不推挤两侧。 */
.updated {
  position: absolute;
  top: 100%;
  right: 0;
  max-width: 240px;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  line-height: 1;
  color: var(--text-tertiary);
  white-space: nowrap;
  pointer-events: none;
}

.nav {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  margin-left: var(--space-sm);
}

.pill {
  padding: 6px 13px;
  border-radius: var(--radius-pill);
  font-size: 14px;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--text-secondary);
  text-decoration: none;
  white-space: nowrap;
  transition: background-color 0.2s var(--ease), color 0.2s var(--ease);
}

.pill:hover {
  background: color-mix(in srgb, var(--text) 6%, transparent);
  color: var(--text);
}

/* 选中态用 accent 文字 + 淡底：胶囊之间是同级切换，不该有主按钮那种重量 */
.pill.active {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}

.tools {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  margin-left: auto;
}

/* 徽章不参与压缩：它是顶栏里唯一「必须完整可读」的元素 */
.mode-badge {
  flex: none;
  margin-right: 2px;
}

.locale {
  flex: none;
  margin: 0 2px;
}

.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background-color 0.2s var(--ease), color 0.2s var(--ease);
}

.icon-btn:hover {
  background: color-mix(in srgb, var(--text) 7%, transparent);
  color: var(--text);
}

.icon-btn svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.spin {
  animation: spin 0.6s var(--ease);
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* 窄屏优先保住导航：品牌名与时间文案是装饰性信息，胶囊才是切换页面的唯一入口 */
@media (max-width: 1023px) {
  .brand,
  .updated {
    display: none;
  }
}

@media (max-width: 560px) {
  .bar {
    gap: var(--space-sm);
    padding: 0 var(--space-md);
  }

  .pill {
    padding: 6px 10px;
    font-size: 13px;
  }

  /* 窄屏优先保住徽章、刷新与语言切换：主题切换是纯装饰，挤掉它不影响任何判断 */
  .icon-btn.theme {
    display: none;
  }

  .btn-sm {
    padding: 6px 10px;
    font-size: 13px;
  }
}
</style>
