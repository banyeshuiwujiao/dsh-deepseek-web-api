# dsh-deepseek-web-api (DeepSeek 网页私有 API 反代 Provider 插件)

[![CI](https://github.com/banyeshuiwujiao/dsh-deepseek-web-api/actions/workflows/ci.yml/badge.svg)](https://github.com/banyeshuiwujiao/dsh-deepseek-web-api/actions/workflows/ci.yml)

将 `C:\Users\Admin\DeepSeek_Harness\git-repo\deepseek-web-api` 作为本地反代后端，直接接入 DeepSeek Harness 桌面客户端的**模型选择器**。

> **注意：** 本插件**仅注册 Provider（作为模型大语言模型路由）**，**不向全局工具列表中注册任何工具**。DSH 自带的工具能力（如 PowerShell、文件操作、审批流等）完全由 DSH 原生机制接管调度。

---

## 核心特性

1. **直达模型选择器**：通过 `ctx.llm.registerAdapter(['deepseek-web-api'], adapter)` 注册原生 LlmAdapter，在 DSH 模型选择器中直接可选：
   - `deepseek-web-flash`：DeepSeek 网页版 · 极速模式（关闭深度思考，秒级直接回答）
   - `deepseek-web-thinking`：DeepSeek 网页版 · 深度思考（开启深度思考，输出完整思维链）
2. **免手动启停 (autoStart)**：调用时自动检测 `http://127.0.0.1:8787/health`，若未启动则自动拉起 `git-repo\deepseek-web-api` 后端服务，并在插件卸载或客户端退出时安全释放。
3. **原生凭据解析**：自动寻找 `data/.api-key`、环境变量 `DS_API_KEY` 或 patch 配置中的 `apiKey`。
4. **原生流式与思考协议**：无缝映射 OpenAI SSE 增量为 DSH 原生 `StreamChunk`：
   - `reasoning_content` → DSH `reasoning-delta`（原生深度思考折叠气泡渲染，边生成边推送）
   - `content` → DSH `text-delta`（工具回合的正文在反代解析完协议文本后一次性下发，避免半截标记）
   - `tool_calls` → DSH 原生 `tool-call-delta`
5. **协议残留兜底**：若反代在**带工具的回合**里返回了仍未解析的协议标记，插件不把它当正常回答静默结束，而是上报可重试的 `PROTOCOL_LEAK`，错误信息里带上泄漏通道（正文/思考）与后端判定（`protocolShape`）；整轮零产出（无正文、无思考、无调用）报 `EMPTY_RESPONSE` 交给内核重试。**不带工具的回合**（例如会话标题请求）里出现协议样式文本按合法正文放行——那正是用户可能让模型讲解协议或写这类代码的场景，判成错误会白烧两轮重试并把答案藏掉。
6. **真实 token 计量**：请求带 `stream_options.include_usage`，反代把上游累计输出 token 挂在最后一个 chunk 上；插件只在拿不到真实值时才估算，且估算基数包含 system 提示与全部工具 schema，中文按 1 字符 1 token 计（旧实现一律 `/3`，输入侧被低报数倍）。
7. **稳定错误码与中止语义**：HTTP 状态按内核词表分流 —— 401/403 `AUTH`、402 `QUOTA`、429 `RATE_LIMIT`（透传 `Retry-After`）、400/413/422 `INVALID_REQUEST`、上下文超长 `CONTEXT_WINDOW_EXCEEDED`、5xx `SERVER`、其余 `HTTP_<status>`；只有真正值得重试的码进 `retryableCodes`，用户点“停止”一律 `ABORTED`（不进重试）。
8. **消息保真**：历史里的 `system` / `developer` 角色照样透传（旧实现只认 `options.system`，其余静默丢弃）；工具描述默认完整下发（旧实现砍成首行，`workflow` 曾丢 81% 说明）；图片等非文本 block 会显式告警，不再变成空串。
9. **归因头**：每个 provider HTTP 请求都带 `attributionHeaders()`（内核 helper 不可用时退化为字面量），符合 LlmAdapter 契约。
10. **工具调用按 `index` 累积**：分片到达（同 `index` 多次追加 `arguments`）会合成一个完整调用再下发，不会产出残缺块；缺 `id` 时用自增兜底，不撞号。
11. **空闲超时**：上游连续 `streamIdleTimeoutMs`（默认 120s）不吐字节，按可重试的 `TIMEOUT` 中止，不再无限挂着。
12. **复用实例可辨识**：`GET /health` 现在自述 `version` 与生效中的 `toolReasoning`/`toolCalls`，插件据此比对自身配置——跑的是旧构建或开关不一致会 `logger.warn`（真机上就吃过"复用手工起的旧进程、注入的开关从未生效"的亏）。探活结果按 `healthTtlMs` 缓存，长会话不再每步探活。
13. **每轮一行统计 + 可选日志落盘**：`logger.debug` 输出 `ttft / reasonChars / contentChars / toolCalls / usage / conversation / outcome`；配置 `logFile` 后后端子进程输出写文件（>2MB 轮转 `.1`），事后能取证。
14. **进程生命周期两种语义**：
   - 托管（默认）：后端子进程走 stdio 管道，插件能 `tail` 最近日志、能在 dispose 时用 `taskkill /T` **按进程树回收**（连带后端自己起的 headless Chrome，不再留下占着 CDP 端口的孤儿）。代价是这层耦合是**双向**的：拉起插件的进程一旦被强杀，管道断裂会让后端因 EPIPE 自行退出——对 DSH「宿主退出=服务停」是正确行为。
   - `detach: true`：后端进独立进程组、stdio 落 `logFile` 或忽略，`unref` 后插件退出/卸载都不碰它。适合"起了就一直给客户端复用"，也是 `test/live_e2e.mjs` 用的模式。
   - `killTreeOnDispose: false` 可退回只杀直接子进程的旧行为。
15. **子进程环境变量白名单**：拉起后端不再全量继承 `process.env`，只放行「跑起 Node/Chrome 必需的 OS 变量」+ 后端自己声明的 `DS_` 命名空间 + 本插件显式设定。宿主里的 `npm_config_*`、`VIRTUAL_ENV`、`PYTHONPATH`、别的插件的 `CAMOFOX_PORT`、`DEEPSEEK_API_KEY` 都进不去；宿主的 `PORT`/`HOST` 也不会静默改掉后端的监听端口与绑定网卡（要放行用 `passEnvKeys` 点名，或直接写 `env`）。
16. **API Key 解析可诊断**：优先级为 配置 `apiKey` → 环境变量 `DS_API_KEY` → `<serverDir>/data/.api-key`；文件按 mtime 缓存（不再每步同步读盘），缺失时给一次可操作告警并提示 `pnpm login`，且任何日志都不回显密钥内容。
17. **后端目录可移植**：配置文件里不再出现某台机器的绝对路径。解析顺序为
   配置 `serverDir` → 环境变量 `DSH_DEEPSEEK_WEB_API_DIR` → 指针文件 `~/.dsh/deepseek-web-api.json`（`install.ps1` 写，含后端 git 版本）→ 插件同级（源码形态）→ home 下常见位置。
   显式写了但那个目录没有 `dist/index.js` 时**不一票否决**，继续往下找并把这件事记进日志——换机器忘记改配置是常态。
   `logFile` 等路径支持 `~` 前缀。
18. **后端能力契约**：`GET /health` 必须自述 `dsml-tool-calls`、`protocol-switches`、`include-usage`、
   `health-self-description` 四项能力，缺任何一项就**拒绝复用**并报不可重试的 `BACKEND_STALE`（错误信息直接给出"在哪跑 `pnpm build`"）。
   为什么不比版本号：真机上亲眼见到一个**旧 dist 自述 `version: 0.2.0`**——因为版本号是每次 `/health` 现读 `package.json` 的，
   旧代码也会报新版本号，比数字会被放行；能力清单才是可判定的事实。
   想强行复用旧后端就把 `strictBackend` 设为 `false`（降级为告警），或用 `requiredCapabilities` / `minBackendVersion` 精确声明依赖。
19. **配置改动不必重启客户端**：适配器不再在加载时固化配置快照，而是每轮请求（`prepareCall`）取当代配置；
    只影响请求的项（如 `toolDescriptionMaxChars`、`defaultMaxTokens`）改完下一轮即生效；
    影响后端进程的项（`baseUrl`、`serverDir`、`toolReasoning`、`tools`、`streamContent`、`logFile`、`detach` 等）变更时
    自动回收旧后端管理器并重建（会打一条 info/warn）。每代请求把自己那一份配置与管理器绑死，
    避免"准备时用新值、派发时又混进旧一代"。`apply()` 返回适配器句柄，卸载时回收懒建的管理器。
20. **不污染工具列表**：遵循 DSH 设计哲学，不导出任何 Action 工具。
22. **申报值自己收口**：`maxContextWindow` / `defaultMaxTokens` 一律 `Number()` + 正整数校验，非法就
    回落默认值并告警。内核逐字校验这两个整数，字符串会让 `prepareCall` 抛 `INVALID_MODEL_CONTEXT`，
    连带把 `read_image` 这类要过模型路由的工具在几毫秒内打死 —— 表现极像"模型不支持图"（真机代价：一次接入任务里 4 次读图全灭）。
23. **图片被省略时给出下一步**：内核会把图片换成 `[image omitted … attachment sha256:…]` 文字，
    插件认出它就补一条 `[no-image-input]` 指引（交路径给用户 / 走 DOM 与接口文本 / 请用户口述）；被丢弃的 block 告警也会带出
    文件名与 attachment id。本模型仍如实申报无图像输入 —— 谎报只会把失败换成 `does not declare image input`。
24. **空回合不再伪装成正文**：反代归因（`upstream-not-started` / `upstream-silent`）后按 502/504 抛真错误，
    插件据流内 `error.status` 映射成可重试的 `SERVER`；判给解析器的那类（`parser-dropped-content`）保留原兜底路径，
    因为把我们的 bug 说成"上游不可用"会让人白重试。

21. **正文也能实时出字（可选）**：`streamContent: 'live'` 让后端把工具回合的正文也过一遍协议闸门再下发
    （闸门只扣住"可能是标记开头"的尾巴，已发出去的字绝不回收），长参数生成时不再只见思考气泡。
    默认 `buffered` 保持"正文只由权威解析决定"的最保真语义；两者都靠同一处实现，插件侧不重演判定逻辑。
    代价写进 `docs/troubleshooting.md`：被判无效而重试的那轮，重来的答案只追加不上屏。

---

## 深入文档

- [`docs/protocols.md`](./docs/protocols.md)：为什么同时存在两种工具协议、为什么工具回合的正文要缓冲后一次性下发、为什么不信任版本号。
- [`docs/troubleshooting.md`](./docs/troubleshooting.md)：症状 → 看哪里 → 判定依据；含两类**不属于本插件**的浏览器工具报错怎么区分、换机器必查项。

---

## 安装与配置

### 1. 同步插件到运行时镜像

在插件源码目录下运行：

```powershell
cd C:\Users\Admin\DeepSeek_Harness\dsh-client-config\plugins\dsh-deepseek-web-api
.\install.ps1
```

### 2. 合入权威源配置

在 `C:\Users\Admin\DeepSeek_Harness\dsh-client-config\profiles\desktop\cordis.patch.yml` 中追加 provider insert 块：

```yaml
# ── DeepSeek Web API（网页私有 API 反代 → 接入模型选择器，不进工具列表）─────────
- insert:
    - id: dsh-deepseek-web-api-provider
      name: dsh-deepseek-web-api/provider
      config:
        baseUrl: 'http://127.0.0.1:8787'
        # 后端目录不用写：按 配置 serverDir → DSH_DEEPSEEK_WEB_API_DIR → 指针文件 → 同级 → home 候选 解析。
        # 需要指明时可以写 ~ 前缀：serverDir: '~/DeepSeek_Harness/git-repo/deepseek-web-api'
        autoStart: true
        startTimeoutMs: 60000
        maxContextWindow: 560000      # 上游实测约 1M token；560000 给中文会话留约 3% 压缩余量
        defaultMaxTokens: 32768     # 申报给 DSH 的单轮输出预留（上游不强制 max_tokens）
        toolDescriptionMaxChars: 0  # 0 = 工具描述完整下发；>0 才按字符预算裁剪
        toolReasoning: 'clean'   # 注入后端 DS_TOOL_REASONING：clean 才能实时流式深度思考
        tools: 'text'            # 注入后端 DS_TOOLS：text = JSON 协议，native = 网页标记协议
        streamContent: 'buffered' # 注入后端 DS_STREAM_CONTENT：live = 工具回合正文也实时出字
        healthTtlMs: 30000       # /health 缓存，避免每步都探活；0 = 每次都探活
        streamIdleTimeoutMs: 120000  # 上游无数据的容忍上限，超时按 TIMEOUT 重试
        logFile: ''              # 填路径则后端输出落盘（>2MB 轮转 .1）
        detach: false            # true = 后端独立存活，插件退出不牵连它
        killTreeOnDispose: true  # 托管模式 dispose 连带回收 Chrome 等孙进程
        passEnvKeys: []          # 白名单之外还要透传的变量名
        strictBackend: true      # 后端能力不足时拒绝复用（BACKEND_STALE）
        requiredCapabilities: [] # 留空 = 用插件内置清单
        minBackendVersion: ''    # 留空 = 用插件内置下限
```

> `defaultMaxTokens` 不会真的限制输出：网页端上游不接受 token 上限（反代 `docs/api.md` 已说明），
> 它只是告诉 DSH“单轮最多可能吐多少”，内核据此预留上下文水位。实测单轮可产出 6 万字符（约 2 万 token），
> 所以默认值取 32768；写小了会让压缩/截断决策过于乐观。

> `maxContextWindow` 申报的是**内核压缩线的输入**，不是模型能力。上游实测窗口约 1M token
> （1,850,168 中文字符 = 957,921 token 仍完整召回，1,900,163 字符起静默空回合），但
> `dsh-compaction-basic` 的触发式是 `threshold = min(0.8W, W − defaultMaxTokens − 65536)`，
> 而它的 tokenMeter 按「4 字符 ≈ 1 token」估算——中文实际约 0.518 token/字，估算只有真实用量的一半。
> 于是 560000 会在真实约 92.8 万 token 时压缩（95.8 万实测上限之内，留约 3% 余量），
> 576000 是吃满的一档（真实约 95.5 万，余量只剩 0.3%），512000 留 11% 余量，
> 640000 要到真实约 106 万才动手——先撞空回合，压缩永远来不及。
> 中文会话算出来的安全上界是 577,900；旧的 128000 之所以像"上下文很小就被压掉"，是因为它的阈值只有
> 29,696 估算 token ≈ 6.2 万真实 token。复算工具是运维目录里的 `~/DeepSeek_Harness/probes/kernel_threshold.mjs`
> （它 eval 安装包里的公式原文，不重写公式；该目录未纳入版本管理）。

> `toolReasoning` / `tools` / `streamContent` 只在插件**自己拉起**后端进程时生效；如果 8787 已经被别的进程占用，插件会直接复用（复用实例的环境变量由那次启动决定），此时用后端自述的 `streamContent` 与本地配置比对并 `logger.warn`。

### 3. 同步运行时配置

```powershell
cd C:\Users\Admin\DeepSeek_Harness\dsh-client-config
python scripts\sync-profiles.py --profile desktop
```

### 4. 首次登录（如未完成认证）

如果本地尚未登录 `chat.deepseek.com`：

```powershell
cd C:\Users\Admin\DeepSeek_Harness\git-repo\deepseek-web-api
pnpm login
```

### 5. 重启客户端

完全退出 `DeepSeek Harness.exe`（右键托盘完全退出），重新打开客户端。在新建会话顶部的**模型选择器**中即可选择：
- **DeepSeek Web API (反代)** → `deepseek-web-flash`（极速）/ `deepseek-web-thinking`（深度思考）。

---

## 安全约束

这几条是本项目与使用者明确定下来的红线，改代码前先看一眼：

1. **反代只监听回环**。`HOST` 默认 `127.0.0.1`，插件注入子进程环境时把宿主的 `HOST` 挡在白名单之外
   （smoke `[13/18]` 钉住了这条），API Key 也就只在 `127.0.0.1:8787` 这一层起作用。不要把它变成对外监听的代理。
2. **凭据绝不进日志与错误文本**。后端 `data/.api-key`、`DS_API_KEY`、`auth.json` 都是私密文件；
   插件记录子进程环境变量时**只记变量名不记值**（`keys.join(', ')`），日志落盘与 `describeErrorBody`
   也不得回显 Key/Cookie。缺 Key 时的报错只说去哪儿找，不打印值。
3. **不要动那个嵌套的 git 仓**。`plugins/dsh-deepseek-web-api/` 是**故意的独立仓库**（防止与外层配置一并提交），
   外层 `.gitignore` 已登记它。别删它的 `.git`、别并入外层仓、别改成 submodule。
4. **推送只推自己的远端**。后端 `origin` 是使用者 fork（`banyeshuiwujiao/deepseek-web-api`），
   `upstream`（`kittors/deepseek-web-api`）是第三方只读仓，**永远不要往 upstream 推**。
5. **发布/外发类动作先确认**。发消息、上线、公开站点、`install.ps1` 之类改动系统或对外可见的操作，
   先给出可审阅的结果再动手；本地读写与跑测试属于日常授权范围。
6. **进程回收要成树**。托管模式 `killTreeOnDispose: true` 用 `taskkill /T /F`（POSIX 走进程组），
   连带回收后端起的 headless Chrome；`detach: true` 时 stdio 绝不能是 pipe，否则父进程退出会让后端 EPIPE 自杀。

## 验证与测试

```powershell
npm test                     # 配置结构自检 + smoke（CI 跑的就是这两样）
node test/config_check.mjs   # cordis.patch.yml 结构守卫（缩进/必需键/回环/枚举）
node test/smoke.mjs          # 契约、纯函数与 SSE 增量模拟（15 段）
node test/preparecall_regression.mjs   # 真实 DSH LlmRuntime 回归（需本机 DSH 运行时）
node test/live_e2e.mjs       # 真机：由插件自己拉起后端并跑一次真实工具回合（需已登录）
```

后两个**故意不进 CI**：`preparecall_regression` 要真实的 `@deepseek-ai/dsh-llm` 运行时，
`live_e2e` 要已登录的网页会话并会真实调用一次上游。CI 只跑与本机状态无关的部分。

CI（`.github/workflows/ci.yml`）分两个 job：

- `structure`（ubuntu，Node 20/22）：语法检查、零依赖断言、`config_check`。
- `smoke`（**windows-latest**，Node 20/22）：完整 15 段。smoke 钉在 Windows 不是偷懒——
  `[11/15]` 进程树回收靠 `taskkill /T`，`[12/15]` 验证"托管 stdio 被父进程退出牵连 / detach 独立存活"，
  都是平台语义；在 Linux 上把它们跑"绿"没有意义（POSIX 退路只能杀单进程）。

`live_e2e.mjs` 会占用 8787 并真实调用一次网页端，跑完**不会**回收后端进程（`detach: true`，留给客户端复用）。
