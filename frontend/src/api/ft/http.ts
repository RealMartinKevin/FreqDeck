/**
 * 传输层：同源 fetch + Bearer 注入 + 401 单飞 refresh + AbortSignal + 中断期打标。
 *
 * 这一层**不懂任何业务字段**（设计 §1.2）。它只保证三件事：
 *   1. 每个请求都带上 `Authorization: Bearer`；
 *   2. 会话过期时，**并发 10 个 401 只刷新一次**，且只重放一次；
 *   3. 失败一律抛 `ApiFailure`（含网络层失败），上层不需要 try/catch fetch。
 *
 * 为什么单飞这么重要：`/status` `/profit` `/balance` 是并发的，页面刷新后首个
 * 请求轮全是 401。若各自去 refresh，refresh_token 会被并发消费/覆盖，
 * 结果是「刷新页面后必然被踢回登录页」——这是最典型的线上事故形态。
 */

import {
  ApiFailure,
  NetworkError,
  UnauthorizedError,
  normalizeError,
  normalizeOkBody,
  normalizeThrown,
  readBody,
} from './errors'
import * as auth from './auth'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** 默认超时。轮询间隔通常 5s，超时给太小会把「慢」误报成「断」 */
export const TIMEOUT_DEFAULT_MS = 15_000

export interface RequestOptions {
  /** 查询参数：undefined / null / 空串不上送（否则后端会把空 pair 当成非法参数） */
  query?: Record<string, string | number | boolean | null | undefined>
  /** JSON body；undefined 表示无 body（此时不设 Content-Type） */
  body?: unknown
  /** 调用方的取消信号（页面卸载、切 pair） */
  signal?: AbortSignal
  /** 额外/覆盖请求头 */
  headers?: Record<string, string>
  /** 不带 Bearer（如 `/api/v1/ping`） */
  anonymous?: boolean
  /** 覆盖默认超时；0 = 不设超时 */
  timeoutMs?: number
}

/* ------------------------------------------------------------------ *
 * 中断期打标（模式切换 execv 重启窗口）
 * ------------------------------------------------------------------ */

let interrupting = false

/**
 * 模式切换期间置 true：重启瞬间的 401 / 连接重置是时序问题，不是会话失效。
 * 打标后 `ApiFailure.duringSwitch === true`，页面对这类错误一律静默，
 * 避免「点切换模式 → 满屏报错 → 还被踢回登录页」。
 */
export function setInterrupting(active: boolean): void {
  interrupting = active
}

export function isInterrupting(): boolean {
  return interrupting
}

/* ------------------------------------------------------------------ *
 * 会话失效回调（由 router 注入，避免 api 层 import router 造成循环依赖）
 * ------------------------------------------------------------------ */

let unauthorizedHandler: (() => void) | null = null

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler
}

/* ------------------------------------------------------------------ *
 * 401 单飞
 * ------------------------------------------------------------------ */

/**
 * 模块级「正在进行的刷新」。排队者 await 同一个 Promise，
 * 因此 N 个并发 401 只会产生 1 次 refresh 请求。
 */
let inflightRefresh: Promise<boolean> | null = null

function refreshOnce(): Promise<boolean> {
  if (!inflightRefresh) {
    inflightRefresh = auth
      .refresh()
      .catch(() => false)
      // finally 里置空：本次刷新结束后，后续新的 401 才允许重新发起
      .finally(() => {
        inflightRefresh = null
      })
  }
  return inflightRefresh
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function withQuery(path: string, query: RequestOptions['query']): string {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value))
  }
  const qs = params.toString()
  if (!qs) return path
  return path.includes('?') ? `${path}&${qs}` : `${path}?${qs}`
}

interface LinkedSignal {
  signal: AbortSignal
  /** 是调用方取消的（页面卸载 / 切 pair）→ 归 aborted，不渲染 */
  abortedByCaller: () => boolean
  /** 是内部超时器取消的 → 归 network（超时） */
  timedOut: () => boolean
  dispose: () => void
}

/**
 * 把「调用方信号」和「超时器」合到一个 controller 上。
 * 手写而不用 `AbortSignal.any()`：后者在目标浏览器/TS lib 版本上不一定有，
 * 而这个函数只有 20 行。
 */
function linkSignal(external: AbortSignal | undefined, timeoutMs: number): LinkedSignal {
  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const onAbort = (): void => controller.abort()
  if (external) {
    if (external.aborted) controller.abort()
    else external.addEventListener('abort', onAbort, { once: true })
  }
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
  }

  return {
    signal: controller.signal,
    abortedByCaller: () => !timedOut && external?.aborted === true,
    timedOut: () => timedOut,
    dispose: () => {
      if (timer !== null) clearTimeout(timer)
      external?.removeEventListener('abort', onAbort)
    },
  }
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

