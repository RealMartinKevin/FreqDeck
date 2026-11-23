<script setup lang="ts">
/**
 * 配置页：左侧锚点 + 右侧单列表单 + 粘性操作条。
 *
 * 这个页面只有一个职责：让用户不必手写 `config.json` 就能改配置并看到**真实生效结果**。
 * 三条硬规则：
 *   1. 页面**不轮询**。配置页每 5s 重新拉一次会让用户正在编辑的草稿被覆盖，
 *      这种「打着打着字就没了」是这个页面最不能犯的错。
 *   2. 提交内容只能由 `buildDiff()` 产出（白名单 + 掩码豁免），**绝不在这里手搓 payload**。
 *   3. 后端 `detail` 原文照展示：那是用户唯一能拿去搜索的东西，改写成「配置有误」等于毁掉它。
 */

import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ApiFailure, CONFIG_GROUPS, FIELDS, changePassword, restartProcess } from '../api/client'
import type { ConfigFieldSpec } from '../api/types'
import ConfigField from '../components/ConfigField.vue'
import ConfigGroup from '../components/ConfigGroup.vue'
import ModeBadge from '../components/ModeBadge.vue'
import StatePanel from '../components/StatePanel.vue'
import TopBar from '../components/TopBar.vue'
import { useConfigForm } from '../composables/useConfigForm'

const {
  loading,
  saving,
  loadError,
  ready,
  draft,
  dirty,
  mode,
  restartOnly,
  fieldErrors,
  groupErrors,
  globalError,
  result,
  dirtyCount,
  hasChanges,
  pendingRestartFor,
  valueOf,
  isReplaced,
  load,
  setValue,
  replaceSecret,
  discard,
  save,
  dismissResult,
} = useConfigForm()

/* ------------------------------------------------------------------ *
 * 锚点
 * ------------------------------------------------------------------ */

interface Anchor {
  id: string
  title: string
}

/**
 * 7 个锚点：运行模式 + 5 个配置组 + 高级。
 * 运行模式不是「配置保存」（走 `POST /app/mode`），但它决定了其余字段改完何时生效，
 * 放在第一屏能省掉「我保存了怎么没反应」这类疑问。
 * 高级只做**只读** JSON 视图：允许任意改 JSON 等于绕过掩码保护，风险远大于收益。
 */
const anchors = computed<Anchor[]>(() => [
  { id: 'mode', title: '运行模式' },
  ...CONFIG_GROUPS.map((group) => ({ id: group.id, title: group.title })),
  { id: 'advanced', title: '高级（只读 JSON）' },
])

const activeAnchor = ref('mode')
let observer: IntersectionObserver | null = null

