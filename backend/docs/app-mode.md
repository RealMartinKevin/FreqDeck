# 自托管 App 模式（app mode）设计与使用说明

> 分支：`mydev`（基于 `stable` tag 2026.10）
> 本文只描述**已实现且已实测**的行为。未验证的部分在 §9 明确列出。

---

## 1. 目标与设计取舍

你要的三件事，落地后的对应关系：

| 你的要求 | 实现方式 |
| --- | --- |
| 放弃原有初始化流程（`new-config` 交互问答 / `-c config.json`） | 配置改由本地存储 `user_data/app/state.json` 提供，`Configuration.load_config()` 在读文件之前分流 |
| 无条件直接启动 | `freqtrade` 裸命令即可启动；无参数时自动进入 `app` 子命令；首启自动生成账号密码 |
| 运行 WebUI | 复用 freqtrade 自带的 SPA 托管（`router_ui`），`app.ui_path` 可指向任意构建目录 |
| init 只生成账号密码 | 首次启动生成 username/password/jwt_secret_key/signal_token，打印一次并落盘 0600 |
| 配置全部收归 WebUI | `GET/PUT /api/v1/app/config`，写入后走 freqtrade 原生 `RELOAD_CONFIG` 热载 |
| 新增外部信号 API | `POST /api/v1/signal`，独立 `X-Signal-Token`，即时强制开/平仓 |

### 为什么是「两段式」而不是一上来就跑交易

freqtrade 在 trade 模式初始化时会连交易所拉 markets。默认配置若指向一个当前网络不可达的交易所，
进程会直接崩掉——那就不是「无条件启动」了。

所以守护流程是：

```
shell 模式（默认）          用户在 UI 填好配置             trade 模式
API + UI，不连交易所   ──────────────────────────►   交易所 + 策略 + 交易循环 + API + UI
```

`shell` 模式使用 freqtrade 原生的 `RunMode.WEBSERVER`：不创建 `FreqtradeBot`、不连交易所，
交易类端点由上游的 `is_trading_mode` 依赖自动返回 503。

**补充（实测修正）**：本机 WSL 里 `curl https://api.okx.com/...` 返回 `000`，但 ccxt 实际能连上 OKX
并成功初始化（日志 `Using Exchange "OKX"`，随后状态进入 RUNNING）。所以不要用 curl 的结果判断交易所可达性，
ccxt 走的是另一套请求封装。

### 自愈策略

`trade` 启动失败（交易所不通、策略解析失败、key 无效）时不退出进程，而是：

1. 把异常写入 `last_error`，模式回退为 `shell`
2. 原地启动 shell 服务

控制面板不会因为一次启动失败而消失。`last_error` 可在 `GET /api/v1/app/info` 看到。

---

## 2. 启动

```bash
cd /home/bing/code/freqtrade
source .venv/bin/activate

freqtrade                        # 等价于 freqtrade app，读 user_data/app/state.json
freqtrade app --user-data-dir /path/to/user_data
```

首次启动会打印一次凭据（之后不再打印）：

```
 freqtrade app initialised. Credentials were generated (shown once):
   state file : /home/bing/code/freqtrade/user_data/app/state.json  (mode 0600)
   username   : admin
   password   : <generated, 16 chars>
   jwt secret : <generated, 64 hex>
   signal tok : <generated, 64 hex>
   web ui     : http://127.0.0.1:8080/
```

冷启动（首次 import pandas/talib）约 20s，热启动约 2s。这是上游导入成本，不是改造引入的。

---

## 3. 改动清单

新增：

| 文件 | 作用 |
| --- | --- |
| `freqtrade/app/__init__.py` | 包导出 |
| `freqtrade/app/defaults.py` | 默认配置（同时满足 webserver + trade 两份 schema）、需重启的键、脱敏键名 |
| `freqtrade/app/store.py` | 状态读写（原子写 + 0600）、凭据生成、迁移修复、脱敏/反脱敏合并 |
| `freqtrade/app/runtime.py` | shell/trade 分发、失败回退、`execv` 重入、原始 argv 保留 |
| `freqtrade/commands/app_commands.py` | `start_app` 入口 |
| `freqtrade/rpc/api_server/api_app.py` | `/api/v1/app/*` 与 `/api/v1/signal` |
| `tests/app/test_app_store.py` | 状态层 18 项测试 |
| `tests/app/test_app_api.py` | API 纯逻辑测试 |

修改（改动均很小，便于与上游合并）：

