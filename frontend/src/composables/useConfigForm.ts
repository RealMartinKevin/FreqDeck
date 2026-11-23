/**
 * 配置页的表单状态模型（设计 §6.1 的三层状态 + 第四层 `secretsReplaced`）。
 *
 * 四层状态为什么必须分开：
 *   - `baseline`：`GET /app/config` 的快照，**含 `***redacted***` 掩码**。它是「改回原值」
 *     与「这个键到底改没改」的唯一参照。
 *   - `draft`：用户编辑中的完整树。掩码原样留在树里，用户不动它就不会有任何副作用。
 *   - `dirty`：**只由字段控件写入**的点分路径集合。不做深比较——后端热载后会自己微调
 *     某些键（`internals.heartbeat_interval`），深比较会把它算成用户改动，提交后
 *     就把前端猜的值写回去了。
 *   - `secretsReplaced`：用户明确点了「更换/清除」的密钥路径。**这是掩码唯一允许
 *     被提交的条件**（见 `buildDiff()`），少一个判断就把密码写成 `***redacted***`。
 *
 * 保存成功后重新 `GET` 一次，而不是「本地把 draft 当 baseline」：清空/更换密钥后
 * 服务端回的是掩码或空串，本地猜不出来，猜错会让「已配置/未配置」显示反。
 */

import { computed, reactive, ref } from 'vue'
import { ApiFailure, FIELDS, buildDiff, fetchConfig, getAtPath, restartOnlyPaths, saveConfig, setAtPath } from '../api/client'
import type { AppMode, ConfigFieldSpec } from '../api/types'
// 掩码语义只从适配层取，不在这里再定义一份常量：两处定义迟早会漂移
import { isRedacted } from '../api/ft/normalize'

export type SaveKind = 'reloaded' | 'shell_mode' | 'reload_pending' | 'reload_failed' | 'rejected'

export interface SaveResult {
  kind: SaveKind
  /** 结果条主文案（人话结论） */
  title: string
  /** 后端原文：`reload_failed: xxx` 的 xxx，或 400 的 `detail`。不改写不截断 */
  detail: string | null
  /** 后端确认变了的字段（点分路径或键名） */
  changed: string[]
  /** 需重启才生效的路径 */
  restartFor: string[]
}

/** 深拷贝配置树：baseline 必须与 draft 断开引用，否则一次编辑就把「原值」也改了 */
function cloneTree<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T
}

/** 同样的深比较口径（只用于「改回原值就把 dirty 去掉」这一个判断） */
function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