/**
 * 唯一的请求入口。
 *
 * `isRetry` 是**内部**参数：refresh 成功后只允许重放一次。
 * 不带这个守卫就会「refresh 成功但重放仍 401」→ 无限递归 → 浏览器卡死。
 */
export async function request<T>(
  method: HttpMethod,
  path: string,
  opts: RequestOptions = {},
  isRetry = false,
): Promise<T> {
  const headers: Record<string, string> = { ...opts.headers }

  // 写操作带这个头：既有的管理服务对写请求校验它，缺失直接 403，与 freqtrade 无关也不能丢
  if (method !== 'GET') headers['X-Requested-With'] = 'ftm'

  if (!opts.anonymous) {
    const token = auth.getAccess()
    // 没有 access 也照发：让后端回 401，由下面的单飞流程统一处理，
    // 比在这里提前抛异常好——提前抛就绕过了「refresh 后恢复会话」的路径。
    if (token) headers.Authorization = `Bearer ${token}`
  }

  const hasBody = opts.body !== undefined
  if (hasBody) headers['Content-Type'] = 'application/json'

  const linked = linkSignal(opts.signal, opts.timeoutMs ?? TIMEOUT_DEFAULT_MS)

  let res: Response
  try {
    res = await fetch(withQuery(path, opts.query), {
      method,
      credentials: 'same-origin',
      headers,
      body: hasBody ? JSON.stringify(opts.body) : undefined,
      signal: linked.signal,
    })
  } catch (e) {
    throw normalizeThrown(e, {
      duringSwitch: interrupting,
      aborted: linked.abortedByCaller(),
      timedOut: linked.timedOut(),
    })
  } finally {
    linked.dispose()
  }

  // ---- 401：单飞 refresh → 只重放一次 ----
  if (res.status === 401 && !isRetry && !opts.anonymous && auth.hasSession()) {
    if (interrupting) {
      // 中断期：401 多半是 execv 重启的时序问题（旧进程已退、新进程未就绪）。
      // 既不刷新也不清令牌，只打标静默抛——清令牌等于「切一次模式就被踢下线」，
      // 等进程起来后下一轮轮询会自然走到正常 refresh 路径。
      throw new UnauthorizedError({ duringSwitch: true })
    }

    const ok = await refreshOnce()
    if (ok) return request<T>(method, path, opts, true)

    // 刷新失败要分清两种原因，否则会把「服务重启中」说成「登录过期」
    const failure = auth.lastRefreshError()
    if (auth.hasSession() && failure !== null && failure.kind === 'network') {
      // 刷新端点是网络层失败（重启/断网），令牌其实还在 → 抛 network 更诚实
      throw new NetworkError(failure, { duringSwitch: interrupting })
    }
    auth.clear()
    // 中断期只标记不跳转：execv 重启瞬间的 401 常常下一次就正常了
    const unauthorized = new UnauthorizedError({ duringSwitch: interrupting })
    if (!unauthorized.duringSwitch) unauthorizedHandler?.()
    throw unauthorized
  }

  const body = await readBody(res)

  if (!res.ok) {
    const failure = normalizeError(res.status, body, { duringSwitch: interrupting })
    if (failure.kind === 'unauthorized' && !failure.duringSwitch && !opts.anonymous) {
      // 走到这里说明「没有 refresh 可用」或「重放后仍 401」：会话真的没了
      auth.clear()
      unauthorizedHandler?.()
    }
    throw failure
  }

  if (res.status === 204 || res.status === 205) return undefined as T

  // 200 但 body 是错误体（实测 .probe/pair_hist.json）→ 在这里变成 not_ready，
  // 否则上层拿到的是「字段全 undefined 的成功响应」
  return normalizeOkBody<T>(body, { duringSwitch: interrupting })
}

/** GET 便捷入口（绝大多数取数都是 GET） */
export function get<T>(path: string, opts: Omit<RequestOptions, 'body'> = {}): Promise<T> {
  return request<T>('GET', path, opts)
}

export function post<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  return request<T>('POST', path, opts)
}

export function put<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  return request<T>('PUT', path, opts)
}

export function del<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  return request<T>('DELETE', path, opts)
}

/** 给上层判断「这条错误要不要渲染」用，避免各处重复写 kind 判定 */
export function isAborted(failure: unknown): boolean {
  return failure instanceof ApiFailure && failure.kind === 'aborted'
}