| 文件 | 改动 |
| --- | --- |
| `freqtrade/main.py` | 无参数时 `argv = ["app"]` |
| `freqtrade/commands/arguments.py` | 注册 `app` 子命令；`from freqtrade.commands` 导入 `start_app` |
| `freqtrade/commands/__init__.py` | 导出 `start_app` |
| `freqtrade/configuration/configuration.py` | `load_config()` 中按 `args["app_state_path"]` 从存储读配置（**每次重新读盘**） |
| `freqtrade/rpc/api_server/webserver.py` | 挂载 `router_app`（需管理员认证）与 `router_signal`（独立令牌） |
| `freqtrade/rpc/api_server/web_ui.py` | SPA 根目录支持 `app.ui_path` |

### 一个容易忽略的关键点

`Configuration` 注入的是**路径**而不是配置字典。因为 `Worker.run()` 收到 `RELOAD_CONFIG` 会重新执行
`Configuration(...).get_config()`；若注入内存快照，热载会静默回到进程启动时的那份旧配置。

---

## 4. 配置 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/app/info` | 版本 / 模式 / runmode / dry_run / 是否在交易 / `last_error` / `ui_ready` |
| GET | `/api/v1/app/config` | 返回**脱敏**配置 + 需重启的键清单 |
| PUT | `/api/v1/app/config` | 部分深合并写入；`apply=true` 时触发重载 |
| POST | `/api/v1/app/mode` | `{"mode":"shell"\|"trade"}`，持久化后 `execv` 重入 |
| POST | `/api/v1/app/reload` | 手动触发 `RELOAD_CONFIG` |
| POST | `/api/v1/app/restart` | `execv` 重启进程 |
| POST | `/api/v1/app/password` | 轮换管理员口令（需当前口令） |

全部需要管理员认证（HTTP Basic 或 Bearer JWT）。

### 动作类端点的响应契约（`ModeAccepted`）

```
{ "accepted": bool, "mode": "shell" | "trade", "outcome": string | null, "message": string }
```

- `mode` **恒为当前真实运行模式**，永远不是动作结果。早期版本把 `reloaded` / `restarting` /
  硬编码的 `"shell"` 塞进这个字段，导致改密码成功后客户端读到 `mode:"shell"`、而同一时刻
  `GET /app/info` 报 `mode:"trade"`。已拆出 `outcome`。
- `outcome` 承载动作结果：`switching` | `reloaded` | `reload_pending` | `reload_failed` |
  `password_updated` | `restarting`。
- `accepted` 的语义**按端点不同**：`/app/reload` 表示「热载是否成功」，其余表示「请求是否被接受」。

### 脱敏往返语义（重要）

`GET` 会把握手密钥类字段替换为 `***redacted***`。前端把整份配置回传时，值等于该掩码的字段
**保持原值不变**（`unredact_merge`）。否则浏览器一存就会把真实 exchange key 覆盖成字面量掩码。

空字符串不会被掩码，这样 UI 能显示「未配置」。

### 热载 vs 重启

改动后走 freqtrade 原生 `Worker._reconfigure()`：`cleanup()` 旧 bot → 用新配置重建
`FreqtradeBot`。因此**交易所、策略、stake、时间框架等都能热载**，不需要重启进程。

只有这几个键需要真正重启（`restart_only_paths`）：

```
api_server.listen_ip_address / api_server.listen_port / api_server.enabled / db_url
```

原因：`ApiServer` 是单例，uvicorn 已绑定的监听不会因配置重载而迁移；`db_url` 变更涉及持久层语义。

### 校验

写入前用上游 `validate_config_schema()` 校验（在**副本**上校验——上游校验器会注入 schema 默认值，
直接校验真对象会把默认值写进存储，并让 changed 列表误报）。非法配置返回 400。

---

## 5. 信号 API

独立令牌，与管理口令分离：外部系统（TradingView webhook、自研程序）不应持有管理员权限，
轮换信号令牌也不该把人锁在 UI 外面。

```
POST /api/v1/signal
X-Signal-Token: <app.signal_token>
Content-Type: application/json
```

| action | 必填 | 行为 |
| --- | --- | --- |
| `buy` | `pair` | `_rpc_force_entry(side=long)` |
| `sell` | `pair` | `side=short`；spot 模式下返回 400 |
| `close` | `trade_id` 或 `pair` | 按 id 平仓，或平掉该 pair 的所有持仓 |
| `close_all` | — | 平掉所有持仓 |

可选字段：`stake_amount`（数字或 `"unlimited"`）、`price`、`order_type`（`market`/`limit`）、
`leverage`、`tag`（默认 `external_signal`）。

