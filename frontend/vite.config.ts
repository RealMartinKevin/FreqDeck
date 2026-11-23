import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

const DEFAULT_API_TARGET = 'http://127.0.0.1:8080'

// 用函数式配置：代理地址要在启动时读取环境变量，否则改了后端监听端口（8080→18080）
// 就必须手改这个文件，而这类改动几乎总会被忘掉，症状是「登录没反应」而不是报错。
// 用 loadEnv 而不是 process.env：本仓库没装 @types/node，tsconfig 的 types 也只含
// vite/client，直接引 process 会过不了 typecheck。
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'VITE_')
  // 末尾斜杠会让代理拼出 //api/v1/...，这里统一抹掉
  const apiTarget = (env.VITE_API_TARGET || DEFAULT_API_TARGET).replace(/\/+$/, '')

  return {
    plugins: [vue()],
    base: '/',
    build: {
      // 产物落在本地 dist，再由 freqtrade 的 app.ui_path 指过来（不再直接写进后端仓库：
      // 后端目录不是本仓库的一部分，构建产物混进版本库会天天产生脏 diff）
      outDir: 'dist',
      emptyOutDir: true,
    },
    server: {
      proxy: {
        // 旧版管理服务在 8000 且已废弃；freqtrade app 模式默认跑在 8080（.probe/app_info_boot.json）
        '/api': { target: apiTarget, changeOrigin: false },
      },
    },
  }
})
