# dsh-delegate 🐋

> **模型感知的子代理委派工具包** — 给 DeepSeek Harness 的 `subagent` / `subagent_fork` 加上：按次选模型、依赖门控、角色人设、任务花名册、审计事件与对话流卡片。
>
> Model-aware subagent delegation for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): per-call models, dependency gating, personas, a durable run roster, audit events, and conversation-flow tool cards.

[![version](https://img.shields.io/badge/version-0.3.1-blue)](package.json)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-9cf)](https://github.com/topics/dsh-plugin)

> 仓库名 `dsh-delegate` 是品牌名；npm 包名保持 `dsh-tool-subagent-model`（与既有安装兼容，安装命令见下文）。

---

## 为什么需要它

官方 `subagent` / `subagent_fork` 工具的子代理模型跟随主 agent，无法**按次指定**。多步委派时，"先做 A 再做 B"只能靠模型自己在对话里记忆，容易乱序、漏等、重复。

本插件在**官方工具的语义之上**加了两层：

1. **按次选模型**：每个子代理可以指定不同模型（快模型做机械活、强模型做关键活），自动路由到正确的提供商；
2. **轻量治理层**（v0.3.0+）：任务花名册（`subagent_status`）、`task_id` / `depends_on` 依赖门控、`persona` 角色人设、审计事件、对话流卡片——**协调状态落在磁盘上，不再烧主 agent 上下文**。

无遥测、无外部网络请求（仅调用你已配置的模型提供商）。

## ✨ 功能一览

- **按次选模型**：`model` 参数枚举来自 Web「模型」页的模型目录，`provider` 自动路由（优先主 agent 路由，唯一路由自动选中，多路由歧义时显式报错并列出选项）；模型列表随设置热更新。
- **依赖门控**：`task_id` 命名一次委派，`depends_on` 声明依赖——依赖未满足时工具**拒绝启动**并列出未满足项（含当前状态），把"按顺序执行"变成确定性约束。
- **角色人设**：`persona` 参数给子代理注入自定义人设，随子代理 descriptor 持久化，冷恢复时重新应用。
- **任务花名册**：`subagent_status` 工具输出当前工作区的全部委派记录（task_id / 状态 / 模型 / 驻留活动 / 依赖链 / 结果摘要）。
- **审计事件**：每次委派向会话日志追加 `subagent-model/run-started | run-settled` 事件（只进日志、不进模型历史），可审计、可复盘。
- **对话流卡片**：浏览器端为委派工具渲染状态卡片（实时状态徽章、依赖、人设、结果摘要、一键打开子会话），为花名册工具渲染表格视图。
- **设置卡片**：设置 → 插件 → 插件配置里编辑默认子代理模型 / 默认 max tokens / 委派深度上限。
- **总开关**：`trackRuns: false` 一键回到纯委派模式（v0.2.x 行为）。

## 📦 安装

前置要求：Node.js `^22.19` 或 `>=24`，已安装 DeepSeek Harness。

**第 1 步 · 安装插件包：**

```sh
dsh plugin --profile web add github:FEOH333/dsh-delegate
```

**第 2 步 · 在 profile 的 `cordis.patch.yml` 里挂两个工具实例**（`$DSH_HOME/profiles/web/cordis.patch.yml`）：

```yaml
- insert:
    - id: subagent-model
      name: dsh-tool-subagent-model
      config:
        provider: spawn          # 全新上下文的子代理
        toolName: subagent_with_model
        backgroundMode: continuable
    - id: subagent-fork-model
      name: dsh-tool-subagent-model
      config:
        provider: fork           # 继承当前对话的子代理
        toolName: subagent_fork_with_model
        backgroundMode: continuable
```

**第 3 步 · 重启 dsh web 并刷新页面**（host 改动需要重启进程；浏览器强刷即可加载客户端）。

工具注册在宿主全局层，所有会话、所有预设的 agent 都能看到（子代理自身的嵌套委派受 `maxDepth` 限制，默认 3）。

**卸载**：从 `cordis.patch.yml` 删除两个 insert 行并重启；注册表目录 `.dsh-subagents/` 留在各工作区，可手动清理。

## 🚀 使用

### 工具一览

| 工具名 | 提供商 | 用途 |
|---|---|---|
| `subagent_with_model` | `spawn` | 全新上下文的子代理，可指定模型 |
| `subagent_fork_with_model` | `fork` | 继承当前对话上下文的子代理，可指定模型 |
| `subagent_status` | —（进程级共享）| 查看当前工作区的委派花名册 |

### 调用参数

| 参数 | 说明 |
|---|---|
| `description` / `prompt` / `run_in_background` | 与官方 `subagent` 工具语义一致 |
| `model`（可选）| 子代理模型 id（枚举来自模型页）；省略 → 设置卡片默认值 → 继承主 agent 模型 |
| `provider`（可选）| 提供商路由；省略时自动解析（优先当前路由 → 唯一路由 → 歧义报错列出选项） |
| `max_tokens`（可选）| 子代理最大输出 token；省略 → 设置卡片默认值 |
| `task_id`（可选）| 给本次委派起名（如 `t-research`）；省略时等于 run id；其他委派可用它做 `depends_on` |
| `depends_on`（可选）| 依赖的 task_id 列表：全部满足（`completed` / `idle`）才启动，否则报错列出未满足项 |
| `persona`（可选）| 子代理角色人设：替换该子代理的部署人设（continuable 子代理持久化并在冷恢复时重应用）；提供商需支持 persona 能力 |

### 示例

```
subagent_with_model(description="整理日志", prompt="……", model="<你的快模型>")

subagent_fork_with_model(
  description="评审方案", prompt="……",
  task_id="t-review", depends_on=["t-research"],
  persona="你是一名资深代码评审，只指出真实缺陷，不客套。"
)

subagent_status()   # 查看所有委派的状态与 task_id
```

### 运行状态语义

| 状态 | 含义 | 满足 `depends_on` |
|---|---|---|
| `running` | 子代理正在工作 | 否 |
| `idle` | continuable 子代理干净结束一轮（仍可被继续唤醒）| ✅ |
| `completed` | 前台 / 后台一次性任务完成 | ✅ |
| `failed` / `cancelled` | 失败 / 取消（终态，不可回退）| 否 |

### 注册表文件

每次委派追加一条记录到 `<workspace>/.dsh-subagents/runs.jsonl`（追加式 JSONL，按 runId last-write-wins 折叠，超 400 行自动压缩为"活跃 + 近期终态"）。目录名可用 `stateDir` 配置；`stateDir: ""` 为纯内存模式，不写任何文件。多进程同时写同一工作区不保证一致（单 dsh 进程内已用 promise 链锁串行化）。

## ⚙️ 配置项（每个实例）

| 键 | 默认 | 含义 |
|---|---|---|
| `provider` | 必填 | `ctx.subagents` 提供商名（`spawn` / `fork` / …） |
| `toolName` | `subagent_with_model` | 模型可见的工具名，每个实例必须不同 |
| `backgroundMode` | `continuable` | `continuable`（默认后台、返回持久子代理 id）或 `one-shot` |
| `maxDepth` | `3` | 委派深度上限；`0` 禁止委派；`provider-managed` 交给提供商 |
| `stateDir` | `.dsh-subagents` | 注册表目录名（工作区下）；`""` = 纯内存跟踪 |
| `statusToolName` | `subagent_status` | 花名册工具名；`""` 禁用；进程内只注册一次（首个实例生效） |
| `trackRuns` | `true` | 总开关：`false` 完全关闭注册表 / 事件 / 门控 / 花名册，回到 v0.2.x 行为 |

## 🖥️ Web UI

- **设置卡片**（设置 → 插件 → 插件配置 → 子代理模型）：编辑省略参数时的默认值（默认模型 / 默认 max tokens / 委派深度上限）。数据走插件自己的 `/api/subagent-model/*` 路由，写路由带 loopback + 同源信任围栏。
- **委派卡片**：对话流中 `subagent_with_model` / `subagent_fork_with_model` 的工具调用渲染为状态卡（标签 / 模型 / 状态徽章 / task / 依赖 / 人设折叠 / 结果摘要 / 打开子会话），2.5s 轮询花名册路由，状态终态后自动停止。
- **花名册卡片**：`subagent_status` 工具调用渲染为实时表格视图。
- 若未来 shell 缺少相关 slot / 服务，卡片自动降级（仅隐藏跳转按钮），不影响设置卡片。

## 🏗️ 工作原理

```
模型调用 subagent_with_model(...)
        │
        ├─ 依赖门控：depends_on 全部满足才放行（否则报错列出未满足项）
        ├─ 路由解析：model/provider → 提供商路由（自动，歧义显式报错）
        ├─ 启动：subagents.start / startContinuable（官方公开接缝）
        ├─ 注册表：<workspace>/.dsh-subagents/runs.jsonl 追加记录（锁内读写）
        ├─ 审计：parent.session.append('subagent-model/run-started', …)
        │
        ├─ 前台：settle 后同步落盘 completed/failed + run-settled 事件
        ├─ 后台任务：任务结算时经 done 包装落盘
        └─ continuable：进程级 subagent/end 监听（只认自己索引过的 child id）
             └─ 干净收尾 → idle；异常 → failed/cancelled

浏览器端（客户端半区）：
  委派卡片 / 花名册卡片 ──2.5s 轮询──▶ GET /api/subagent-model/runs?cwd=&sessionId=
     （磁盘真相 + listChildren 实时驻留状态，只读）
```

关键设计（详见源码注释）：

- **咨询性**：注册表、事件、驻留查询都是咨询性路径，任何失败都降级（内存回退 / 跳过），**绝不打断委派**；只有显式 `depends_on` 把注册表当权威。
- **single-flight 纪律**：插件按两个实例挂载（spawn + fork），进程级共享资源（路由族、花名册工具、`subagent/end` 监听器）都只注册一次。
- **注入纪律**：只访问 `inject` 声明的服务属性；可选服务一律 `ctx.get(...)` 并处理 `undefined`（v0.3.0 教训，见 CHANGELOG）。

## 🛡️ 兼容性设计（防 dsh 升级失效）

1. **只用公开接缝**：`ctx.tools.register`、`ctx.subagents`（`start` / `startContinuable` / `listChildren` / `subagent/start|end` 事件）、`ctx.systemPrompt.section`、`ctx.settings`（可选读）、`ctx.webServer.register`、`Session.append`。不 import 内部模块。
2. **依赖从宿主解析**：只声明 `peerDependencies`，运行时经 profile 的扁平 `node_modules` 解析到**当前安装的 dsh 自带版本**，不锁版本、不随包分发、不漂移。
3. **镜像官方模式**：注册时机（provider 出现/移除）、前后台路由、stop-reason 处理、输出渲染与官方 `dsh-tool-subagent` 同构。
4. **防御性解析**：设置节任何形状都不会让插件崩溃，最坏退化为继承行为。
5. **客户端按能力探测**：toolview 卡片注册套 try/catch；`sessions` 服务走 `ctx.get()` 可选读取，缺失只隐藏"打开子会话"按钮。
6. **失效方式明确**：接缝变更时加载 / 调用阶段报出可读错误，不静默出错。

## 🧪 开发与测试

```
lib/
  index.js        宿主半区：工具注册、路由解析、执行流、end 监听、提示段
  client.js       浏览器半区：设置卡片 + 三个 toolview 卡片（手写、无构建）
  registry.js     运行注册表：JSONL 折叠、锁、压缩、内存回退
  status-tool.js  花名册工具（进程级 single-flight）
  events.js       会话审计事件（含失败遏制）
  routes.js       /api/subagent-model/* 路由族（single-flight + 信任围栏）
  config-store.js 用户默认值存储（原子写入，~/.dsh/subagent-model.json）
test/
  smoke.mjs       宿主冒烟测试（真实 dsh-tools schema 校验 + 注入纪律 Proxy mock）
  client-smoke.mjs 客户端冒烟测试（web shell 加载方式 + SSR 渲染）
```

运行测试需要 dsh 包可解析（`@deepseek-ai/dsh-tools` 等，不随仓库分发）：

```sh
# 任选其一：
# a) 把 $DSH_HOME/profiles/node_modules 链接为 node_modules（本地开发）
# b) 在已安装 dsh 的 profile 环境里运行

node test/smoke.mjs
node test/client-smoke.mjs
```

两个 mock ctx 都带**注入纪律 Proxy**：访问未在 `inject` 声明的服务属性会抛与真实环境一致的 `cannot get property ... without inject`，此类错误在测试阶段即暴露。

## 变更历史

见 [CHANGELOG.md](CHANGELOG.md)。

## 致谢

- 官方 `dsh-tool-subagent` 的成熟模式（注册时机、前后台路由、stop-reason 语义）；
- [dsh-plugin 社区生态](https://github.com/topics/dsh-plugin)的公开设计思想：**状态出上下文**（磁盘真相 + 按需读取）、**依赖门控**、**失败遏制**（如 [dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams)）——本仓库为独立实现，非 fork。

## License

[MIT](LICENSE) © 2026 FEOH333

---

## English Summary

`dsh-delegate` (npm package: `dsh-tool-subagent-model`) extends the official `subagent` / `subagent_fork` tools for DeepSeek Harness with:

- **Per-call model choice** with automatic provider routing, sourced from the web Models page;
- **Dependency gating** via `task_id` / `depends_on` (deterministic ordering, refuses with the unsatisfied list);
- **Per-child personas** (persisted and reapplied on continuable resume);
- **A durable run roster** (`subagent_status` + `<workspace>/.dsh-subagents/runs.jsonl`) and typed audit events;
- **Conversation-flow tool cards** (status badges, dependency detail, child-session navigation) plus a Settings card for defaults;
- `trackRuns: false` restores plain delegation behavior.

```sh
dsh plugin --profile web add github:FEOH333/dsh-delegate
```

Then mount two rows (spawn + fork) in your profile's `cordis.patch.yml` (see the install section above), restart dsh, and refresh the browser.

All tracking seams are advisory by construction — filesystem or event failures never break a delegation. The plugin uses only public DSH seams, resolves its dependencies from the host installation, and its smoke tests enforce Cordis inject discipline with a proxy mock.
