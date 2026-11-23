/**
 * 错误归一化：全前端**唯一**允许把「HTTP 状态码 + 响应体」翻译成人话的地方。
 *
 * 为什么必须有这一层：freqtrade app 模式对「未就绪」有**两种**抛出形态 ——
 * 依赖 `get_rpc` 的端点返回 `502 {"error": "..."}`，依赖 `is_trading_mode` 的端点返回
 * `503 {"detail": "Bot is not in the correct state."}`（见 .probe 实测样例）。
 * 页面若各自 `if (res.status === 503)`，迟早漏掉一种，表现是「观察模式下整页红错」。
 *
 * `ApiFailure` 的 `kind` 是**业务态**而不是状态码：视图只判断
 * `not_ready` / `unauthorized` / `invalid` / `network` / `server_error` / `aborted`，
 * 不判断数字。数字留在 `status` 里给少数需要它的地方（如 K 线 400 → 「重选交易对」）。
 */

import { t } from '../../i18n'

export type ErrorKind =
  /** 不算错误（占位，便于 Record<ErrorKind, string> 有完整文案表） */
  | 'ok'
  /** 502+error / 503+detail / 200 包着 {detail}：观察模式或 bot 未就绪，不是故障 */
  | 'not_ready'
  /** 401 / 403 */
  | 'unauthorized'
  /** 400 / 409 / 422：参数不合法、超过 max_open_trades、force_entry 未开启 */
  | 'invalid'
  /** fetch reject / 超时（没有 HTTP 响应） */
  | 'network'
  /** 其它 5xx 与未分类失败 */
  | 'server_error'
  /** 调用方主动取消（页面卸载、切 pair），永不渲染、永不记日志 */
  | 'aborted'

/** 后端「未就绪」的固定原文；判定要靠它，不要靠「含 not 和 state」这类模糊匹配 */
export const NOT_READY_DETAIL = 'Bot is not in the correct state.'

/** 人话文案表：视图直接渲染 `detail` 即可，不需要再拼字符串 */
export const ERROR_TEXT: Record<ErrorKind, string> = {
  ok: '正常',
  not_ready: '观察模式不读取交易数据',
  unauthorized: '登录已过期，请重新登录',
  invalid: '请求参数不合法',
  network: '无法连接服务，请确认 freqtrade 进程在运行',
  server_error: '服务内部错误',
  aborted: '请求已取消',
}

/**
 * 错误文案的**响应式取法**：内部调用 t()，`detail` 里装的是中文原文（key），
 * 只有走到这里才翻译成当前语言。放在 computed / 模板等渲染路径中调用会随语言切换重算。
 *
 * 注意：backend 原文（`ApiFailure.raw` / `instance.last_error` 等）不要传进来，
 * 那些要保持原样展示。这里只处理本模块自己生成的中文文案。
 */
export function errorText(kind: ErrorKind): string {
  return t(ERROR_TEXT[kind] ?? kind)
}

/**
 * 动态 HTTP 文案的**原始 key**（不含具体数字）。数字在渲染时由 `errorDetailText`
 * 用 `status` 填入 `{n}`——绝不在归一化阶段烘焙具体数字，否则英文表按 `{n}` 收录的
 * 词条匹配不上，会掉回中文原文。
 */
export const ERROR_DETAIL_TEMPLATE = {
  invalid: '请求参数不合法（HTTP {n}）',
  serverError: '服务内部错误（HTTP {n}）',
  requestFailed: '请求失败（HTTP {n}）',
} as const

/**
 * 错误展示文案的**响应式取法**。兼容三种入参：
 *   - `ApiFailure`（自带 detail + status）；
 *   - 拍平后的 `{ detail, status }`（数据层 reason/error 字段补了 status 后即此形态）；
 *   - 纯字符串 key（没有可用 status 时，如网络错误/静态文案）。
 *
 * `t()` 对不含 `{n}` 的 key 会忽略 params，所以所有静态中文 key 走同一函数也安全；
 * 后端原文（RPCException 的 error 文本等）不进英文表，t() 天然 passthrough。
 */
