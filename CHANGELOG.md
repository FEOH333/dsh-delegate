# Changelog

本文件记录 dsh-delegate（npm 包名 `dsh-tool-subagent-model`）的版本历史与工程教训。

## 项目状态（2026-09）

- **暂停维护 / 停用**：DeepSeek Harness 官方已原生提供 Subagent 模型选择（授权模型列表 + 按次选择提供方/模型/推理强度，仅影响新会话）。本插件核心功能被官方覆盖，仓库进入**仅存档状态**——不再新增功能、不再适配新版本；**0.3.8**（dsh 0.1.2-rc.1 兼容修复）为最后一个维护版本。历史版本与文档保留备查。

## 0.3.8

- **fix（适配 dsh 0.1.2-rc.1 · 致命）**：`@deepseek-ai/dsh-settings` 在 0.1.2-rc.1 移除了 `installSettingsSection` / `settingsNamespace` 两个导出（该模块现在只导出 `SettingsProvider` / `SettingsConflictError` / `redactSecrets`）。旧代码静态 `import` 它们，**加载阶段**即抛 `SyntaxError: does not provide an export named 'installSettingsSection'`，会让整个 profile 启动失败。改为直接调用底层公开接缝 `ctx.inject(['settings'], sctx => sctx.settings.register(ns, schema, { base }))`——这正是旧包装器内部做的事，`SettingsProvider.register` 的签名在 0.1.1-rc.2 与 0.1.2-rc.1 之间未变，因此两个版本都可用；命名空间改为普通字符串常量（`settingsNamespace()` 只做正则校验并原样返回参数）。
- **fix（设置卡片可能永久不出现）**：`installSettingsSectionOnce` 中 `ctx.get("settings") === void 0` 的提前返回是一个竞态。profile 各行是**并发挂载**的，settings 提供者的异步 init 可能尚未完成，此时 `ctx.get` 返回 `undefined`，函数直接退出且**永不重试**——命名空间再也不会被服务，设置 → 插件里的卡片静默消失（本机 dsh 0.1.2-rc.1 实测复现：`settings.describe()` 里没有 `subagent-model`）。改为只用 `ctx.inject(['settings'], …)` 作为唯一门：服务已就绪则立即执行，未就绪则等它出现，与官方 `dsh-agent-presets` / `dsh-llm-pi-ai` / 内置客户端插件同构；无 settings 服务的 headless profile 自然不会触发回调。注册回调体也加了 try/catch——它可能在函数返回之后才运行，否则异常会变成未处理错误，而不是"卡片隐藏、委派工具不受影响"的降级。
- **feat（模型目录改用 `llm` 服务 · 部署无关）**：模型目录原先只来自 `llm-pi-ai` 设置节——那只是**一种**适配器族。部署完全可能由 `llm-deepseek` 或自定义适配器提供服务，此时该节未注册：`model` 枚举为空，且任何显式 `model` 都会被静默路由到主 agent 的 provider（错路由）。现在优先读 `ctx.get("llm")` 的 `listProviders()` + `listModels(route)`（"当前真正可路由的路由"），仅在没有任何路由广告模型时回退到设置节；实时目录一旦生效，同步的设置节路径不再回写（不得用"已配置但不可路由"的 id 覆盖实时真相）。
- **feat**：订阅官方拓扑事件 `llm/adapters-updated`（适配器注册/注销路由，或可配置提供商目录变化），适配器上下线时实时重建 `model` / `provider` 枚举；`settings/updated` 仅对 `llm*` 命名空间生效，其他命名空间不再无谓重建工具。
- **perf/robustness**：实时目录读取为单飞（boot 读取、设置变更、空目录 execute 共享一次），逐路由容错（某条路由读取失败不影响其他路由），全部失败降级为空目录，绝不打断委派。
- **fix（后台任务摘要恒为空）**：官方 `settleRun` 的 `outcome.output` 是**拼接后的字符串**（`runOutcome` → `finalText`），不是内容块数组；`firstText()` 只吃数组，于是 `one-shot` 后台任务的花名册摘要永远是空串。`firstText` 现在同时接受字符串与内容块数组（前台路径不受影响）。
- **fix（继承的模型/provider 可能是陈旧路由）**：原来读 `parent.options?.provider/model`（**创建时**路由），主 agent 会话中途切模型后子代理仍会继承旧路由。改为读会话**最新请求头**（`session.requestHeader()?.config`），无该方法（0.1.1-rc.2）或首个请求之前回落到创建选项。注意：官方 0.1.2 提供了 `parentAgentOptionsForDelegation`，但它**在 0.1.1-rc.2 里不存在**——静态 import 会重演本版正在修的"链接期 SyntaxError"，因此这里直接读同一条接缝并做可选链 + try/catch 降级。
- **fix（headless / TUI profile 下工具根本不挂载）**：`inject` 里的 `webServer` 会让整行在"没有 web 服务器的组合"里**永远等待激活**——委派工具连注册都不会发生。`webServer` 改为 `ctx.get("webServer")` 可选读取（路由族只是浏览器卡片的传输层，缺失即跳过），`inject` 收敛为 `["tools", "subagents", "systemPrompt"]`（与官方工具一致）。
- **fix（用户默认值路径忽略 `$DSH_HOME`）**：`config-store.js` 原先把配置硬编码写到 `~/.dsh/subagent-model.json`，忽略 harness 自身的 home 解析规则（`$DSH_HOME` 优先于 `~/.dsh`，空/纯空白视为未设置，`~` 会展开）。现在按同一规则解析，且**不新增静态 import**（`@deepseek-ai/dsh-home-paths` 的三行逻辑本地实现——静态 import 宿主包正是 0.1.2 这次翻车的原因）。
- **fix（"打开子会话"按钮可能永久失效）**：客户端半区在 `apply()` 里一次性捕获 `ctx.get("sessions")`；若 sessions 控制器在本 bundle 之后才激活，引用就永远是 `null`，按钮静默失效。改为**每次点击时解析**（保留 `typeof` 能力探测与 try/catch——点击处理函数绝不抛错）。
- **fix（清单引用了已不存在的包）**：`package.json` 的 `dsh.client.inject` 与 `peerDependencies` 指向 `@deepseek-ai/dsh-client-runtime`——该包在 dsh 0.1.2-rc.1 已不存在（客户端 loader 会跳过缺失的 row-inject，因此它只是一条误导性元数据）。已移除，保留 `dsh.client.platform: "web"` 与 `exports["./client"]`（loader 的必需契约）。
- **test**：新增实时目录用例（实时目录覆盖设置节、显式 model 解析到真实路由、空目录回退设置节、`llm/adapters-updated` 触发重建、无关命名空间不重建）、"settings 服务迟到仍注册命名空间"回归用例（模拟并发挂载竞态）、"会话中途切模型仍正确继承"用例、后台任务摘要非空回归用例、headless（无 webServer）仍挂载工具用例、`$DSH_HOME` 路径解析用例（自定义 home / 空白视为未设置 / `~` 展开）；client-smoke 新增清单契约断言（`platform` / `exports["./client"]` / 不再引用已移除的包）与"apply 不得捕获 sessions"断言。

