<script setup lang="ts">
/**
 * 登录页：用户名（预填 admin）+ 密码 → HTTP Basic 换 JWT。
 *
 * 三个必须能区分的情况（文案不同，用户的下一步动作也不同）：
 *   1. 账号/密码错 → 「账号或密码不正确」（改输入）
 *   2. 连不上 → 「无法连接服务，请确认 freqtrade 进程在运行」（去看终端）
 *   3. 会话过期被踢回来（`?expired=1`）→ 「登录已过期，请重新登录」（什么都不用改）
 * 把 1 和 2 都说成「登录失败」等于让用户去猜。
 */

import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ApiFailure, NetworkError, UnauthorizedError, api } from '../api/client'

const route = useRoute()
const router = useRouter()

/** freqtrade 只有 admin 一个账号，预填省一次输入；仍可改（改过用户名的实例） */
const username = ref('admin')
const password = ref('')
const pending = ref(false)
const error = ref<string | null>(null)
const shaking = ref(false)

/** 被 401 踢回来时先解释一句，而不是让用户以为「刚才没登录成功」 */
const expired = computed(() => route.query.expired === '1')

async function submit() {
  if (pending.value) return
  if (!username.value.trim() || !password.value) {
    error.value = '请输入用户名与密码'
    return
  }
  pending.value = true
  error.value = null
  try {
    await api.loginWithCredentials(username.value.trim(), password.value)
    // 带上 redirect 更友好：被守卫拦下来的目标页登录后直接回去
    const target = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
    await router.push(target)
  } catch (e) {
    error.value = describe(e)
    shake()
  } finally {
    pending.value = false
  }
}

function describe(e: unknown): string {
  if (e instanceof UnauthorizedError) return '账号或密码不正确'
  if (e instanceof NetworkError) return '无法连接服务，请确认 freqtrade 进程在运行'
  if (e instanceof ApiFailure) return e.detail
  return '登录失败，请重试'
}

function shake() {
  shaking.value = true
  window.setTimeout(() => (shaking.value = false), 240)
}
</script>

<template>
  <div class="login-page">
    <form class="login" :class="{ shake: shaking }" @submit.prevent="submit">
      <div class="mark" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M4 7h16M4 12h10M4 17h6" />
        </svg>
      </div>
      <h1 class="title">Freqtrade 控制台</h1>
      <p class="hint desc">用启动时打印的账号密码登录</p>

      <p v-if="expired && !error" class="notice" role="status">登录已过期，请重新登录</p>

      <label class="field">
        <span class="label">用户名</span>
        <input
          v-model="username"
          type="text"
          class="input"
          :class="{ invalid: error }"
          placeholder="admin"
          autocomplete="username"
          @input="error = null"
        />
      </label>

      <label class="field">
        <span class="label">密码</span>
        <input
          v-model="password"
          type="password"
          class="input"
          :class="{ invalid: error }"
          placeholder="密码"
          autocomplete="current-password"
          autofocus
          @input="error = null"
        />
      </label>

      <p v-if="error" class="err" role="alert">{{ error }}</p>

      <button class="btn btn-primary submit" type="submit" :disabled="pending">
        {{ pending ? '登录中…' : '登录' }}
      </button>

      <!-- 首启提示：密码只在启动终端里打印一次，找不到入口会让人以为是 bug -->
      <p class="hint first-run">
        首次启动时，账号密码由 freqtrade 在终端打印一次，并写入用户目录下的凭据文件。
      </p>
    </form>
  </div>
</template>

<style scoped>
.login-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 24px;
  /* 单色微渐变让留白不显得空，而不是叠装饰元素 */
  background: radial-gradient(
    120% 90% at 50% 0%,
    color-mix(in srgb, var(--accent) 6%, var(--bg)) 0%,
    var(--bg) 58%
  );
}

.login {
  display: flex;
  flex-direction: column;
  width: 372px;
  max-width: 100%;
  padding: 36px 32px 32px;
  border-radius: 24px;
  background: var(--card);
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-card-hover), var(--highlight);
}

.mark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  margin-bottom: 20px;
  border-radius: 12px;
  color: #fff;
  background: linear-gradient(160deg, var(--accent), color-mix(in srgb, var(--accent) 70%, #6a5acd));
  box-shadow: 0 6px 18px color-mix(in srgb, var(--accent) 30%, transparent);
}

.mark svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
}

.title {
  font-size: 25px;
  font-weight: 600;
  letter-spacing: -0.025em;
}

.desc {
  margin: 5px 0 22px;
  font-size: 14px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
}

.label {
  font-size: 12.5px;
  color: var(--text-secondary);
}

.notice {
  margin-bottom: 14px;
  padding: 8px 10px;
  border-radius: var(--radius-inner);
  font-size: 13px;
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--warn) 20%, transparent);
}

.invalid {
  border-color: var(--down);
}

.invalid:focus {
  border-color: var(--down);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--down) 14%, transparent);
}

.err {
  margin-top: 2px;
  font-size: 13px;
  color: var(--down);
}

.submit {
  margin-top: 18px;
  width: 100%;
}

.first-run {
  margin-top: 16px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-tertiary);
}

@keyframes shake {
  0%,
  100% {
    transform: translateX(0);
  }
  25% {
    transform: translateX(-5px);
  }
  75% {
    transform: translateX(5px);
  }
}

.shake {
  animation: shake 0.24s var(--ease);
}
</style>