function scrollTo(id: string): void {
  activeAnchor.value = id
  const el = document.getElementById(`group-${id}`)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function setupObserver(): void {
  const targets = anchors.value
    .map((anchor) => document.getElementById(`group-${anchor.id}`))
    .filter((el): el is HTMLElement => el !== null)
  if (targets.length === 0) return
  observer = new IntersectionObserver(
    (entries) => {
      // 取「最靠上且仍在视口内」的那一组：滚动时高亮跟随，而不是等整组离开才跳
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
      const first = visible[0]
      if (first?.target.id) activeAnchor.value = first.target.id.replace('group-', '')
    },
    // 顶栏 64px + 视口下沿留 40%：只露一条缝的组不该抢高亮
    { rootMargin: '-80px 0px -40% 0px', threshold: [0.01, 0.2] },
  )
  for (const target of targets) observer.observe(target)
}

/* ------------------------------------------------------------------ *
 * 字段与分组
 * ------------------------------------------------------------------ */

function fieldsOf(groupId: string): ConfigFieldSpec[] {
  return FIELDS.filter((field) => field.group === groupId)
}

function dirtyOf(groupId: string): number {
  return fieldsOf(groupId).filter((field) => dirty.value.has(field.path)).length
}

function restartOnlyOf(path: string): boolean {
  return restartOnly.value.has(path)
}

/* ------------------------------------------------------------------ *
 * 保存
 * ------------------------------------------------------------------ */

const confirmRestart = ref(false)

async function requestSave(): Promise<void> {
  if (!hasChanges.value || saving.value) return
  // 监听地址/端口改完必须重启才生效：先讲清楚「保存 ≠ 立刻可用」，再让用户决定
  if (pendingRestartFor.value.length > 0) {
    confirmRestart.value = true
    return
  }
  await commit()
}

async function commit(): Promise<void> {
  confirmRestart.value = false
  await save()
  // 一旦有字段级错误（后端 400 被归属到字段），直接滚到第一个出错的组：
  // 用户不用在 30 个字段里找「到底哪一项不合法」
  if (Object.keys(fieldErrors.value).length > 0) {
    const firstGroup = FIELDS.find((field) => fieldErrors.value[field.path])?.group
    if (firstGroup) {
      await nextTick()
      scrollTo(firstGroup)
    }
  }
}

function onDiscard(): void {
  discard()
}

/** 「立即重启」：唯一会主动断连的动作，提示先于点击（这里只做确认，不做自动重试） */
const restartConfirm = ref(false)
const restarting = ref(false)

async function doRestart(): Promise<void> {
  restarting.value = true
  try {
    await restartProcess()
  } catch {
    // 重启瞬间请求本身可能断在半路，属于预期：中断期已把全局网络错误静默
  } finally {
    restarting.value = false
    restartConfirm.value = false
  }
}

/* ------------------------------------------------------------------ *
 * 修改登录密码（走 POST /app/password，不是 PUT /app/config）
 * ------------------------------------------------------------------ */

const pwdCurrent = ref('')
const pwdNew = ref('')
const pwdConfirm = ref('')
const pwdBusy = ref(false)
const pwdMessage = ref<string | null>(null)
const pwdError = ref<string | null>(null)

async function submitPassword(): Promise<void> {
  if (pwdBusy.value) return
  pwdMessage.value = null
  pwdError.value = null
  if (pwdNew.value.length < 8) {
    pwdError.value = '新密码至少 8 位'
    return
  }
  if (pwdNew.value !== pwdConfirm.value) {
    pwdError.value = '两次输入的新密码不一致'
    return
  }
  pwdBusy.value = true
  try {
    const ack = await changePassword(pwdCurrent.value, pwdNew.value)
    if (ack.accepted !== true) {
      pwdError.value = ack.message || '后端拒绝修改密码'
      return
    }
    pwdMessage.value = '密码已修改。当前会话仍然有效，下次登录请使用新密码。'
    pwdCurrent.value = ''
    pwdNew.value = ''
    pwdConfirm.value = ''
  } catch (error) {
    if (error instanceof ApiFailure) {
      // 这个端点的 401/403 只可能是「当前密码不对」（后端 `compare_digest` 失败 → 403），
      // 所以翻译成人话，但把后端原文一并留在括号里——不吞掉能拿去搜索的字。
      pwdError.value =
        error.status === 401 || error.status === 403 ? `当前密码不正确（${error.detail}）` : error.detail
    } else {
      pwdError.value = '修改密码失败'
    }
  } finally {
    pwdBusy.value = false
  }
}

/* ------------------------------------------------------------------ *
 * 高级 JSON（只读）
 * ------------------------------------------------------------------ */

const jsonText = computed(() => {
  try {
    return JSON.stringify(draft, null, 2)
  } catch {
    return '{}'
  }
})

const jsonCopied = ref(false)

async function copyJson(): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(jsonText.value)
    else fallbackCopy(jsonText.value)
    jsonCopied.value = true
    window.setTimeout(() => (jsonCopied.value = false), 1600)
  } catch {
    fallbackCopy(jsonText.value)
    jsonCopied.value = true
  }
}

