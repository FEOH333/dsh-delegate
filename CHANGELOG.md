# Changelog

本文件记录 dsh-delegate（npm 包名 `dsh-tool-subagent-model`）的版本历史与工程教训。

## 0.3.3

- **feat**：模型来源标注——注册表记录新增 `modelSource`（`arg` 显式指定 / `default` 默认值 / `inherited` 继承主模型），花名册与对话流卡片直接显示"这条为什么是这个模型"；审计事件同步携带。
- **feat**：锁定默认模型——行配置 `lockDefaultModel` 与设置卡片开关（任一生效）：开启且配置了默认模型时，每次调用指定的 `model` 被忽略、强制使用默认值；工具结果带 `note` 提示"model locked to default"。
- 输出形状向后兼容地新增可选 `note` 字段（原字段不变）。

## 0.3.2

- **fix**：`subagent_status` 花名册的耗时显示错误——running 记录的 `tsSettled` 为 `0`，而 `??` 只跳过 `null`/`undefined`，导致显示 `started <epoch>s ago` 这种天文数字。改为按状态取正确锚点（running → `tsCreated`，其余 → `tsSettled`）。
- **test**：新增回归断言（花名册输出不允许出现 10 位数字的"秒数"）。

## 0.3.1

- **fix**：修复客户端 `apply()` 读取 `ctx.sessions` 但未在 `exports.inject` 声明导致的插件加载失败（`cannot get property "sessions" without inject`，Web 页面无法打开）。
  - `sessions` 改为 `ctx.get("sessions")` 可选读取（能力探测而非硬依赖，缺失时仅隐藏"打开子会话"按钮）；inject 保持 `["slots", "locale"]`。
- **test**：两个冒烟测试的 mock ctx 升级为**注入纪律 Proxy**（访问未声明属性抛与真实环境一致的错误）+ 显式负向断言，此类回归在测试阶段即失败。
- **test**：`smoke.mjs` 用户配置改为**密闭隔离**（测试开头指向临时目录），不再读取开发者机器的真实 `~/.dsh/subagent-model.json`。

## 0.3.0

- **feat**：`subagent_status` 花名册工具（task_id / 状态 / 模型 / 驻留活动 / 依赖链 / 摘要）。
- **feat**：`task_id` / `depends_on` 依赖门控（未满足依赖拒绝启动并列出明细）。
- **feat**：`persona` 角色人设参数（随 descriptor 持久化，冷恢复重应用；提供商不支持时显式报错）。
- **feat**：工作区级运行注册表（`<workspace>/.dsh-subagents/runs.jsonl`，追加式 JSONL + last-write-wins 折叠 + 400 行压缩 + 内存回退）。
- **feat**：`subagent-model/run-started | run-settled` 会话审计事件（只进日志、不进模型历史）。
- **feat**：客户端 `tool.call.toolview` 委派卡片与花名册卡片（轮询 runs 路由、终态停止、子会话跳转）。
- **feat**：配置项 `stateDir` / `statusToolName` / `trackRuns`（全部带默认值，`trackRuns: false` 回退 v0.2.x 行为）。
- **feat**：进程级 `subagent/end` 监听（child id 索引，只结算本插件启动的 continuable 子代理）。
- 输出形状向后兼容地新增 `runId` / `task_id` 字段（原字段不变）。

## 0.2.1

- **fix**：修复多实例挂载时路由重复注册导致整个 profile 启动失败的回归（v0.2.0）。
  - 路由族改为进程级 single-flight（`registerRoutesOnce`）；第二个实例的 apply 直接跳过。
- **test**：加入"同一 ctx 连续 apply 三个实例"回归用例（多实例共享同一 mock webServer）。

## 0.2.0

- 引入设置卡片路由（`/api/subagent-model/*`）。
- ⚠️ 已知缺陷：每实例注册路由，双实例挂载时第二个实例抛 `duplicate exact route`，由 0.2.1 修复。

## 0.1.x

- 初始版本：按次指定模型的委派工具（`subagent_with_model` / `subagent_fork_with_model`），模型目录来自 Web「模型」页，含自动路由解析、设置热更新、优雅降级与用户默认值配置。