export type ErrorDetailSource =
  | { detail: string; status?: number | null }
  | string
  | null
  | undefined

export function errorDetailText(source: ErrorDetailSource, status?: number | null): string {
  if (source === null || source === undefined) return ''
  if (typeof source === 'string') return t(source, { n: status })
  return t(source.detail, { n: source.status ?? status })
}

export interface ApiFailureInit {
  /** null = 没有 HTTP 响应（网络层失败 / 主动取消） */
  status?: number | null
  /** 人话；缺省取 ERROR_TEXT[kind] */
  detail?: string
  /** 后端原文，供折叠/复制，绝不改写 */
  raw?: string | null
  /** 发生在模式切换中断期：为 true 时全局静默（不跳登录、不弹错） */
  duringSwitch?: boolean
  /** 原始异常，保留 stack 便于排查 */
  cause?: unknown
}

export class ApiFailure extends Error {
  readonly kind: ErrorKind
  /** null = 没有 HTTP 响应。注意与「0」的区别：0 不是合法状态码 */
  readonly status: number | null
  /** 人话，可直接渲染；与 message 同值（既有视图读 message，新代码读 detail） */
  readonly detail: string
  /** 后端原文（可能是 JSON 串），绝不改写 */
  readonly raw: string | null
  readonly duringSwitch: boolean

  constructor(kind: ErrorKind, init: ApiFailureInit = {}) {
    // Error.message 就是界面文案：既有 9 个文件的 catch 分支都读 (e as Error).message
    const detail = (init.detail ?? '').trim() || ERROR_TEXT[kind]
    super(detail, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = 'ApiFailure'
    this.kind = kind
    this.status = init.status ?? null
    this.detail = detail
    this.raw = init.raw ?? null
    this.duringSwitch = init.duringSwitch === true
  }
}

/**
 * 会话失效。**类名必须保留**：Positions/Ops/Analytics/Dashboard/CandleChart 等
 * 既有 `e instanceof UnauthorizedError` 分支依赖它，改名等于让它们全部静默失效。
 */
export class UnauthorizedError extends ApiFailure {
  constructor(init: ApiFailureInit = {}) {
    super('unauthorized', { ...init, status: init.status ?? 401 })
    this.name = 'UnauthorizedError'
  }
}

/**
 * 连不上（含超时）。既有代码 `e instanceof NetworkError` 用来把文案换成
 * 「无法连接管理服务，正在重试」——保类名就是保这条降级链。
 */
export class NetworkError extends ApiFailure {
  constructor(cause?: unknown, init: ApiFailureInit = {}) {
    super('network', {
      ...init,
      // fetch 的裸 TypeError 消息（"Failed to fetch"）留在 raw 里给折叠区，界面用中文
      raw: init.raw ?? (cause instanceof Error ? cause.message : null),
      cause,
    })
    this.name = 'NetworkError'
  }
}

/**
 * 有 HTTP 响应但语义失败。`useCandles` 靠 `e instanceof ApiError ? e.status : null`
 * 拿到 400 来切「重选交易对」，所以 400/409/422 也必须是 ApiError（kind='invalid'），
 * 不能因为「不是 5xx」就换成别的类。
 */
export class ApiError extends ApiFailure {
  constructor(status: number | null, detail: string, init: ApiFailureInit & { kind?: ErrorKind } = {}) {
    const { kind = 'server_error', ...rest } = init
    super(kind, { ...rest, status, detail })
    this.name = 'ApiError'
  }
}

/* ------------------------------------------------------------------ *
 * 响应体解析
 * ------------------------------------------------------------------ */

/** 宽松读 body：非 JSON / 空 body 都不抛，交给上层按 raw 处理 */
export async function readBody(res: Response): Promise<unknown> {
  // 204/205 没有 body，res.text() 也会给空串，但显式短路更清楚
  if (res.status === 204 || res.status === 205) return null
  const text = await res.text().catch(() => '')
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

/** raw 字段的序列化：字符串原样，对象转 JSON，其它尽力而为 */
export function rawText(body: unknown): string | null {
  if (body === null || body === undefined) return null
  if (typeof body === 'string') return body
  try {
    return JSON.stringify(body)
  } catch {
    return null
  }
}

/**
 * FastAPI 的 detail 有四种形状都要能显示到界面上：字符串、`{code,msg}` 对象、
 * 校验错误数组、以及 app 模式自己塞的 `{"error": "..."}`。
 * 认不出来就返回 null，由调用方补「请求失败（HTTP n）」，不要吞掉原文。
 */
function pickText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const parts = value.map((item) => pickText(item)).filter((s): s is string => s !== null)
    return parts.length ? parts.join('；') : null
  }
  if (value && typeof value === 'object') {
    const obj = value as { msg?: unknown; message?: unknown; detail?: unknown; code?: unknown }
    // 后端把参数错误统一改写成 {"detail":{"code","msg"}}，不认这个形状就只剩
    // 「请求失败（400）」，invalid_pair / invalid configuration 的原文永远出不来
    return pickText(obj.msg) ?? pickText(obj.message) ?? pickText(obj.detail) ?? pickText(obj.code)
  }
  return null
}

