/**
 * 模式 store 的 Vue 侧薄封装。
 *
 * 存在意义只有一个：**让组件不直接依赖 `ft/mode.ts` 的内部结构**。
 * store 本身是模块级单例（跨页面共享），这里只做 `computed` 派生与动作转发，
 * 不持有任何自己的状态——持有就会在多个页面之间出现两份真值。
 */

import { computed } from 'vue'
import {
  appModeState,
  beginConfirm,
  currentModeBadge,
  modeSwitchState,
  onModeSettled,
  refresh,
  resetSwitch,
  startPolling,
  stopPolling,
  switchTo,
} from '../api/ft/mode'

export function useAppMode() {
  return {
    /** 只读：`mode / dryRun / tradingActive / lastError / uiReady / version / reachable` */
    state: appModeState,
    /** 切换状态机：`phase / target / message / elapsedMs` */
    switchState: modeSwitchState,

    badge: computed(() => currentModeBadge()),
    isShell: computed(() => appModeState.mode === 'shell'),
    isTrade: computed(() => appModeState.mode === 'trade'),
    /** 实盘（dry_run=false）：界面用红色，提示风险 */
    isLive: computed(() => appModeState.mode === 'trade' && appModeState.dryRun === false),
    /** 切到交易模式但还没开始交易：徽章显示「启动中」，且不该显示「运行中」的任何数字 */
    isBooting: computed(() => appModeState.mode === 'trade' && appModeState.tradingActive !== true),
    /** 切换进行中：期间不弹任何全局网络错误 */
    isSwitching: computed(() => modeSwitchState.phase === 'switching' || modeSwitchState.phase === 'slow'),
    lastError: computed(() => appModeState.lastError),

    startPolling,
    stopPolling,
    refresh,
    switchTo,
    beginConfirm,
    resetSwitch,
    onModeSettled,
  }
}