示例：

```bash
TOK=$(python -c "import json;print(json.load(open('user_data/app/state.json'))['config']['app']['signal_token'])")

curl -X POST http://127.0.0.1:8080/api/v1/signal \
  -H "X-Signal-Token: $TOK" -H 'Content-Type: application/json' \
  -d '{"action":"buy","pair":"BTC/USDT","tag":"tv_webhook"}'

curl -X POST http://127.0.0.1:8080/api/v1/signal \
  -H "X-Signal-Token: $TOK" -H 'Content-Type: application/json' \
  -d '{"action":"close_all"}'
```

响应（逐笔结果，不因单笔失败而整体 500）：

```json
{"ok": true, "action": "buy",
 "results": [{"trade_id": 1, "pair": "BTC/USDT", "side": "long", "status": "entered"}],
 "errors": []}
```

错误码语义：

| 码 | 含义 |
| --- | --- |
| 401 | 令牌缺失/错误 |
| 400 | 参数缺失、spot 下做空、`ui_path` 非法 |
| 409 | `force_entry_enable` 为 false（信号驱动开仓被关闭） |
| 503 | 当前不在交易模式（`runmode` 不是 trade） |

`GET /api/v1/signal/health` 返回 `ok/runmode/dry_run/open_trades`，适合做探活。

### 语义边界（请确认这是你要的）

这是**即时强制开/平仓**，绕过策略入场信号，但仍经过 freqtrade 内部护栏：
pair 白名单、`max_open_trades`、stake 上限、protection 锁。它**不会**做技术面判断，
也不区分「策略本来会不会开」。如果你之后想要「信号进队列、由策略消费」，那是另一条通道。

---

## 6. UI 托管

```json
PUT /api/v1/app/config
{"config": {"app": {"ui_path": "/path/to/vue/dist"}}}
```

空闲时用内置 `freqtrade/rpc/api_server/ui/installed/`；`ui_path` 指向你的构建目录即可生效，
不需要把产物拷进 freqtrade 包（否则会污染工作树、被 `pip install -e` 的清理逻辑影响）。

已验证：`/` 返回自定义 `index.html`、任意前端路由回退到 `index.html`、`/assets/*` 正确 MIME、
`/api/*` 未知路径保持 JSON 404、编码穿越路径被拦截、`.env` 404。

**安全校验**：`ui_path` 会拒绝三类值——非绝对路径、文件系统根目录、**包含 state.json 的目录**
（指向 `user_data` 会把含明文口令的 `app/state.json` 当静态文件暴露）。

---

## 7. 安全边界

1. **凭据以明文存储在 0600 文件内**，与上游 `config.json` 同一姿势。做成哈希会破坏 HTTP Basic 与 JWT 签名，
   而进程本来就必须能读到明文，收益是零。
2. `force_entry_enable` 默认 `True`（上游默认 False）。这是信号驱动开仓的前提；
   如果这个 bot 绝不允许被外部手动开仓，在 UI 里关掉它，信号接口会返回 409。
3. 信号令牌 `signal_token` 只授予「开/平仓」，不能改配置、不能读状态详情。
4. `api_server` 默认绑 `127.0.0.1`。要远程访问请走反代并自行加固（TLS、鉴权、来源白名单）。
5. 管理员认证沿用上游：HTTP Basic 或 JWT（`POST /api/v1/token/login`，**用 Basic 头**提交用户名口令，
   返回 `access_token` / `refresh_token`）。

---

## 8. 前端迁移对照表（你那套 Vue → freqtrade API）

你的 `client.ts` 现在是 **cookie 会话 + `X-Requested-With: ftm` + 多实例路径**；freqtrade 是
**Basic/JWT + `/api/v1/*` + 单实例**。逐条映射：