function fallbackCopy(value: string): void {
  const area = document.createElement('textarea')
  area.value = value
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  document.body.appendChild(area)
  area.select()
  document.execCommand('copy')
  document.body.removeChild(area)
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

onMounted(async () => {
  await load()
  await nextTick()
  setupObserver()
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})
</script>

<template>
  <div class="page">
    <TopBar />

    <div class="shell">
      <aside class="side" aria-label="配置分组">
        <p class="side-title">配置</p>
        <button
          v-for="anchor in anchors"
          :key="anchor.id"
          class="anchor"
          :class="{ active: activeAnchor === anchor.id, bad: !!groupErrors[anchor.id] }"
          type="button"
          @click="scrollTo(anchor.id)"
        >
          <span class="anchor-dot" aria-hidden="true" />
          {{ anchor.title }}
          <span v-if="groupErrors[anchor.id]" class="anchor-bad" title="该组有后端返回的错误">!</span>
        </button>
      </aside>

      <main class="content">
        <StatePanel v-if="loading && !ready" variant="block" tone="muted" title="正在读取配置…" />

        <StatePanel
          v-else-if="loadError"
          variant="block"
          tone="error"
          title="读取配置失败"
          action="重试"
          @action="load"
        >
          {{ loadError }}
        </StatePanel>

        <template v-else>
          <!-- G1 运行模式：不是配置，但这儿能一眼看到「改完什么时候生效」 -->
          <ConfigGroup id="mode" title="运行模式" desc="模式切换会重启进程（约 5–15 秒）。配置字段改完是否生效取决于当前模式。">
            <div class="mode-row">
              <ModeBadge />
              <p class="mode-hint">
                观察模式下只跑 API 与界面，不加载策略与交易所：这时保存的策略/交易所类配置会被记为「切到交易模式后生效」。
              </p>
            </div>
          </ConfigGroup>

          <ConfigGroup
            v-for="group in CONFIG_GROUPS"
            :id="group.id"
            :key="group.id"
            :title="group.title"
            :desc="group.desc"
            :error="groupErrors[group.id] ?? null"
            :dirty-count="dirtyOf(group.id)"
          >
            <ConfigField
              v-for="field in fieldsOf(group.id)"
              :key="field.path"
              :field="field"
              :value="valueOf(field.path)"
              :dirty="dirty.has(field.path)"
              :error="fieldErrors[field.path] ?? null"
              :restart-only="restartOnlyOf(field.path)"
              :replaced="isReplaced(field.path)"
              @change="setValue"
              @replace="replaceSecret"
              @clear="(p: string) => replaceSecret(p, '')"
            />

            <!-- 安全组追加「修改登录密码」：走 /app/password，会校验当前密码 -->
            <div v-if="group.id === 'security'" class="pwd">
              <p class="pwd-title">修改登录密码</p>
              <p class="pwd-desc">
                与上面「登录密码」字段的区别：这里会**校验当前密码**，忘了旧密码就没法改——防止会话被劫持后直接换密码。
              </p>
              <div class="pwd-grid">
                <label class="pwd-cell">
                  <span class="pwd-label">当前密码</span>
                  <input v-model="pwdCurrent" class="input" type="password" autocomplete="current-password" />
                </label>
                <label class="pwd-cell">
                  <span class="pwd-label">新密码（≥ 8 位）</span>
                  <input v-model="pwdNew" class="input" type="password" autocomplete="new-password" />
                </label>
                <label class="pwd-cell">
                  <span class="pwd-label">确认新密码</span>
                  <input v-model="pwdConfirm" class="input" type="password" autocomplete="new-password" />
                </label>
              </div>
              <div class="pwd-actions">
                <button class="btn btn-secondary btn-sm" type="button" :disabled="pwdBusy" @click="submitPassword">
                  {{ pwdBusy ? '提交中…' : '修改密码' }}
                </button>
                <span v-if="pwdMessage" class="pwd-ok">{{ pwdMessage }}</span>
                <span v-if="pwdError" class="pwd-err">{{ pwdError }}</span>
              </div>
            </div>
          </ConfigGroup>

          <!-- G7 高级：只读。可编辑的原始 JSON 等于给用户一个绕过掩码保护的入口 -->
          <ConfigGroup
            id="advanced"
            title="高级（只读 JSON）"
            desc="当前配置的完整快照，密钥已由后端脱敏。本页不提供直接编辑：任意改 JSON 会绕过「掩码绝不提交」的保护。"
          >
            <div class="json-actions">
              <button class="btn btn-secondary btn-sm" type="button" @click="copyJson">
                {{ jsonCopied ? '已复制' : '复制 JSON' }}
              </button>
              <span class="json-note">含未保存的改动</span>
            </div>
            <pre class="json">{{ jsonText }}</pre>
          </ConfigGroup>
        </template>
      </main>
    </div>

    <!-- 结果条 + 操作条：粘在底部，滚动到哪都看得见「还没保存」 -->
    <div v-if="ready" class="dock">
      <div v-if="result" class="result" :class="`r-${result.kind}`">
        <div class="result-main">
          <p class="result-title">{{ result.title }}</p>
          <p v-if="result.changed.length" class="result-sub">
            后端确认变更 {{ result.changed.length }} 项：{{ result.changed.join('、') }}
          </p>
          <pre v-if="result.detail" class="result-raw">{{ result.detail }}</pre>
          <p v-if="result.kind === 'shell_mode'" class="result-sub">
            保存不会自己切模式，需要你手动切一次。
          </p>
        </div>
        <div class="result-actions">
          <button v-if="result.kind === 'shell_mode'" class="btn btn-primary btn-sm" type="button" @click="scrollTo('mode')">
            切换模式
          </button>
          <button
            v-if="result.kind === 'reload_pending' || result.kind === 'reload_failed'"
            class="btn btn-secondary btn-sm"
            type="button"
            @click="restartConfirm = true"
          >
            立即重启
          </button>
          <button class="btn btn-secondary btn-sm" type="button" @click="dismissResult">知道了</button>
        </div>
      </div>

      <div v-if="globalError" class="global-err" role="alert">{{ globalError }}</div>

      <div class="bar">
        <span class="bar-state">
          <template v-if="!hasChanges">没有未保存的改动</template>
          <template v-else>未保存 {{ dirtyCount }} 项</template>
          <span v-if="mode === 'shell'" class="bar-mode">当前是观察模式</span>
        </span>
        <div class="bar-actions">
          <button class="btn btn-secondary btn-sm" type="button" :disabled="!hasChanges || saving" @click="onDiscard">
            放弃
          </button>
          <button class="btn btn-primary btn-sm" type="button" :disabled="!hasChanges || saving" @click="requestSave">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 需重启字段的保存前确认 -->
    <Teleport to="body">
      <div v-if="confirmRestart" class="overlay" @click.self="confirmRestart = false">
        <div class="dialog" role="dialog" aria-modal="true">
          <h2 class="dialog-title">这些改动需要重启进程</h2>
          <p class="dialog-lead">
            下面的字段不会热载，保存后仍然用旧值，直到进程重启：
          </p>
          <ul class="dialog-list">
            <li v-for="path in pendingRestartFor" :key="path">{{ path }}</li>
          </ul>
          <p class="dialog-lead warn">
            改监听地址或端口时请注意：重启后要用**新地址**访问本页面，旧地址会连不上。
          </p>
          <div class="dialog-actions">
            <button class="btn btn-secondary" type="button" @click="confirmRestart = false">取消</button>
            <button class="btn btn-primary" type="button" @click="commit">仍然保存</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 立即重启的确认 -->
    <Teleport to="body">
      <div v-if="restartConfirm" class="overlay" @click.self="restartConfirm = false">
        <div class="dialog" role="dialog" aria-modal="true">
          <h2 class="dialog-title">重启进程？</h2>
          <p class="dialog-lead">
            重启期间（约 5–15 秒）页面会短暂失去连接，这是正常过程；已有持仓不会被平掉。
          </p>
          <div class="dialog-actions">
            <button class="btn btn-secondary" type="button" @click="restartConfirm = false">取消</button>
            <button class="btn btn-danger" type="button" :disabled="restarting" @click="doRestart">
              {{ restarting ? '重启中…' : '立即重启' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  padding-bottom: 132px;
  background: var(--bg);
}

.shell {
  display: grid;
  grid-template-columns: 188px minmax(0, 1fr);
  gap: var(--space-lg);
  max-width: 1180px;
  margin: 0 auto;
  padding: var(--space-lg) var(--space-lg) 0;
}

.side {
  position: sticky;
  top: 80px;
  align-self: start;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.side-title {
  margin-bottom: 6px;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-tertiary);
}

.anchor {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 9px;
  border: none;
  border-radius: 9px;
  background: transparent;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  text-align: left;
  cursor: pointer;
  transition: background-color 0.2s var(--ease), color 0.2s var(--ease);
}

.anchor:hover {
  background: color-mix(in srgb, var(--text) 5%, transparent);
  color: var(--text);
}

.anchor.active {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  color: var(--accent);
}

.anchor-dot {
  width: 5px;
  height: 5px;
  flex: none;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.4;
}

.anchor.active .anchor-dot {
  opacity: 1;
}

.anchor-bad {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: var(--down);
  font-size: 10px;
  font-weight: 700;
  color: #fff;
}

.content {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  min-width: 0;
}

.mode-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-md);
  padding: 12px 0;
}

