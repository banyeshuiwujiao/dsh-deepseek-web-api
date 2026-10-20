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
5. **协议残留兜底**：若反代返回的正文里仍有未解析的工具协议标记（DSML / 文本协议），插件不再把它当普通回答静默结束回合，而是上报可重试错误 `PROTOCOL_LEAK`。
6. **不污染工具列表**：遵循 DSH 设计哲学，不导出任何 Action 工具。

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
        defaultMaxTokens: 8192
        toolReasoning: 'clean'   # 注入后端 DS_TOOL_REASONING：clean 才能实时流式深度思考
        tools: 'text'            # 注入后端 DS_TOOLS：text = JSON 协议，native = 网页标记协议
```

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
- **DeepSeek Web API (反代)** → `deepseek-v4-flash` / `deepseek-v4-pro`。

---

## 验证与测试

```powershell
node test/smoke.mjs                    # 契约测试与 SSE 增量模拟
node test/preparecall_regression.mjs   # 真实 DSH LlmRuntime 回归
```
