import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { applyDocumentLocale } from './i18n'
import './styles/tokens.css'

// index.html 的首帧脚本已按 localStorage 设置过 lang/title，这里同步一次，
// 保证通过 t() 得到的标题与当前 locale 严格一致。
applyDocumentLocale()

createApp(App).use(router).mount('#app')