.mode-hint {
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--text-tertiary);
}

.pwd {
  margin-top: 14px;
  padding: 14px 0 4px;
  border-top: 1px dashed var(--border-strong);
}

.pwd-title {
  font-size: 13.5px;
  font-weight: 600;
}

.pwd-desc {
  margin-top: 4px;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--text-tertiary);
}

.pwd-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px;
  margin-top: 10px;
}

.pwd-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.pwd-label {
  font-size: 12px;
  color: var(--text-secondary);
}

.pwd-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}

.pwd-ok {
  font-size: 12.5px;
  color: var(--up);
}

.pwd-err {
  font-size: 12.5px;
  color: var(--down);
}

.json-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
}

.json-note {
  font-size: 12px;
  color: var(--text-tertiary);
}

.json {
  max-height: 380px;
  margin: 0 0 10px;
  padding: 10px 12px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-inner);
  background: var(--bg-secondary);
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11.5px;
  line-height: 1.55;
  white-space: pre;
  user-select: text;
}

.dock {
  position: fixed;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: var(--z-topbar);
  max-width: 1180px;
  margin: 0 auto;
  padding: 0 var(--space-lg) var(--space-md);
}

.result {
  display: flex;
  align-items: flex-start;
  gap: var(--space-md);
  margin-bottom: 8px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-inner);
  background: var(--card-solid);
  box-shadow: var(--shadow-card);
}

