# 故障定位

> 现象 → 先看哪里 → 判定依据。所有路径都按"新机器上也能照着敲"来写。

## 0. 一分钟取清单

```powershell
curl.exe -s http://127.0.0.1:8787/health          # 反代在不在、自述 version/capabilities/开关
type "$env:USERPROFILE\.dsh\deepseek-web-api.json"  # 后端目录由谁定的（指针文件，install.ps1 写）
type "$env:USERPROFILE\.dsh\logs\deepseek-web-api.log" | more  # 后端子进程输出（>2MB 轮转 .1）
netstat -ano | findstr ":8787 :9333"              # 反代端口与 Chrome CDP 端口
```

会话侧看 `~/.dsh/sessions/<工作区>/<session-id>/session.v4.jsonl.zstd`（zstd 多帧，需按魔术字节 `28 b5 2f fd` 切帧解压），
以及 `~/.dsh/storages/session_projcache/sessions/<session-id>.json` 里的 `ttftMs` / `decodeMs` / `toolMs` / `pendingCalls`。

## 1. 症状表

| 现象 | 先看 | 判定 |
|---|---|---|
| 模型选择器里没有 DeepSeek Web API | `sync-profiles.py --profile desktop --check`；`install.ps1` 是否跑过 | 配置没同步或镜像缺文件；install 会逐文件 SHA256 校验 |
| 回合秒结束、一个工具都没执行、界面上出现协议样残片 | `curl /health` 的 `capabilities`；反代调试日志的 `protocolShape` | 后端是旧 dist → 见下一行 |
| 报 `BACKEND_STALE` | 错误文本已写明后端目录与"跑 `pnpm build`" | 该目录 `dist` 落后于 `src`；重跑 `install.ps1` 会直接警告 |
| 正文里仍出现未解析的协议标记，且回合被重试 | 错误码 `PROTOCOL_LEAK`（信息里带"通道"与"后端判定"） | 说明上游吐出了解析器不认识的新形态。把该轮 debug 行的 `conversation` + `protocolShape` + 残片发给维护者。**只在带工具的回合判定**：没有工具时（如会话标题请求）这类字样按合法正文放行，不报错 |
| 想知道某轮为什么没调工具 | 每轮 debug 行的 `protocolShape` / `protocolTruncated` | `dsml`/`json` 表示正文里有对应协议的标记；`none` 只表示**没有标记文本**（真机常见：模型直接吐裸 JSON，解析器照样能成调用，此时 `toolCalls=1` 且 `protocolShape=none` 是正常的）；`truncated=true` 表示载荷不完整、已走重试；`unknown` 表示后端是旧 dist，没有回传诊断 |
| 用户点"停止"后看到重试 | 错误码应为 `ABORTED`（不在重试码表里） | 若出现的是 `TRANSPORT`，说明中止路径回退了，属回归 |
| 401 / `AUTH` 且不重试 | 三个密钥来源：配置 `apiKey` → `DS_API_KEY` → `data/.api-key` | 插件会打一条"未找到 API Key…"告警，含具体路径与 `pnpm login` |
| 长时间卡住后自动重来一轮 | `TIMEOUT` | `streamIdleTimeoutMs`（默认 120s）触发，属预期 |
| 界面 75 秒只见思考不见正文 | 大参数工具回合（真机 `write` 38474 字符） | 已知设计取舍，见 `docs/protocols.md` 第 2 节（TODO P1-2） |
| token 水位/压缩时机看着不对 | 每轮 debug 行的 `usage=输入/输出` | 输出是上游真值；输入上游从不报（`prompt_tokens: 0`），由插件按上线载荷估算（CJK 1 字 1 token） |
| 行为诡异、像跑了另一套后端 | `/health` 的 `version/toolReasoning/toolCalls` 与 `~/.dsh/deepseek-web-api.json` | 8787 上可能是别人（或你手工）起的进程。插件只树回收**自己拉起**的；不放心就杀掉再起 |

## 2. 明确**不是**本插件问题的两类失败

真机 `session-969ec5e0` 里出现过、容易被误挂到反代/插件头上的两条：

1. `Error: camofox POST /tabs 失败：HTTP 500 / browserType.launch: ENOENT`
   —— 浏览器自动化工具自己的报错（Playwright 找不到浏览器可执行文件）。反代与插件此时工作正常。
2. `Error: camofox POST /tabs 失败：HTTP 400 / Blocked URL scheme: file:`
   —— 该工具**有意**不允许打开 `file://`，属安全限制，需要本地 HTTP 服务承载页面。不是解析失败。

**区分办法**：本插件的所有失败都表现为"一个 `finish` 块带 `kind:'error'` 与稳定错误码
（`AUTH`/`QUOTA`/`RATE_LIMIT`/`INVALID_REQUEST`/`CONTEXT_WINDOW_EXCEEDED`/`SERVER`/`TRANSPORT`/`TIMEOUT`/
`ABORTED`/`EMPTY_RESPONSE`/`PROTOCOL_LEAK`/`BACKEND_STALE`/`HTTP_<status>`）"；
工具自身的报错走的是 `tool/result`，与模型回合无关。

## 3. 为什么"零产出"也要报错

反代最初那类故障的共同点不是"错"，而是**静默**：一个空回合被当成正常完成。
所以插件对"整轮无正文、无思考、无调用"报 `EMPTY_RESPONSE`（可重试），
对"只有思考、思考里全是协议残片"报 `PROTOCOL_LEAK`。判据宁可偏严：
`EMPTY_RESPONSE` 允许重试是因为它确实没产出可保留的东西。

## 4. 换机器时的必查项

- `serverDir` **不需要**再写绝对路径：`DSH_DEEPSEEK_WEB_API_DIR` 或跑一次 `install.ps1 -BackendDir <路径>` 固化指针。
- 反代需重新登录（`pnpm login`），登录态在 `data/auth.json` 与 `data/chrome-profile`。
- 指针文件里的 `gitRev` 与后端实际 HEAD 不一致时，说明你在跑旧构建。
- Chrome CDP 端口（默认 9333）上若有**别的** Chrome，反代会复用它——这是为保登录态的既有设计，
  插件不会去杀不属于自己的浏览器进程。
