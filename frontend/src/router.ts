import { createRouter, createWebHistory } from 'vue-router'
import { hasSession, setUnauthorizedHandler } from './api/client'
import Dashboard from './views/Dashboard.vue'
import Login from './views/Login.vue'

/**
 * 导航胶囊的顺序 = routes 定义顺序（vue-router 保留注册顺序），TopBar 只读 `meta.nav`
 * 生成标签，标签在这里写一次即可，不会出现「加了页面忘了改导航」。
 *
 * 单实例化后导航收敛到 6 项：看板 / 持仓 / K线 / 统计 / 配置 / 运维。
 * 「多实例对比」整页已删——只有一个 bot 的对比是一条线的对比，没有意义。
 *
 * `createWebHistory` 必须保留：freqtrade 的 `web_ui.py` 对非 `/api` 路径回退
 * `index.html`，深链接（如直接访问 `/config`）才能落到 SPA 里而不是 404。
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: Dashboard, meta: { nav: '看板' } },
    // 四个模块页懒加载：各自带图表/表格库（echarts、lightweight-charts），
    // 同步引入会让看板首屏多下与它无关的几百 KB
    {
      path: '/positions',
      component: () => import('./views/Positions.vue'),
      meta: { nav: '持仓' },
    },
    {
      path: '/chart',
      component: () => import('./views/CandleChart.vue'),
      meta: { nav: 'K线' },
    },
    {
      path: '/analytics',
      component: () => import('./views/Analytics.vue'),
      meta: { nav: '统计' },
    },
    // 配置页单独成页：它要承载表单草稿与粘性操作条，
    // 塞进运维 tab 会让「改了没保存」在切 tab 时无声丢失
    {
      path: '/config',
      component: () => import('./views/Config.vue'),
      meta: { nav: '配置' },
    },
    // 运维把「日志 / 系统 / 策略 / 选币」收在一个页面里用 tab 切：
    // 它们都是"出问题时才打开"，独立成四个导航项会把常看的页面挤掉
    {
      path: '/ops',
      component: () => import('./views/Ops.vue'),
      meta: { nav: '运维' },
    },
    { path: '/login', component: Login },
  ],
})

/**
 * 守卫**只看本地有没有 refresh 令牌**，不打任何网络请求。
 *
 * 为什么不自己写一个「校验令牌」的接口或调 refresh 来验证：
 * 每次导航都打一次网络，会在「进程重启中 / 网络抖动」时把人踢回登录页——
 * 而那种情况下登录页同样打不通，用户会以为会话丢了。令牌是否真的有效，
 * 由第一个真实业务请求的 401 单飞流程判定（`http.ts` 会 refresh 一次再重放）。
 *
 * 代价：令牌过期后进页面会先闪一次骨架屏再被送回登录页。这是刻意的取舍。
 */
router.beforeEach((to) => {
  const authenticated = hasSession()
  if (!authenticated && to.path !== '/login') return '/login'
  if (authenticated && to.path === '/login') return '/'
  return true
})

/**
 * 会话真的失效时（refresh 被后端明确拒绝）由 http 层回调这里。
 * 为什么放在 router 而不是 api 层：api 若要 push 就得 import router，
 * 形成 `router → api → router` 的循环依赖。
 *
 * 带 `?expired=1` 是为了让登录页说清「你是过期被踢回来的」，而不是让用户
 * 以为自己刚才那次登录根本没成功。
 */
setUnauthorizedHandler(() => {
  if (router.currentRoute.value.path === '/login') return
  void router.push({ path: '/login', query: { expired: '1' } })
})
