/**
 * 门面（4 行）：把旧的 `src/api/client.ts` 变成适配层的转出口。
 *
 * 为什么这么改：12 个展示组件 + 6 个 view 都写着
 *   `import { api, NetworkError, UnauthorizedError } from '../api/client'`
 * 改成纯 re-export 后，这些 import **一行都不用动**，而 `e instanceof NetworkError`
 * 这类既有 catch 分支也继续成立（新错误类是 ApiFailure 的子类，继承关系兼容）。
 */

export * from './ft/errors'
export * from './ft/client'

/**
 * 路由守卫用：**只看本地有没有 refresh 令牌**，不打网络。
 *
 * 从门面导出而不是让 router 深链 `./ft/auth`：一旦允许深链，`ft/` 内部怎么拆文件
 * 都会漏到页面层。这里显式列出来，等于把「公共面」再钉一次。
 */
export { hasSession } from './ft/auth'
