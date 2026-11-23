import { ref } from 'vue'
import { MAIN_ID, ApiError, UnauthorizedError, api } from '../api/client'
import type { CandlesOut, ChartMetaOut } from '../api/types'

export interface CandleQuery {
  pair: string
  timeframe: string
  limit: number
}

/**
 * K 线取数与"切换时旧响应不能覆盖新画布"的守卫。
 *
 * 单实例化（B06）：`loadMeta` / `load` **不再接受 instanceId 实参** —— 只有一个 bot，
 * 传参数只会让每个调用点重复写一次 `MAIN_ID`，还会诱使页面重新长出实例选择器。
 * 实例 id 由适配层的 `MAIN_ID` 填进契约字段，页面拿到的仍是完整契约。
 *
 * 关于中断：`api/client.ts` 的 request() 没有暴露 AbortSignal（U0 冻结件），
 * 这里用请求序号丢弃过期响应 —— 效果等价（5m 的晚到结果不会覆盖 1m 画布），
 * 只是省不掉那一次上游请求。
 */
export function useCandles() {
  const meta = ref<ChartMetaOut | null>(null)
  const data = ref<CandlesOut | null>(null)
  const loading = ref(false)
  const metaLoading = ref(false)
  const error = ref<string | null>(null)
  /** 出错时的 HTTP 状态：400 = pair 非法（重试同一个 pair 不会成功，页面要换成"重选"） */
  const errorStatus = ref<number | null>(null)
  const fetchedAt = ref(0)

  let sequence = 0

  async function loadMeta() {
    metaLoading.value = true
    try {
      meta.value = await api.chartMeta(MAIN_ID)
      error.value = null
    } catch (e) {
      // 保留上一份 meta：一次网络抖动不该把白名单和已经画出来的图一起清掉
      error.value = message(e)
    } finally {
      metaLoading.value = false
    }
    return meta.value
  }

  async function load(query: CandleQuery) {
    const mine = ++sequence
    loading.value = true
    try {
      const out = await api.candles(MAIN_ID, query)
      // 切换 pair / 粒度时上一请求的响应：直接丢弃，不能覆盖新画布
      if (mine !== sequence) return
      data.value = out
      error.value = null
      errorStatus.value = null
      fetchedAt.value = Date.now()
    } catch (e) {
      if (mine !== sequence) return
      // 会话过期不是"数据错误"，交给页面统一跳登录；其余保留旧数据只记一条提示
      if (e instanceof UnauthorizedError) throw e
      error.value = message(e)
      errorStatus.value = e instanceof ApiError ? e.status : null
    } finally {
      if (mine === sequence) loading.value = false
    }
  }

  return { meta, data, loading, metaLoading, error, errorStatus, fetchedAt, loadMeta, load }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : '拉取 K 线失败'
}