## 0.3.7

- **feat（dsh-std 生态适配）**：新增 `dsh-plugin.json`（Community v0.15 Manifest，`manifestVersion: "0.15"`）。已通过 [dsh-ecosystem-spec](https://github.com/T-Auto/dsh-ecosystem-spec) 官方准入评估器（`npm run validate:manifest`）——结果为 `compatible`（valid, missingOptional 空）。插件按**实验适配（Experimental）**声明：不宣称实现任何 std 协议（commands/messages/storage/presentation 均未注册），通过宿主 adapter 层参与生态，详见 manifest `x-experimental` 说明。
- 该清单使插件可被 dsh-TUI 生态（[dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI)、tui 插件市场）识别与装载。

## 0.3.6

- **feat（设置配置双保险）**：除命名空间卡片外，新增**独立设置页签**（`settings.section` list 槽，id `subagent-model`，位于「模型」与「插件」页之间）——该槽注册即渲染、不依赖 namespace describe 机制，设置侧栏直接出现「子代理模型」页。无论哪种机制生效都能在设置里调整。
- **refactor**：settings 命名空间注册抽为独立模块 `lib/settings-ns.js`（入口模块 re-export，测试导入路径不变）。
- **dev**：新增 `scripts/verify.mjs` 一键验证（逐文件语法检查 + 两套冒烟测试）与 `npm run test` / `npm run verify`。
- **test**：`client-smoke.mjs` 覆盖 settings.section 注册（id/order/label thunk）与页面 SSR 渲染。

## 0.3.5

- **fix（设置卡片真正可见）**：dsh 0.1.1 的「插件配置」页不再遍历 slot 占用表，而是按 **Host 服务的设置命名空间**逐个 dispatch `settings.plugin.item`（describe 与服务交集）。0.3.4 只修了注册形式（key 已进入占用表）但缺命名空间仍不渲染。本次在 host 注册 `subagent-model` 设置命名空间（官方 `installSettingsSection` + `settingsNamespace` 同构，single-flight，无 settings 服务的 headless profile 自动跳过）；配置数据仍走插件自己的 `/api/subagent-model` 路由与 `~/.dsh/subagent-model.json`，命名空间仅为呈现声明。
- **deps**：新增 peer 依赖 `@deepseek-ai/dsh-settings`（由 dsh 自带，不锁版本）。
- **test**：`smoke.mjs` mock 增加 `inject`/`settings.register` 面，断言命名空间注册恰一次且名为 `subagent-model`。

## 0.3.4

- **fix（适配 dsh 0.1.1-rc.2）**：`settings.plugin.item` 插槽从 list（按 `id` 注册）改为 keyed（按 `key` 注册），旧式 `{ id, order, locale }` 注册导致设置 → 插件列表里卡片不再出现。改为 `{ name, key: "subagent-model" }` 注册（与官方 shell / agent-loop 卡片同构），并加 try/catch 防御。
- **deps**：设置卡片组件渲染语言回退改为内置中英字典（keyed 槽不再注入 locale 绑定的 `t`）。
- **test**：`client-smoke.mjs` 断言改为新契约（`entry.key === "subagent-model"`，旧 `id` 字段必须为 `undefined`）；SSR 渲染改为从 react-dom 位置解析配套 react（顶层 react@18 与 react-dom@19 不同源的测试环境修复）。
- host 侧接缝（tools / subagents / systemPrompt / webServer / settings / jobs / `subagent/start|end` / `settings/updated`）经审计与冒烟测试确认在新版无需改动。

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
- **feat**：工作区级运行注册表（`<workspace>/.dsh-subagents/runs.jsonl`，追加式 JSONL + last-write-wins 折叠 + 400 行压缩 + 400 行压缩 + 内存回退）。
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