/** 从任意响应体里抽出「后端说了什么」；抽不到 → null */
export function detailFromBody(body: unknown): string | null {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const obj = body as { detail?: unknown; error?: unknown; message?: unknown }
    const fromDetail = pickText(obj.detail)
    if (fromDetail !== null) return fromDetail
    const fromError = pickText(obj.error)
    if (fromError !== null) return fromError
    const fromMessage = pickText(obj.message)
    if (fromMessage !== null) return fromMessage
    return null
  }
  // 纯文本响应体（网关 HTML、uvicorn traceback）直接当原文用
  return pickText(body)
}

function hasKey(body: unknown, key: string): boolean {
  return !!body && typeof body === 'object' && !Array.isArray(body) && key in body
}

/* ------------------------------------------------------------------ *
 * 归一化
 * ------------------------------------------------------------------ */

export interface NormalizeOptions {
  /** 模式切换中断期：为 true 时全局静默（不跳登录、不弹错） */
  duringSwitch?: boolean
}

/**
 * 状态码 → 业务态。判定顺序即优先级（与设计 §4.2 表一致）：
 * 502+error → not_ready；503+固定原文 → not_ready；503 其它 → server_error；
 * 401/403 → unauthorized；400/409/422 → invalid；其余 5xx/未分类 → server_error。
 * `status === null` 表示「没有 HTTP 响应」，即网络层失败。
 */
export function normalizeError(status: number | null, body: unknown, opts: NormalizeOptions = {}): ApiFailure {
  const duringSwitch = opts.duringSwitch === true
  const raw = rawText(body)

  if (status === null) return new NetworkError(undefined, { duringSwitch })

  // 形态一：依赖 get_rpc 的端点，观察模式下 502 + {"error": "..."}
  if (status === 502 && hasKey(body, 'error')) {
    return new ApiError(status, (detailFromBody(body) ?? '') || ERROR_TEXT.not_ready, {
      kind: 'not_ready',
      // raw 存「后端原话」而不是整包 JSON：折叠区要给人看的是 RPC 那句原因
      raw: rawText((body as Record<string, unknown>).error) ?? raw,
      duringSwitch,
    })
  }

  if (status === 503) {
    // 形态二：依赖 is_trading_mode 的端点，观察模式下 503 + {"detail": "Bot is not in the correct state."}
    if (detailFromBody(body) === NOT_READY_DETAIL) {
      return new ApiError(status, ERROR_TEXT.not_ready, {
        kind: 'not_ready',
        raw: rawText((body as Record<string, unknown>).detail) ?? raw,
        duringSwitch,
      })
    }
    return new ApiError(status, '服务暂不可用', { kind: 'server_error', raw, duringSwitch })
  }

  if (status === 401 || status === 403) {
    return new UnauthorizedError({ status, raw, duringSwitch })
  }

  if (status === 400 || status === 409 || status === 422) {
    // 原文必须原样展示：配置页靠它把 invalid configuration 挂回具体分组/字段
    const detail = detailFromBody(body) ?? ERROR_DETAIL_TEMPLATE.invalid
    return new ApiError(status, detail, { kind: 'invalid', raw, duringSwitch })
  }

  if (status >= 500) {
    return new ApiError(status, ERROR_DETAIL_TEMPLATE.serverError, {
      kind: 'server_error',
      raw,
      duringSwitch,
    })
  }

  return new ApiError(status, ERROR_DETAIL_TEMPLATE.requestFailed, { kind: 'server_error', raw, duringSwitch })
}

