# FreqDeck

**简体中文** | [English](README.en.md)

**Powered by [Freqtrade](https://github.com/freqtrade/freqtrade).**

一个自包含的单体交易控制台：一个进程、一个 bot、一个 Web 界面。不需要 `config.json`，
不需要 `freqtrade new-config`，启动即用；账号密码在首次启动时生成一次，其余配置全部在
网页里改。

> FreqDeck is a self-hosted trading console built on top of freqtrade. It is a
> derivative work and is distributed under **GPL-3.0**. See [NOTICE](NOTICE) and
> [ATTRIBUTION.md](ATTRIBUTION.md).

---

## 它解决什么问题

上游 freqtrade 的常规用法是：先准备一份 `config.json`，再挑一个子命令启动，WebUI 只是
可选附件。FreqDeck 把它翻过来：

- **裸启动即运行**：`freqtrade` 不带参数直接进 app 模式，配置来自本地状态文件。
- **配置收归 WebUI**：交易所、密钥、资金、策略、ROI、止损、监听地址、管理员口令、
  信号令牌，全部在 `/config` 页编辑并热载。
- **两种模式**：`shell` 只跑 API + 界面（排查问题用），`trade` 跑真实 bot；
  bot 启动失败会自动回退 `shell` 并把原始错误显示出来。
- **外部信号通道**：`POST /api/v1/signal` 用独立的 `X-Signal-Token`，机器调用方
  不持有管理员口令。

界面包含：看板 / 持仓 / K 线 / 统计 / 配置 / 运维，六个页面，单实例，无多租户概念。

---

## 目录结构

```
FreqDeck/
├── LICENSE            # GPL-3.0（沿用仓库初始提交）
├── NOTICE             # 版权与衍生作品声明
├── ATTRIBUTION.md     # 上游基线 + 逐项改动清单
├── backend/           # freqtrade 衍生版本（源码快照，不含上游历史）
└── frontend/          # Vue 3 + Vite 控制台
```

**关于 `backend/` 的历史**：这是 fork 在 `stable`（tag `2026.10`，上游提交
`4cf0351e0`）之上的工作树快照，**压缩为单个提交**，没有携带上游两万多条提交和
约 850MB 的对象库。上游 `origin` 仍保留在开发机的 WSL 克隆里，可以继续
`git fetch` / `git merge` 同步。需要完整上游历史时，请直接看
[freqtrade/freqtrade](https://github.com/freqtrade/freqtrade)。

---

## 快速开始

环境：Linux / WSL2，Python ≥ 3.12（开发机用 3.14），Node ≥ 20。

### 1. 后端

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -e ".[develop,plot]"      # TA-Lib 有 manylinux 预编译轮子，无需 sudo

# 首次启动：生成 admin + 随机口令 + JWT secret + signal token，打印一次
.venv/bin/python -m freqtrade app --user-data-dir /path/to/user_data
```

状态文件是 `user_data/app/state.json`（权限 0600），它是配置的唯一真源。
浏览器打开 `http://127.0.0.1:8080/`，用首次打印的口令登录。

### 2. 前端

```bash
cd frontend
npm install
npm run build            # 产物在 frontend/dist/
npm run typecheck        # 可选，vue-tsc --noEmit
```

然后把 `app.ui_path` 指到构建产物的绝对路径（在 `/config` 页的「高级」里能看到当前值，
也可以直接改状态文件后重启）：

```json
{
  "config": {
    "app": { "ui_path": "/abs/path/to/FreqDeck/frontend/dist" }
  }
}
```

或者用 API：

```bash
curl -u admin:<password> -X POST http://127.0.0.1:8080/api/v1/token/login
curl -H "Authorization: Bearer <access_token>" -X PUT \
     -H 'Content-Type: application/json' \
     -d '{"config":{"app":{"ui_path":"/abs/path/to/FreqDeck/frontend/dist"}}}' \
     http://127.0.0.1:8080/api/v1/app/config
```

开发模式下 `npm run dev` 会把 `/api` 代理到后端；后端改了监听端口就用
`VITE_API_TARGET` 指定（见 `frontend/.env.example`），不要改 `vite.config.ts`。

### 3. 外部信号

```bash
curl -H 'X-Signal-Token: <signal token>' -H 'Content-Type: application/json' \
     -d '{"action":"buy","pair":"BTC/USDT"}' \
     http://127.0.0.1:8080/api/v1/signal
```

`GET /api/v1/signal/health` 是无副作用的鉴权探针。`actions` 支持
`buy` / `sell` / `close` / `close_all`，本质是 `forceenter` / `forceexit` 的即时通道。

---

## API 一览

| 端点 | 说明 |
| --- | --- |
| `POST /api/v1/token/login` | HTTP Basic → JWT |
| `GET /api/v1/app/info` | 版本 / 模式 / runmode / 是否在交易 / `last_error` |
| `GET\|PUT /api/v1/app/config` | 读取（脱敏）/ 部分深合并写入并热载 |
| `POST /api/v1/app/mode` | `{"mode":"shell"\|"trade"}`，持久化后 `execv` 重入 |
| `POST /api/v1/app/reload` / `restart` / `password` | 手动热载 / 重启 / 轮换口令 |
| `POST /api/v1/signal` / `GET /api/v1/signal/health` | 外部信号 |

动作类端点返回 `ModeAccepted`：`mode` 恒为真实运行模式，动作结果放 `outcome`
（`switching` / `reloaded` / `password_updated` / `restarting` …）。

完整契约见 `backend/docs/app-mode.md`。

---

## 状态与验证

前端 B01–B08 与后端 app mode 已在**真实浏览器 + 真实后端**（OKX dry-run、1 笔在仓 +
2 笔已平仓）下完成端到端验证：六页渲染、SPA 深链接、观察模式空态、配置保存与热载、
双向模式切换、改口令、令牌轮换、立即重启全部实测通过。后端 API 契约见
`backend/docs/app-mode.md`。

仍需注意：

- 默认 `dry_run: true`。改实盘要在配置页明确关闭，并在模式切换弹窗里键入 `LIVE`。
- `api_server.listen_ip_address` / `listen_port` 改动需要重启才生效，且重启后要用新地址访问。
- 密钥类字段在界面里只显示「已配置」，掩码值不会被回写，避免把真实口令覆盖成
  字面量 `***redacted***`。

---

## 许可证

**GPL-3.0**。FreqDeck 是 freqtrade 的衍生作品，上游版权归 freqtrade 贡献者所有。
详情见 [NOTICE](NOTICE) 与 [ATTRIBUTION.md](ATTRIBUTION.md)。

**Powered by Freqtrade** — <https://github.com/freqtrade/freqtrade>
