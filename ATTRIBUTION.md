# 上游基线

| 项 | 值 |
| --- | --- |
| 上游 | [freqtrade/freqtrade](https://github.com/freqtrade/freqtrade) |
| 基线分支 | `stable` |
| 基线 tag | `2026.10` |
| 基线提交 | `4cf0351e0`（Merge pull request #13725 from freqtrade/new_release） |
| 上游许可证 | GPL-3.0，原文保留在 `backend/LICENSE` |
| 本地开发提交 | `b5ba44202 feat: self-hosted app mode with a local config store` |

本仓库把该快照压缩为单个提交，**不含上游历史**。上游 `origin` 仍保留在开发机的
WSL 克隆里，可继续同步。

---

# 对上游 freqtrade 的改动

## 新增

| 路径 | 作用 |
| --- | --- |
| `freqtrade/app/defaults.py` | app 模式默认配置。默认 `okx`、`dry_run`、`force_entry_enable: true`；不放 `protections: []`（会触发上游废弃配置报错） |
| `freqtrade/app/store.py` | `user_data/app/state.json` 的创建/读取/保存，权限 0600；首启生成 `admin`、随机口令、JWT secret、signal token；校验 `ui_path` 不得指向会暴露状态文件的目录 |
| `freqtrade/app/runtime.py` | `shell` / `trade` 双模式调度；trade 启动失败回退 shell 并记 `last_error`；`execv` 重入时保留原始 argv |
| `freqtrade/app/__init__.py` | 包导出 |
| `freqtrade/commands/app_commands.py` | `app` 子命令入口 |
| `freqtrade/rpc/api_server/api_app.py` | app 管理 API（info / config / mode / reload / password / restart）+ 外部信号 API（signal / signal/health） |
| `tests/app/` | 状态存储与 app API 测试 |
| `docs/app-mode.md` | 后端改造的契约与交接文档 |

## 修改

| 路径 | 改动 |
| --- | --- |
| `freqtrade/main.py` | 无子命令时默认走 `app`，实现「裸启动即运行」 |
| `freqtrade/commands/arguments.py` | 注册 `app` 子命令；`ARGS_APP` 为空，复用 common parser 的 `--user-data-dir` |
| `freqtrade/commands/__init__.py` | 导出 `start_app` |
| `freqtrade/configuration/configuration.py` | 配置源从 `args["config"]` 改为 `args["app_state_path"]`；注入的是**路径**而不是配置快照，否则 `RELOAD_CONFIG` 会重新读到旧值 |
| `freqtrade/rpc/api_server/webserver.py` | 挂载 app router（管理员鉴权）与 signal router（独立令牌鉴权） |
| `freqtrade/rpc/api_server/web_ui.py` | 支持 `app.ui_path` 指向外部 SPA 构建目录；非 `/api` 路径回退 `index.html`；保留目录穿越与敏感文件防护 |

## 未改动

其余上游代码、策略、交易所适配器、回测/超参等能力保持原样。FreqDeck 只是换掉了
「怎么启动、配置从哪来、界面怎么接」这一层，没有改写交易逻辑。

---

# `frontend/` 的来源

`frontend/` 是为本项目独立编写的 Vue 3 + Vite 应用，通过 REST 调用 freqtrade 的 API，
**没有复制或改写 freqtrade 的源码**。它原本是一个多实例聚合管理台，改造为单实例控制台：

- 新增 `src/api/ft/` 适配层，把 freqtrade 响应映射成既有类型；`src/api/client.ts`
  保留原来的门面导出，20 处既有 import 不用改。
- 认证从 cookie 会话改为 HTTP Basic 换 JWT + Bearer；401 单飞 refresh。
- 删除实例 CRUD、Compare 视图与实例选择器，新增配置页与模式切换 UI。
- 界面每页显示 **Powered by Freqtrade** 页脚（`src/App.vue`）。

作为与 GPL-3.0 后端组合交付的整体，`frontend/` 同样以 GPL-3.0 发布。

---

# 第三方组件

前端依赖见 `frontend/package.json`（Vue、vue-router、echarts、lightweight-charts、
Vite、TypeScript、vue-tsc），各自许可证由对应上游项目规定。后端依赖见
`backend/pyproject.toml`。