export interface ThrownOptions extends NormalizeOptions {
  /** 调用方自己的 AbortSignal 已取消（页面卸载 / 切 pair），不是故障 */
  aborted?: boolean
  /** 是内部超时器触发的取消：归 network（超时），文案要说清楚 */
  timedOut?: boolean
}

export function isAbortError(e: unknown): boolean {
  if (e instanceof DOMException) return e.name === 'AbortError'
  return !!e && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError'
}

/** fetch 抛出来的东西（TypeError / AbortError / DOMException）→ ApiFailure */
export function normalizeThrown(e: unknown, opts: ThrownOptions = {}): ApiFailure {
  const duringSwitch = opts.duringSwitch === true
  if (opts.aborted === true) return new ApiFailure('aborted', { duringSwitch, cause: e })
  if (opts.timedOut === true) {
    return new NetworkError(e, { duringSwitch, detail: '请求超时，服务可能还在启动中' })
  }
  // 分辨不清是谁取消的，按「取消」处理：把用户看不见的取消渲染成红色错误条更糟
  if (isAbortError(e)) return new ApiFailure('aborted', { duringSwitch, cause: e })
  return new NetworkError(e, { duringSwitch })
}

/**
 * 「HTTP 200 但 body 是个错误体」的识别。
 * 实测 `.probe/pair_hist.json` 就是裸 `{"detail": "Bot is not in the correct state."}`：
 * 不识别的话，上层会拿到一个「字段全 undefined 的成功响应」，比报错更难查。
 */
export function isNotReadyBody(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const obj = body as Record<string, unknown>
  // 明确的未就绪原文，哪怕旁边还挂了别的键也算
  if (pickText(obj.detail) === NOT_READY_DETAIL || pickText(obj.error) === NOT_READY_DETAIL) return true
  // 只含一个 detail/error 字符串键的对象：不可能是任何正常业务响应
  const keys = Object.keys(obj)
  if (keys.length !== 1) return false
  const only = keys[0]
  if (only !== 'detail' && only !== 'error') return false
  return pickText(obj[only]) !== null
}

/** 成功响应的守卫：200 包着的错误体在这里变成 ApiFailure('not_ready') */
export function normalizeOkBody<T>(body: unknown, opts: NormalizeOptions = {}): T {
  if (isNotReadyBody(body)) {
    throw new ApiError(200, ERROR_TEXT.not_ready, {
      kind: 'not_ready',
      raw: rawText(body),
      duringSwitch: opts.duringSwitch === true,
    })
  }
  return body as T
}

/** 页面里判断「这条错误要不要渲染」的唯一入口：aborted 与中断期一律不渲染 */
export function shouldRender(failure: unknown): boolean {
  if (!(failure instanceof ApiFailure)) return true
  if (failure.kind === 'aborted') return false
  return !failure.duringSwitch
}
