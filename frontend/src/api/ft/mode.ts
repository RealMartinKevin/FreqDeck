/**
 * 模式 store（模块级单例，不引 pinia）+ 切换状态机。
 *
 * 为什么是单例而不是 composable 内部状态：`/app/info` 的轮询必须**全局只有一份**，
 * 每个页面各起一个 10s 定时器会让 6 个页面同时打 6 倍请求；而且「切换模式」期间
 * 所有页面都要同时静默（`setInterrupting`），这要求状态天然共享。
 *
 * 界面上**禁止出现「启动」「停止」**：只有「切换模式 / 进入交易模式 / 返回观察模式」。
 * 做成启停开关必然出现「我点了启动但没在交易」这种无解疑问——因为 shell 模式下
 * 进程是活的（API 和 UI 都在跑），只是没连交易所。
 */

import { reactive, readonly } from 'vue'
import { t } from '../../i18n'
import { ApiFailure, normalizeThrown } from './errors'
import { get, post, setInterrupting } from './http'
import type { AppMode, ModeAccepted, RawAppInfo } from '../types'

/** `/app/info` 不依赖 RPC，重启后立即可用，因此轮询它是最可靠的「活了吗」探针 */
const POLL_MS = 10_000
/** 切换期间 2s 一次：重启只要 5-15s，间隔太长用户会觉得卡住 */
const SWITCH_POLL_MS = 2_000
/** 超过这个时间还没 trading_active → 「启动很慢」，但仍继续轮询 */
const SLOW_AFTER_MS = 30_000
/** 状态机硬上限：防止无限轮询把 interrupting 永久钉在 true（全局错误会永久静默） */
const MAX_SWITCH_MS = 120_000

export interface ModeState {
  mode: AppMode | null
  dryRun: boolean | null
  tradingActive: boolean | null
  /** 后端原文，**不改写不截断**（这是唯一能定位启动失败的信息） */
  lastError: string | null
  uiReady: boolean | null
  version: string | null
  exchange: string | null
  strategy: string | null
  runmode: string | null
  /** `state.json` 的绝对路径：排障时要能说出「去看这个文件」，只读展示 */
  stateFile: string | null
  /** 最近一次 `/app/info` 是否成功；false 时徽章显示「连接中断」而不是「观察模式」 */
  reachable: boolean
  /** 是否完成过一次读取（首次进入时别把 null 渲染成「观察模式」） */
  loaded: boolean
  fetchedAt: number | null
}

const state = reactive<ModeState>({
  mode: null,
  dryRun: null,
  tradingActive: null,
  lastError: null,
  uiReady: null,
  version: null,
  exchange: null,
  strategy: null,
  runmode: null,
  stateFile: null,
  reachable: false,
  loaded: false,
  fetchedAt: null,
})

/** 对外只读：任何页面都不能直接改模式，只能通过 `switchTo()` */
export const appModeState = readonly(state)

function applyInfo(info: RawAppInfo): void {
  state.mode = info.mode === 'trade' || info.mode === 'shell' ? info.mode : null
  state.dryRun = typeof info.dry_run === 'boolean' ? info.dry_run : null
  state.tradingActive = typeof info.trading_active === 'boolean' ? info.trading_active : null
  state.lastError = typeof info.last_error === 'string' && info.last_error.trim() ? info.last_error : null
  state.uiReady = typeof info.ui_ready === 'boolean' ? info.ui_ready : null
  state.version = typeof info.version === 'string' ? info.version : null
  state.exchange = typeof info.exchange === 'string' ? info.exchange : null
  state.strategy = typeof info.strategy === 'string' && info.strategy.trim() ? info.strategy : null
  state.runmode = typeof info.runmode === 'string' ? info.runmode : null
  state.stateFile = typeof info.state_file === 'string' && info.state_file.trim() ? info.state_file : null
  state.reachable = true
  state.loaded = true
  state.fetchedAt = Date.now()
}

/* ------------------------------------------------------------------ *
 * 轮询（幂等）
 * ------------------------------------------------------------------ */

let timer: ReturnType<typeof setInterval> | null = null
let inflight: Promise<void> | null = null

/**
 * 幂等：首次调用起定时器，之后调用直接返回。
 * TopBar 每次挂载都会调它，多页面切换不会叠加定时器；也不会随页面卸载停止
 * （模式是全局状态，停在某个页面时也得知道 bot 现在是什么状态）。
 */
export function startPolling(): void {
  if (timer !== null) return
  void refresh()
  timer = setInterval(() => void refresh(), POLL_MS)
}

export function stopPolling(): void {
  if (timer === null) return
  clearInterval(timer)
  timer = null
}

