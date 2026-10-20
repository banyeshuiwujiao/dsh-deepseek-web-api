# dsh-deepseek-web-api (DeepSeek 网页私有 API 反代 Provider 插件)

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
5. **协议残留兜底**：若反代返回的正文里仍有未解析的工具协议标记（DSML / 文本协议），插件不再把它当普通回答静默结束回合，而是上报可重试错误 `PROTOCOL_LEAK`；整轮零产出（无正文、无思考、无调用）同样上报 `EMPTY_RESPONSE`，交给内核按重试策略处理。
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
15. **不污染工具列表**：遵循 DSH 设计哲学，不导出任何 Action 工具。

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
        serverDir: 'C:\Users\Admin\DeepSeek_Harness\git-repo\deepseek-web-api'
        autoStart: true
        startTimeoutMs: 60000
        maxContextWindow: 128000
        defaultMaxTokens: 32768     # 申报给 DSH 的单轮输出预留（上游不强制 max_tokens）
        toolDescriptionMaxChars: 0  # 0 = 工具描述完整下发；>0 才按字符预算裁剪
        toolReasoning: 'clean'   # 注入后端 DS_TOOL_REASONING：clean 才能实时流式深度思考
        tools: 'text'            # 注入后端 DS_TOOLS：text = JSON 协议，native = 网页标记协议
        healthTtlMs: 30000       # /health 缓存，避免每步都探活；0 = 每次都探活
        streamIdleTimeoutMs: 120000  # 上游无数据的容忍上限，超时按 TIMEOUT 重试
        logFile: ''              # 填路径则后端输出落盘（>2MB 轮转 .1）
        detach: false            # true = 后端独立存活，插件退出不牵连它
        killTreeOnDispose: true  # 托管模式 dispose 连带回收 Chrome 等孙进程
```

> `defaultMaxTokens` 不会真的限制输出：网页端上游不接受 token 上限（反代 `docs/api.md` 已说明），
> 它只是告诉 DSH“单轮最多可能吐多少”，内核据此预留上下文水位。实测单轮可产出 6 万字符（约 2 万 token），
> 所以默认值取 32768；写小了会让压缩/截断决策过于乐观。

> `toolReasoning` / `tools` 只在插件**自己拉起**后端进程时生效；如果 8787 已经被别的进程占用，插件会直接复用（复用实例的环境变量由那次启动决定）。

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

## 验证与测试

```powershell
node test/smoke.mjs                    # 契约、纯函数与 SSE 增量模拟（含错误码/中止/usage/归因头）
node test/preparecall_regression.mjs   # 真实 DSH LlmRuntime 回归
node test/live_e2e.mjs                 # 真机：由插件自己拉起后端并跑一次真实工具回合（需已登录）
```

`live_e2e.mjs` 会占用 8787 并真实调用一次网页端，跑完**不会**回收后端进程（留给客户端复用）。