/* 结果条按结论上色：绿=已生效、黄=待生效、红=被拒/失败 */
.r-reloaded {
  border-color: color-mix(in srgb, var(--up) 32%, transparent);
  background: color-mix(in srgb, var(--up) 6%, var(--card-solid));
}

.r-shell_mode,
.r-reload_pending {
  border-color: color-mix(in srgb, var(--warn) 34%, transparent);
  background: color-mix(in srgb, var(--warn) 7%, var(--card-solid));
}

.r-reload_failed,
.r-rejected {
  border-color: color-mix(in srgb, var(--down) 32%, transparent);
  background: color-mix(in srgb, var(--down) 6%, var(--card-solid));
}

.result-main {
  min-width: 0;
  flex: 1;
}

.result-title {
  font-size: 13.5px;
  font-weight: 600;
}

.result-sub {
  margin-top: 3px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-secondary);
  word-break: break-word;
}

.result-raw {
  max-height: 140px;
  margin: 8px 0 0;
  padding: 8px 10px;
  overflow: auto;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--down) 20%, transparent);
  background: var(--bg-secondary);
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}

.result-actions {
  display: flex;
  flex: none;
  gap: 8px;
}

.global-err {
  margin-bottom: 8px;
  padding: 10px 12px;
  border-radius: var(--radius-inner);
  border: 1px solid color-mix(in srgb, var(--down) 26%, transparent);
  background: color-mix(in srgb, var(--down) 7%, var(--card-solid));
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--down);
  user-select: text;
}

.bar {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  box-shadow: var(--shadow-card);
}

.bar-state {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
}

.bar-mode {
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--text) 6%, transparent);
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.bar-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}

.overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(12px);
}

.dialog {
  width: 520px;
  max-width: 100%;
  padding: 24px;
  border-radius: 20px;
  background: var(--card-solid);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-pop);
}

.dialog-title {
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.015em;
}

.dialog-lead {
  margin-top: 8px;
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.dialog-lead.warn {
  color: var(--warn);
}

.dialog-list {
  margin: 10px 0 0;
  padding-left: 18px;
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text);
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}

@media (max-width: 860px) {
  .shell {
    grid-template-columns: 1fr;
  }

  .side {
    position: static;
    flex-direction: row;
    flex-wrap: wrap;
    gap: 4px;
  }

  .side-title {
    width: 100%;
  }
}
</style>
