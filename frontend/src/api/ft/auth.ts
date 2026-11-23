/**
 * 令牌层：localStorage 读写 + Basic 登录 + refresh。
 *
 * 职责边界（设计 §1.2）：只负责「拿到/丢掉 token」，**不管跳转**。
 * 跳登录由 `http.ts` 抛 `UnauthorizedError`，router 统一兜——auth 若自己 push，
 * api 层就会 import router，形成 `router → api → router` 的循环依赖。
 *
 * 两个键名固定为 `ftm.access` / `ftm.refresh`，不要改：改了就与已登录用户的
 * 现网会话脱钩，表现是「升级后所有人都被踢下线」。
 */

import { normalizeError, normalizeThrown, readBody } from './errors'
import type { ApiFailure } from './errors'

const ACCESS_KEY = 'ftm.access'
const REFRESH_KEY = 'ftm.refresh'

/** 登录接口的响应（openapi `AccessAndRefreshToken`，两个字段都必有） */
export interface TokenPair {
  access_token: string
  refresh_token: string
}

/**
 * refresh 接口的响应（openapi `AccessToken`）——**只有 access_token**。
 * 这正是最容易踩的坑：拿它整体覆盖本地令牌会把 refresh_token 写成 undefined，
 * 下一次刷新直接失败 → 用户在 15 分钟后被静默踢下线。
 */
export interface AccessTokenOut {
  access_token: string
}

/* ------------------------------------------------------------------ *
 * localStorage（隐私模式 / 磁盘满 都会抛，读不到就当未登录）
 * ------------------------------------------------------------------ */

function read(key: string): string | null {
  try {
    const value = window.localStorage.getItem(key)
    return value && value.trim() ? value : null
  } catch {
    return null
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // 存不进去只影响「刷新页面后免登录」，不影响本次会话，静默即可
  }
}

export function getAccess(): string | null {
  return read(ACCESS_KEY)
}

export function getRefreshToken(): string | null {
  return read(REFRESH_KEY)
}

/**
 * 路由守卫的唯一依据：只看本地有没有 refresh。
 * **不调网络**——网络不可达时把人踢回登录页，用户会以为会话丢了。
 */
export function hasSession(): boolean {
  return getRefreshToken() !== null
}

/** 与 `hasSession()` 同值，语义更贴 http.ts 里的分支（"还有救吗"） */
export function hasRefresh(): boolean {
  return getRefreshToken() !== null
}

/** 只更新 access，refresh 缺省时**原样保留**旧值（refresh 响应没有它） */
export function setTokens(access: string, refresh?: string | null): void {
  write(ACCESS_KEY, access)
  if (refresh !== undefined && refresh !== null && refresh !== '') write(REFRESH_KEY, refresh)
}

/** 登出 / 会话失效：两端都清。freqtrade 没有 logout 端点，清本地就是登出 */
export function clear(): void {
  write(ACCESS_KEY, null)
  write(REFRESH_KEY, null)
}

/* ------------------------------------------------------------------ *
 * Basic 头
 * ------------------------------------------------------------------ */

/**
 * `btoa` 只吃 latin1：密码里出现中文或重音字符会直接抛 InvalidCharacterError。
 * 先按 UTF-8 编码成字节再打包，服务端按 UTF-8 解 base64 就能对上。
 */
function basicHeader(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `Basic ${btoa(binary)}`
}

/* ------------------------------------------------------------------ *
 * 登录 / 刷新
 * ------------------------------------------------------------------ */

/**
 * 登录：`POST /api/v1/token/login` + **HTTP Basic 头**。
 * 不是表单、不是 JSON body，也不设 Content-Type —— 设了反而会被 FastAPI 当成
 * 声明了 body 的请求。凭据错 → 401，会归一化成 `UnauthorizedError`。
 */
export async function login(username: string, password: string): Promise<TokenPair> {
  let res: Response
  try {
    res = await fetch('/api/v1/token/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Authorization: basicHeader(username, password) },
    })
  } catch (e) {
    throw normalizeThrown(e)
  }

  const body = await readBody(res)
  if (!res.ok) throw normalizeError(res.status, body)

  const token = body as Partial<TokenPair> | null
  const access = typeof token?.access_token === 'string' ? token.access_token : ''
  const refresh = typeof token?.refresh_token === 'string' ? token.refresh_token : ''
  if (!access || !refresh) {
    // 200 但字段缺失：后端版本不符，比「登录失败」更需要明确说清
    throw normalizeError(502, { error: '登录响应缺少 access_token / refresh_token，请检查后端版本' })
  }
  setTokens(access, refresh)
  return { access_token: access, refresh_token: refresh }
}

/** 上一次 refresh 失败的原因，给 http.ts 决定「抛 network 还是 unauthorized」用 */
let lastRefreshFailure: ApiFailure | null = null

export function lastRefreshError(): ApiFailure | null {
  return lastRefreshFailure
}

/**
 * 用 refresh_token 换新 access_token。
 *
 * 返回 boolean 而不抛异常：调用方（http.ts 的单飞队列）只关心成不成，
 * 失败原因通过 `lastRefreshError()` 取。**这里不清理会话**（除了刷新端点明确
 * 拒绝 401/403 的确定情形），避免一次网络抖动把用户踢下线。
 */
export async function refresh(): Promise<boolean> {
  const token = getRefreshToken()
  if (!token) {
    lastRefreshFailure = null
    return false
  }

  let res: Response
  try {
    // 走 Bearer + refresh_token（openapi 里该端点是 OAuth2PasswordBearer，没有 body）
    res = await fetch('/api/v1/token/refresh', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch (e) {
    lastRefreshFailure = normalizeError(null, null)
    return false
  }

  const body = await readBody(res)
  if (!res.ok) {
    lastRefreshFailure = normalizeError(res.status, body)
    // 只有「刷新端点自己拒绝了令牌」才算会话真的没了；5xx 可能是重启瞬间
    if (res.status === 401 || res.status === 403) clear()
    return false
  }

  const out = body as Partial<AccessTokenOut> | null
  const access = typeof out?.access_token === 'string' ? out.access_token : ''
  if (!access) {
    lastRefreshFailure = normalizeError(502, { error: '刷新响应缺少 access_token' })
    return false
  }

  // ★ 关键：响应里没有 refresh_token，第二参数传旧值即「保留」，不能省略成 undefined
  setTokens(access, token)
  lastRefreshFailure = null
  return true
}