/**
 * 手动刷新一次。失败**不抛**：模式读取失败只影响徽章，不该让页面报错；
 * 失败时把 `reachable` 置 false，让徽章显示「连接中断」而不是过期的旧值。
 */
export function refresh(): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const info = await get<RawAppInfo>('/api/v1/app/info', { timeoutMs: 5_000 })
      applyInfo(info)
    } catch (error) {
      // aborted（页面卸载）不算「连接中断」
      if (error instanceof ApiFailure && error.kind === 'aborted') return
      state.reachable = false
      state.loaded = true
      state.fetchedAt = Date.now()
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/* ------------------------------------------------------------------ *
 * 徽章四态（唯一判定处）
 * ------------------------------------------------------------------ */

export type ModeTone = 'muted' | 'up' | 'down' | 'warn'

export interface ModeBadgeInfo {
  label: string
  tone: ModeTone
  title: string
}

/**
 * 徽章文案与颜色的**唯一来源**（ModeBadge / 看板模式条 / 弹窗都用它，避免三处各判一次）。
 *
 * 优先级（设计 §7）：
 *   1. 还没读到 → 「读取中」灰（不能先说「观察模式」，会闪一下假的确定性）
 *   2. 连不上 → 「连接中断」黄（不能继续显示上次的「交易模式」，那是在撒谎）
 *   3. `trade && tradingActive !== true` → 黄「启动中」**覆盖**模拟/实盘
 *      —— 不知道有没有在交易时，绝不能显示「运行中」
 *   4. `trade && dryRun === false` → **红**「实盘」（风险提示，不是亏损色）
 *   5. `trade` → 绿「模拟」
 *   6. `shell` → 灰「观察模式」
 */
export function describeMode(source: {
  mode: AppMode | null
  dryRun: boolean | null
  tradingActive: boolean | null
  reachable: boolean
  loaded: boolean
}): ModeBadgeInfo {
  // 本函数只在组件的 computed / 模板渲染路径内被调用（见 useAppMode.badge），
  // 因此这里调用 t() 会随语言切换自动重算；不要在 fetch 阶段把结果烘焙进数据。
  if (!source.loaded) return { label: t('读取中'), tone: 'muted', title: t('正在读取 bot 状态') }
  if (!source.reachable) {
    return { label: t('连接中断'), tone: 'warn', title: t('读不到 /app/info：进程可能正在重启或已退出') }
  }
  if (source.mode === 'trade') {
    if (source.tradingActive !== true) {
      return { label: t('交易模式 · 启动中'), tone: 'warn', title: t('进程已切到交易模式，但还没开始交易（可能在加载策略/连交易所）') }
    }
    if (source.dryRun === false) {
      return { label: t('交易模式 · 实盘'), tone: 'down', title: t('实盘：真实资金在交易，每一次下单都会成交') }
    }
    return { label: t('交易模式 · 模拟'), tone: 'up', title: t('模拟盘：dry-run，不涉及真实资金') }
  }
  if (source.mode === 'shell') {
    return { label: t('观察模式'), tone: 'muted', title: t('观察模式：只跑 API 与界面，不连交易所、不产生交易数据') }
  }
  return { label: t('未知'), tone: 'muted', title: t('后端未返回可识别的模式') }
}

/** 给组件用的便捷版本（直接读单例） */
export function currentModeBadge(): ModeBadgeInfo {
  return describeMode(state)
}

/* ------------------------------------------------------------------ *
 * 切换状态机
 * ------------------------------------------------------------------ */

export type SwitchPhase = 'idle' | 'confirming' | 'switching' | 'success' | 'slow' | 'reverted' | 'unreachable'

export interface SwitchState {
  phase: SwitchPhase
  target: AppMode | null
  /** 失败/回退时的**后端原文**；成功时为空串 */
  message: string
  /** 从收到 200 那一刻起算（不是从点击起算）：POST 本身可能排队几百毫秒 */
  startedAt: number | null
  elapsedMs: number
}

const switchState = reactive<SwitchState>({
  phase: 'idle',
  target: null,
  message: '',
  startedAt: null,
  elapsedMs: 0,
})

export const modeSwitchState = readonly(switchState)

export function beginConfirm(target: AppMode): void {
  switchState.phase = 'confirming'
  switchState.target = target
  switchState.message = ''
  switchState.startedAt = null
  switchState.elapsedMs = 0
}

export function resetSwitch(): void {
  switchState.phase = 'idle'
  switchState.target = null
  switchState.message = ''
  switchState.startedAt = null
  switchState.elapsedMs = 0
}

/** 切换结束后的回调（B05 用它刷新看板数据）：模块级注册，无第三方依赖 */
type SwitchListener = (phase: SwitchPhase) => void
const listeners = new Set<SwitchListener>()

export function onModeSettled(listener: SwitchListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emitSettled(phase: SwitchPhase): void {
  for (const listener of listeners) {
    try {
      listener(phase)
    } catch {
      // 某个监听器异常不能影响其它页面刷新
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 切换模式。四结局 + 一个慢启动：
 * `success` / `slow` / `reverted` / `unreachable`（`accepted===false` 直接回 `idle` + message）。
 *
 * 中断期约定：收到 200 立刻 `setInterrupting(true)`，让全局的网络错误条静默；
 * `finally` 里必须 `setInterrupting(false)`，否则一次切换之后整个应用再也不报错了
 * ——这是最难排查的「功能看起来好好的，就是不提示」类故障。
 */
export async function switchTo(target: AppMode): Promise<SwitchPhase> {
  // 已在切换中：不重复下发，直接返回当前阶段（避免连点造成两次 execv）
  if (switchState.phase === 'switching' || switchState.phase === 'slow') return switchState.phase

  switchState.phase = 'switching'
  switchState.target = target
  switchState.message = ''
  switchState.startedAt = null
  switchState.elapsedMs = 0

  let ack: ModeAccepted
  try {
    ack = await post<ModeAccepted>('/api/v1/app/mode', { body: { mode: target }, timeoutMs: 10_000 })
  } catch (error) {
    // 请求本身失败（网络/401/503）：不是「切换失败」，是没下发成功
    switchState.phase = 'idle'
    switchState.message = error instanceof ApiFailure ? error.detail : normalizeThrown(error).detail
    return switchState.phase
  }

  // ★ C2：这个端点是 HTTP 200，成功与否只看 accepted
  if (ack.accepted !== true) {
    switchState.phase = 'idle'
    switchState.message = ack.message || t('后端拒绝切换模式')
    emitSettled('idle')
    return switchState.phase
  }

  const ackAt = Date.now()
  switchState.startedAt = ackAt
  setInterrupting(true)
  try {
    let consecutiveFailures = 0
    let sawSlow = false
    for (;;) {
      await sleep(SWITCH_POLL_MS)
      const elapsed = Date.now() - ackAt
      switchState.elapsedMs = elapsed

      let info: RawAppInfo | null = null
      try {
        info = await get<RawAppInfo>('/api/v1/app/info', { timeoutMs: 4_000 })
        consecutiveFailures = 0
      } catch {
        consecutiveFailures += 1
      }

      if (info !== null) {
        applyInfo(info)
        /*
         * 「切成功」的判据必须区分目标模式：
         * 只有 target === 'trade' 才要求 trading_active —— 观察模式本来就不加载策略、
         * 不连交易所，trading_active 恒 false。之前统一要求 true，导致每次切到观察模式
         * 都被判成 slow（「启动很慢 / 卡在哪一步」），而实际上进程是健康的。
         */
        const ready = target === 'shell' ? true : info.trading_active === true
        if (info.mode === target && ready) {
          switchState.phase = 'success'
          break
        }
        // 回退：模式没切过去且后端给了原因（典型是交易所密钥错→自动回退 shell）
        if (info.mode !== target && typeof info.last_error === 'string' && info.last_error.trim()) {
          switchState.phase = 'reverted'
          switchState.message = info.last_error
          break
        }
        // 慢启动：目标是要交易、模式对了却还没 trading_active；继续轮询，仍可能变好
        // （目标为观察模式时不适用：它没有 trading_active 这个阶段）
        if (target === 'trade' && info.mode === target && info.trading_active !== true && elapsed >= SLOW_AFTER_MS) {
          switchState.phase = 'slow'
          sawSlow = true
        }
      }

      if (consecutiveFailures >= 3 && elapsed >= SLOW_AFTER_MS) {
        switchState.phase = 'unreachable'
        break
      }
      if (elapsed >= MAX_SWITCH_MS) {
        // 硬上限：慢启动保持 slow，其余归为连不上
        if (!sawSlow) switchState.phase = 'unreachable'
        break
      }
    }
  } finally {
    // 无论如何都要恢复全局错误提示
    setInterrupting(false)
    void refresh()
    emitSettled(switchState.phase)
  }

  return switchState.phase
}

/** 进度文案固定（设计 §7）：给用户一个时间预期，比一个转圈图标有用得多 */
export const SWITCH_PROGRESS_TEXT = '正在重启进程（约 5–15 秒）'