export function useConfigForm() {
  const loading = ref(false)
  const saving = ref(false)
  const loadError = ref<string | null>(null)
  const ready = ref(false)

  const draft = reactive<Record<string, unknown>>({})
  const baseline = ref<Record<string, unknown>>({})
  const dirty = ref<Set<string>>(new Set())
  const secretsReplaced = ref<Set<string>>(new Set())

  const mode = ref<AppMode | null>(null)
  /** 服务端声明的「只能重启生效」路径（`api_server.listen_port` 等） */
  const restartOnly = ref<Set<string>>(new Set())
  /** 最近一次保存命中的需重启路径：保存后提示用 */
  const lastRestartFor = ref<string[]>([])

  const fieldErrors = ref<Record<string, string>>({})
  const groupErrors = ref<Record<string, string>>({})
  const globalError = ref<string | null>(null)
  const result = ref<SaveResult | null>(null)

  const dirtyCount = computed(() => dirty.value.size)
  const hasChanges = computed(() => dirty.value.size > 0 || secretsReplaced.value.size > 0)

  function valueOf(path: string): unknown {
    return getAtPath(draft, path)
  }

  /** 密钥字段「是否已配置」：空串与掩码都不算有值（未配置时后端回 `''`，不是掩码） */
  function hasSecret(path: string): boolean {
    const value = valueOf(path)
    if (typeof value !== 'string') return false
    return value !== '' && !isRedacted(value)
  }

  function isReplaced(path: string): boolean {
    return secretsReplaced.value.has(path)
  }

  function resetErrors(): void {
    fieldErrors.value = {}
    groupErrors.value = {}
    globalError.value = null
  }

  /** 用服务端快照覆盖整棵树（保存后与首次加载共用） */
  function applySnapshot(config: Record<string, unknown>, nextMode: AppMode, restartPaths: string[][]): void {
    for (const key of Object.keys(draft)) delete draft[key]
    for (const [key, value] of Object.entries(config)) draft[key] = value
    baseline.value = cloneTree(config)
    mode.value = nextMode
    restartOnly.value = restartOnlyPaths(restartPaths)
    dirty.value = new Set()
    secretsReplaced.value = new Set()
    ready.value = true
  }

  async function load(): Promise<void> {
    loading.value = true
    loadError.value = null
    try {
      const out = await fetchConfig()
      applySnapshot(out.config, out.mode, out.restart_only_paths ?? [])
    } catch (error) {
      loadError.value = error instanceof ApiFailure ? error.detail : '读取配置失败'
    } finally {
      loading.value = false
    }
  }

  /**
   * 字段控件唯一的写入口。**所有改动都必须经过这里**：
   * 它同时维护 `dirty`，而 `dirty` 是 `buildDiff()` 的白名单。
   */
  function setValue(path: string, value: unknown): void {
    setAtPath(draft, path, value)
    const next = new Set(dirty.value)
    // 改回原值就从 dirty 里移除：「未保存 1 项」却什么都没变，比不显示更糟
    if (sameJson(getAtPath(baseline.value, path), value)) next.delete(path)
    else next.add(path)
    dirty.value = next
    if (fieldErrors.value[path]) {
      const remaining = { ...fieldErrors.value }
      delete remaining[path]
      fieldErrors.value = remaining
    }
  }

  /** 用户点了「更换」并给出新值（或「清除」给空串）——掩码豁免只在这一条路径上产生 */
  function replaceSecret(path: string, value: string): void {
    setAtPath(draft, path, value)
    const nextDirty = new Set(dirty.value)
    nextDirty.add(path)
    dirty.value = nextDirty
    const nextReplaced = new Set(secretsReplaced.value)
    nextReplaced.add(path)
    secretsReplaced.value = nextReplaced
  }

  /** 放弃编辑：整棵树回到 baseline（掩码也跟着回来），编辑态清空 */
  function discard(): void {
    for (const key of Object.keys(draft)) delete draft[key]
    for (const [key, value] of Object.entries(cloneTree(baseline.value))) draft[key] = value
    dirty.value = new Set()
    secretsReplaced.value = new Set()
    resetErrors()
    result.value = null
  }

  /** 本次保存会命中哪些「需重启」路径：用于保存前的二次确认 */
  const pendingRestartFor = computed(() => {
    const out: string[] = []
    const touched = new Set<string>([...dirty.value, ...secretsReplaced.value])
    for (const path of touched) if (restartOnly.value.has(path)) out.push(path)
    return out
  })

  /**
   * 把后端 400 的 `detail` 归到字段/分组（设计 §6.5）。
   *
   * 两级归属，都是**确定性**规则，不做猜测：
   *   1. `detail` 里出现了字段名（全路径或 ≥5 字符的叶子名）→ 挂该字段 + 该组；
   *   2. 一个都没命中，但本次只提交了**一个**字段 → 那它就是不二人选（例如
   *      `invalid configuration: 'abc' does not match 'unlimited'` 完全不提字段名，
   *      而用户这次确实只改了 stake_amount）；
   *   3. 其余情况挂全局。**绝不吞掉原文**——那串字是用户唯一能拿去搜索的东西。
   */
  function attachBackendError(detail: string, fields: readonly ConfigFieldSpec[] = FIELDS, touched: string[] = []): void {
    const lower = detail.toLowerCase()
    const hits: string[] = []
    for (const field of fields) {
      const full = field.path.toLowerCase()
      const leaf = full.split('.').pop() ?? full
      // 叶子名太短（name/type/pair…）会误匹配到任意句子，只认长度 ≥ 5 的叶子
      const leafHit = leaf.length >= 5 && new RegExp(`(^|[^a-z0-9_])${leaf}([^a-z0-9_]|$)`).test(lower)
      if (lower.includes(full) || leafHit) hits.push(field.path)
    }

    if (hits.length === 0 && touched.length === 1 && fields.some((field) => field.path === touched[0])) {
      hits.push(touched[0])
    }

    if (hits.length === 0) {
      globalError.value = detail
      return
    }
    const nextFields = { ...fieldErrors.value }
    const nextGroups = { ...groupErrors.value }
    for (const path of hits) {
      nextFields[path] = detail
      const group = fields.find((field) => field.path === path)?.group
      if (group) nextGroups[group] = detail
    }
    fieldErrors.value = nextFields
    groupErrors.value = nextGroups
  }

  /**
   * 保存。返回 `null` 表示「没有可提交的改动」或「保存失败」。
   *
   * 二次确认（需重启路径、实盘风险）由页面负责——那是 UI 决策，
   * 放在这里会让「保存」变成一个会弹窗的函数，难以复用。
   */
  async function save(): Promise<SaveResult | null> {
    if (saving.value) return null
    const restartFor = [...pendingRestartFor.value]
    const diff = buildDiff(baseline.value, draft, dirty.value, secretsReplaced.value)
    if (Object.keys(diff).length === 0) {
      dirty.value = new Set()
      secretsReplaced.value = new Set()
      return null
    }

    saving.value = true
    resetErrors()
    result.value = null
    try {
      const saved = await saveConfig(diff)
      lastRestartFor.value = saved.restart_required_for.length > 0 ? saved.restart_required_for : restartFor

      const applied = saved.applied
      let outcome: SaveResult
      if (applied === 'shell_mode') {
        outcome = {
          kind: 'shell_mode',
          title: '已保存；观察模式下不加载策略与交易所，切到交易模式后生效',
          detail: null,
          changed: saved.changed,
          restartFor: lastRestartFor.value,
        }
      } else if (applied.startsWith('reload_failed')) {
        // 后端格式是 `reload_failed: <原因>`，冒号后的原文照展示
        const reason = applied.slice('reload_failed'.length).replace(/^[:\s]+/, '')
        outcome = {
          kind: 'reload_failed',
          title: '已保存，但热载失败',
          detail: reason || applied,
          changed: saved.changed,
          restartFor: lastRestartFor.value,
        }
      } else if (applied === 'reload_pending' || applied === 'restart_required') {
        // `restart_required` 实际不会出现（后端只回 reload_pending），按同一交互兜底
        outcome = {
          kind: 'reload_pending',
          title: '已保存；有改动需要重启进程才生效',
          detail: null,
          changed: saved.changed,
          restartFor: lastRestartFor.value,
        }
      } else {
        outcome = {
          kind: 'reloaded',
          title: '已保存并生效',
          detail: null,
          changed: saved.changed,
          restartFor: lastRestartFor.value,
        }
      }
      result.value = outcome

      // 重新取一次真值：清空/更换密钥后服务端回掩码或空串，本地猜不出来
      await load()
      return outcome
    } catch (error) {
      const failure = error instanceof ApiFailure ? error : null
      const detail = failure?.detail ?? '保存失败'
      if (failure !== null && (failure.kind === 'invalid' || failure.status === 400)) {
        // 400 是「校验没过」：尽量挂到字段/分组上，原文一字不改
        const touched = [...new Set<string>([...dirty.value, ...secretsReplaced.value])]
        attachBackendError(detail, FIELDS, touched)
        const rejection: SaveResult = {
          kind: 'rejected',
          title: '后端拒绝了这份配置',
          detail,
          changed: [],
          restartFor: [],
        }
        result.value = rejection
        // 返回它而不是 null：调用方需要区分「没东西可提交」与「被后端拒了」
        return rejection
      }
      globalError.value = detail
      return null
    } finally {
      saving.value = false
    }
  }

  function dismissResult(): void {
    result.value = null
  }

  return {
    loading,
    saving,
    loadError,
    ready,
    draft,
    baseline,
    dirty,
    secretsReplaced,
    mode,
    restartOnly,
    lastRestartFor,
    fieldErrors,
    groupErrors,
    globalError,
    result,
    dirtyCount,
    hasChanges,
    pendingRestartFor,
    valueOf,
    hasSecret,
    isReplaced,
    load,
    setValue,
    replaceSecret,
    discard,
    save,
    dismissResult,
    resetErrors,
  }
}