| 前端现有调用 | 改成 | 备注 |
| --- | --- | --- |
| `POST /api/auth/login {password}` | `POST /api/v1/token/login`（Basic 头） | 返回 JWT，存内存/localStorage，后续带 `Authorization: Bearer` |
| `POST /api/auth/logout` | 前端删除 token | 服务端无状态 |
| `GET /api/auth/me` | `GET /api/v1/app/info` | 401 即未登录 |
| `POST /api/auth/*` CSRF 头 | 删除 `X-Requested-With` | 不再需要 |
| `GET /api/dashboard/overview` | `/api/v1/profit` + `/api/v1/status` + `/api/v1/balance` | 三个请求合一个视图 |
| `GET /api/positions/open` | `GET /api/v1/status` | |
| `POST /api/positions/{id}/{tradeId}/force-exit` | `POST /api/v1/forceexit {tradeid}` | 去掉了 instanceId |
| `POST .../cancel-order` | `DELETE /api/v1/trades/{tradeid}/open-order` | |
| `GET /api/trades?...` | `GET /api/v1/trades?limit=&offset=` | 服务端不支持 exit_reason/pair 过滤，前端筛 |
| `GET /api/instances/{id}/candles` | `GET /api/v1/pair_candles?pair=&timeframe=&limit=` | |
| `GET /api/instances/{id}/logs` | `GET /api/v1/logs?limit=` | |
| `GET /api/instances/{id}/sysinfo` | `GET /api/v1/sysinfo` | |
| `GET /api/instances/{id}/config` | `GET /api/v1/app/config`（可编辑、已脱敏） | 原 `show_config` 只读且不含全量 |
| `GET /api/instances/{id}/analytics` | `/api/v1/daily` `weekly` `monthly` `profit` | |
| `GET /api/instances/{id}/pairlist` | `/api/v1/whitelist` `blacklist` | |
| lifecycle start/stop/pause | `/api/v1/start` `stop` `pause` | |
| instances CRUD / provision / provision-preview | **删除** | 单实例，无 systemd 托管 |
| `GET /api/compare` | **删除或改造** | 多实例对比在单实例下无意义 |
| chart-meta | 前端从 `app/config` 取 `timeframe` 与 `exchange.pair_whitelist` | 无对应端点 |

同时需要改的整体结构：

1. `src/api/client.ts` 的 `request()`：去掉 `credentials: 'same-origin'` 与 CSRF 头，加 `Authorization`。
2. 所有 `instances/{id}` 相关状态与组件（`InstanceCard` `InstanceForm` `InstanceDialogs`
   `CompareCard` `Compare.vue`）在单实例模型下要么删除，要么降级为「当前实例」展示。
3. `vite.config.ts` 的 `build.outDir` 建议直接指向构建目录，然后把 `app.ui_path` 指向它；
   或 `outDir: '../backend/app/static'` 保持不变但让 freqtrade 指向该目录。
4. Vite 的 `base` 仍是 `/`，与 freqtrade 的 `/` 托管一致——这点不用改。

---

## 9. 已验证 / 未验证

**已实测通过**

- `freqtrade` 裸启动、`freqtrade app --user-data-dir`、首启生成凭据、二次启动凭据不变
- `state.json` 权限 0600；原子写无残留临时文件
- `GET/PUT /app/config`：脱敏、掩码往返不丢真实密钥、非法配置 400、`changed` 精确
- 模式切换 shell → trade：`execv` 保留原 argv（含 `--user-data-dir`）、端口无冲突、状态进入 RUNNING
- 信号：`buy` 建仓（trade_id=1）→ `close_all` 平仓成功；无令牌/错令牌 401；spot 做空 400；未知 trade_id 进 errors
- UI：自定义目录托管、SPA 回退、静态资源 MIME、编码穿越拦截、`ui_path` 三类非法值拒绝
- `ruff check` 与 `ruff format --check` 全过；`tests/app/` + `tests/test_configuration.py` 98 passed
- `tests/rpc/test_rpc_apiserver.py` 185 passed，2 failed 均为缺可选依赖（`optuna`、freqai），与本次改动无关

**未验证**

- 实盘（非 dry-run）下单路径
- 真实期货/杠杆开空（当前默认 spot，卖空被 400 拦住是**预期行为**，未测 futures 下的 short 成功路径）
- 长时间运行下的 `RELOAD_CONFIG` 反复重载（单次已验证，未做压力测试）
- 前端迁移（尚未动手，见 §8）
- systemd 托管下的 `Restart=always` 重启策略（`execv` 路径已测，systemd 拉起未测）

---

## 10. 已知限制

1. **`execv` 重启不做优雅退出**：切换模式/重启时不会走 `FreqtradeBot.cleanup()`，
   已有挂单不会被撤销（dry-run 无所谓；实盘请把 `cancel_open_orders_on_exit` 与运维流程一起设计）。
   交易记录本身在 SQLite 里持续落盘，不会丢。
2. **单实例**：一套 `state.json` 对应一个 bot。要多 bot 就是多份 user_data + 不同端口。
3. **配置 API 无并发控制**：两个浏览器同时 PUT 会后者覆盖前者（last-write-wins）。
4. **`force_entry_enable` 默认开启**，见 §7.2。
