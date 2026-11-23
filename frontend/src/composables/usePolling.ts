import { onBeforeUnmount, onMounted } from 'vue'
import { ApiFailure } from '../api/ft/errors'
import { modeSwitchState } from '../api/ft/mode'

/**
 * 定时轮询（每轮可取消）。
 *
 * 用递归 setTimeout 而不是 setInterval：上游慢的时候（后端单实例 3 秒超时）
 * setInterval 会在上一轮还没回来时再发一轮，请求越堆越多，切回前台时一次刷出十几个响应。
 * 递归版天然串行，inFlight 标记是第二道保险。
 *
 * 三件事各解决一个问题，缺一件就会在某个场景露馅：
 *
 *  1. **每轮一个 AbortController，卸载时 abort**
 *     只清定时器不够：卸载那一刻可能正好有一次请求在飞，它的回包会落到已卸载组件的
 *     ref 上（最典型的是把「数据更新于 X 秒前」刷成刚取到的时间，用户看到页面已经走了
 *     数据还在变）。abort 让那次 fetch 直接 reject，链路上不会再有后续赋值。
 *     被取消的请求在传输层归一化成 `ApiFailure('aborted')`——那是**取消**不是故障，
 *     永远不渲染、不记日志。
 *
 *  2. **`aborted` 静默**
 *     页面切走/切 tab 时的取消不能变成一条红色错误条，否则每次离开页面都要闪一次红。
 *
 *  3. **`duringSwitch` 期间跳过整轮**
 *     切模式会 execv 重启进程，5–15 秒内所有端点必然连不上。此时继续按 10s 轮询，
 *     等于在用户眼前持续制造「无法连接服务」——而那不是故障，是过程。
 *     这期间不发请求比发完再静默更干净：一次多余的请求都没有。
 *
 * 页面隐藏时也停发（省电），恢复可见立即补一次，保证看到的不是十几秒前的旧数据。
 * 首次挂载立即执行一次，调用方不需要再单独 onMounted。
 */

export interface PollingOptions {
  /**
   * 模式切换（进程重启）期间跳过整轮，默认 true。
   * 只有「切模式期间也必须继续取数」的页面才需要关掉它。
   */
  pauseDuringSwitch?: boolean
}

/** 模式切换是否正在进行：`switching` / `slow` 两个阶段都算 */
function switchingNow(): boolean {
  return modeSwitchState.phase === 'switching' || modeSwitchState.phase === 'slow'
}

export function usePolling(
  task: (signal: AbortSignal) => unknown,
  intervalMs = 10_000,
  options: PollingOptions = {},
) {
  const pauseDuringSwitch = options.pauseDuringSwitch !== false

  let timer: number | undefined
  let inFlight = false
  let disposed = false
  /** 当前这一轮的取消器；上一轮的永远在 finally 里清空，不会累积 */
  let controller: AbortController | null = null

  const stop = () => {
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timer = undefined
    }
  }

  const schedule = () => {
    stop()
    if (!disposed) timer = window.setTimeout(() => void run(), intervalMs)
  }

  async function run() {
    // 上一轮未返回就跳过本次触发，避免慢响应把请求堆起来
    if (inFlight || disposed) return
    if (document.hidden) return schedule()
    // 重启窗口内不发请求：这期间后端一定连不上，报错是噪声不是信息
    if (pauseDuringSwitch && switchingNow()) return schedule()

    inFlight = true
    const current = new AbortController()
    controller = current
    try {
      await task(current.signal)
    } catch (error) {
      // 取消（页面卸载 / 主动切走）与「切换模式中断期」都不该冒泡成界面错误。
      // 其余错误由调用方自己 try/catch 渲染成错误条，这里只保证下一轮照常排程。
      if (error instanceof ApiFailure && (error.kind === 'aborted' || error.duringSwitch)) return
    } finally {
      inFlight = false
      if (controller === current) controller = null
      schedule()
    }
  }

  const onVisibility = () => {
    if (document.hidden) return stop()
    // 回到前台：立刻补一次，然后重置节奏
    void run()
  }

  onMounted(() => {
    void run()
    document.addEventListener('visibilitychange', onVisibility)
  })

  onBeforeUnmount(() => {
    disposed = true
    stop()
    // 正在飞的那次请求也要断开：否则回包会写进已卸载组件的状态
    controller?.abort()
    controller = null
    document.removeEventListener('visibilitychange', onVisibility)
  })
}
