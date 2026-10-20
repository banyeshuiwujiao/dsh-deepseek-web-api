# dsh-deepseek-web-api TODO —— 真机跑通之后的深度审计(0.1.0,证据见 `session-969ec5e0`)

> 现状:DSML/文本协议双解析 + 泄漏兜底重试 + `toolReasoning`/`tools` 两个开关已落地,
> 真机会话 `session-969ec5e0-85de-47ea-b01a-a0799cbacf37`(2026-10-20 18:38,13 步 / 13 次工具调用 / 169.5s)
> **一次跑通、零重试、零协议泄漏**,`turn/end reason=completed`。
> 本文件不是"待办清单",是**这次真机链路复盘后逐条对照代码审出来的缺口**:每条都带代码位置 + 实测证据 + 建议改法。
> 总原则:**插件只做协议翻译与进程托管,解析/重试的权威留在反代后端**;插件侧兜底必须"可观测、可重试、不误伤"。

---

## 0. 调用链路(真机复核版,改代码前先看)

| 环节 | 位置 | 真机会话实测 |
|---|---|---|
| ① DSH 选模型 | `provider.js#prepareCall` → `resolveModel` | `provider=deepseek-web-api`,`model=deepseek-web-thinking`,`contextWindow=128000`,`defaultMaxTokens=8192` |
| ② 确保后端存活 | `server.js#ensure` → `GET /health` | 复用了**已在跑的** PID 11192(`node dist/index.js start`),没有走 `spawnServer` |
| ③ 组请求体 | `provider.js#formatOpenAiMessages` / `formatOpenAiTools` | system 17235 字符 + 52 个工具(schema 50553 字符)+ 历史(工具结果累计 57628 字符) |
| ④ 发 SSE 请求 | `POST 127.0.0.1:8787/v1/chat/completions` | `model:'deepseek-chat'`、`stream:true`、`thinking_enabled:true`、`reasoning:{effort:'medium'}` |
| ⑤ 后端鉴权/建提示词 | 反代 `authMiddleware` → `promptBuild.ts` | 注入 `[Tool compatibility]` 策略 + 完整工具定义;DSH 自己的 system 里**没有任何协议字样**(实测 grep DSML/tool_call 全为 -1) |
| ⑥ 会话血缘复用 | 反代 `sessionStore.ts` / `sessionTurns.ts` | 按 tools/prompt 指纹复用网页会话,13 步里 11 步 2–11s 返回 |
| ⑦ 上游取流 | 反代 `client.ts` → `iterDeepSeekUpdates` | 推理增量 22 段起于 +3940ms(实测探针) |
| ⑧ 工具回合裁决 | 反代 `chatStream.ts#consumeToolChat` → `toolOutcome.ts` → `parseToolCalls`(DSML 优先) | 推理**实时**流出;正文缓冲到解析完成再一次性下发 |
| ⑨ 下发结构化调用 | 反代 `emitToolChat` | 单个 chunk 内给出完整 `tool_calls`(带 `index`/`id`/`function.arguments`),`finish_reason='tool_calls'` |
| ⑩ 插件映射为 DSH 块 | `provider.js#stream` | `reasoning-delta` / `text-delta` / `block-start`+`tool-call-delta`+`block-end` / `usage`(估算) / `finish` |
| ⑪ DSH 执行工具 | 客户端 | `web_search`×3、`web_fetch`、`write`(38474 字符 HTML)、`read`×3、`camofox`×2、`pwsh`×3,参数**完整无损** |
| ⑫ 收尾 | 客户端 | 第 13 步纯正文 1220 字符交付,`turn/end completed` |

**已验证正确的部分**(不要重复劳动):DSML 与 JSON 文本协议双解析、大参数(`write` 38474 字符)完整落地、
多步连续调用不串号、正文无协议残留、`PROTOCOL_LEAK` 兜底未被触发(说明解析已经稳)。

---

## P0 —— 会直接影响正确性/额度结算的缺口

- [x] **P0-1 usage 全链路缺失,插件用错误口径估算顶替** —— 已修,见文末「P0 落地记录」
  证据:实测探针里最终 chunk `usage=null`;反代 `chatCompletions.ts` 流式分支只写 `[DONE]`,
  `chatStream.ts#finalChunk` 只带 `conversation`/`previous_response_id`,**从不带 usage**;
  插件 `provider.js:384` 的 `if (chunkData?.usage)` 因此永远不成立,100% 走 `:404` 的兜底估算。
  而兜底估算 `JSON.stringify(options.messages).length/3` 漏掉了 system(17235 字符)与 52 个工具 schema(50553 字符),
  且中文按 /3 折算,单轮真实输入被低报数倍 —— DSH 的上下文水位与压缩决策全部建立在错数上。
  改法:①插件请求体加 `stream_options:{include_usage:true}`;②反代把已经统计到的 `accumulated_token_usage`
  (`updates.ts:75`)写进 `finalChunk.usage`;③插件加 `sawUsage` 标志,**只在没收到真实 usage 时**才发估算,
  并把 system+tools 计入估算基数。

- [x] **P0-2 工具 description 被砍成首行,`workflow` 丢了 81% 的说明** —— 已修,见文末「P0 落地记录」
  证据:`provider.js:133` `String(t.description||'').split('\n')[0]`;真机 52 个工具共 13393 字符说明,
  插件只保留 12043,**丢 1350 字符(10.1%),其中 `workflow` 1667 → 317**。
  反代 `promptBuild.ts:196` 是把工具定义原样注入提示词的,所以这里砍掉的就是模型永远看不到的部分。
  改法:默认不截断(反代已按指纹缓存,重复注入不额外花钱);若要控体积,改成"按总预算裁剪 + 记录被裁工具名 + 可配置",
  并在 smoke 里断言 `workflow` 的多行说明完整透传。

- [x] **P0-3 `defaultMaxTokens: 8192` 是个假承诺** —— 已修,见文末「P0 落地记录」
  证据:插件请求体(`provider.js:225`)**不含 `max_tokens`**;反代全仓 `grep max_tokens` 零命中(只有 `models.ts` 解析 thinking)。
  真机第 4 步一次吐出 38474 字符的 `write` 参数(远超 8192 token),说明上限既没传也没生效。
  改法:二选一并写进文档 —— 要么插件透传 `options.maxTokens`、反代映射到上游;
  要么 `resolveModel` 不再返回 `defaultMaxTokens`,避免 DSH 按 8192 规划截断/压缩。

- [x] **P0-4 用户中止被上报成可重试的 TRANSPORT** —— 已修,见文末「P0 落地记录」
  证据:`signal` 只传给了 `fetch`(`:247`),读流循环(`:287`)不检查 `signal.aborted`;
  中止时 `reader.read()` 抛错落到 `:434` 的通用 catch,产出 `code:'TRANSPORT'` —— 而 `TRANSPORT` 在
  `providerRetryPolicy.retryableCodes`(`:154`)里,`maxRetries:2`。用户点"停止"可能触发重试。
  改法:catch 里先判 `signal?.aborted === true` → `kind:'aborted'`;并在 `finally` 里 `reader.cancel()`/`releaseLock()`
  释放连接(现在 `PROTOCOL_LEAK` 提前 return 也会把 HTTP body 挂着)。

- [x] **P0-5 所有非 2xx 都当 SERVER 重试,401/400 白烧两轮** —— 已修,见文末「P0 落地记录」
  证据:`provider.js:261-272` 统一产出 `code:'SERVER'`(可重试)。API Key 轮换失效(401)、请求体非法(400)
  都会被重试 2 次(1.5s→5s 退避),最后给用户一句无关痛痒的报错。
  改法:按状态码分流 —— 401/403 → `AUTH`(不可重试,提示"检查 `data/.api-key`"),400/422 → `INVALID_REQUEST`(不可重试),
  429 → `RATE_LIMIT`(可重试,退避拉长),5xx/502 → `SERVER`。反代的 `HttpError` 已带状态码,透传即可。

- [x] **P0-6 `messages` 里的 system 角色会被静默丢弃(待确认 + 加固)** —— 已修,见文末「P0 落地记录」
  证据:`formatOpenAiMessages`(`:95-121`)只处理 `user`/`assistant`/`tool` 三种 role,其余**直接跳过**;
  真机日志里存在独立的 `system/message` 事件(seq 15,17235 字符)。目前无法从会话日志证明它走的是 `options.system`
  还是 `messages[]` —— 一旦是后者,整段系统提示词不会到达模型,而插件不会有任何报错。
  改法:`role==='system'` 时并入前导 system(或原样透传),并在 smoke 里加一条"messages 含 system 角色"的断言。
  顺带:未知 role 至少要 `logger.warn`,不要静默吞。

- [x] **P0-7 非文本 block 被静默压成空串,图片能力名不副实** —— 已修(告警口径),见文末「P0 落地记录」
  证据:`textOf`(`:71-85`)只收 `type==='text'`;DSH 工具表里有 `read_image`,`listModels`/`resolveModel`
  又只声明 `inputModalities:['text']`。图片内容会被丢掉且无提示。
  改法:短期 —— 遇到 image/其他 block 时 `logger.warn` 并明确告知"网页反代不支持图片输入";
  长期 —— 反代支持后再打通,并同步更新 `inputModalities`。

---

## P1 —— 流式体验、健壮性与可观测性

- [x] **P1-1 `tool_calls` 不按 `index` 累积,依赖"后端一次给全"的隐含假设** —— 已修,见「P1 落地记录」
  证据:实测探针里后端在**单个 chunk**给出完整数组(带 `index:0`/`id`/完整 `arguments`),
  插件 `:358-377` 于是逐个开块-发增量-关块。一旦后端改成 OpenAI 标准分片(同 `index` 多次追加 `arguments`),
  插件会产出 N 个各自残缺的 tool-call 块;而 `:360` 的兜底 id `call_${Date.now().toString(36)}` 在同一毫秒内多调用会**撞号**。
  改法:用 `Map<index, {id,name,args}>` 累积,在 `finish_reason` 或流结束时统一关块;兜底 id 加自增序号;
  smoke 增加"分片 tool_calls"与"单 chunk 双调用"两个用例。

- [ ] **P1-2 工具回合的正文仍然全量缓冲,长任务期间界面只有思考气泡**
  证据:真机第 4 步耗时 **75602ms**(生成 38474 字符的 `write` 参数),期间 DSH 只能显示推理增量;
  反代 `chatStream.ts#consumeToolChat` 是刻意缓冲正文以避免半截协议标记外泄。
  改法:反代已有 `toolStream.ts#ProtocolTextGate`(只扣住"可能是标记开头"的尾巴),把正文也接上这个闸门即可增量下发;
  插件侧配合 P1-5 的泄漏闸门。落地前必须补"标记被切成两半跨 chunk"的 smoke 用例。

- [ ] **P1-3 泄漏检测发生在流末尾,脏文本已经给用户看过了**
  证据:`:414` 的 `hasProtocolLeak(contentText)` 在所有 `text-delta` 发完之后才判断;
  命中后报 `PROTOCOL_LEAK` 触发重试 → 用户先看到一段协议垃圾,再看到重来的答案。
  另外只查 `contentText`,**没查 `reasoningText`** —— `toolReasoning:'clean'` 下推理是原样实时下发的。
  改法:把闸门前移到 `text-delta`(可疑尾巴先扣住,确认不是标记再放行),并对 reasoning 通道同样检测。

- [x] **P1-4 每一步都 `/health` 探活,且没有请求级超时** —— 已修,见「P1 落地记录」
  证据:`:211` 每次 `stream()` 都 `await this.manager.ensure()`(内含 3s 超时探针),真机 13 步 = 13 次探活;
  同时 fetch 只受 DSH 的 signal 约束,上游卡死就会永久挂着(反代侧也没有 inactivity timeout)。
  改法:健康状态缓存 30s(或仅在传输失败后重新探活);加"连续 N 秒无字节 → `TIMEOUT`(可重试)"与总时长上限。

- [x] **P1-5 错误路径不关闭已打开的 block** —— 顺手已修(见「P0 落地记录」第 9 条),索引收敛仍待做
  证据:`PROTOCOL_LEAK` 提前 return(`:427`)与 catch 分支(`:436`)都没有补 `block-end`;
  收尾处的 `block-end`(`:399`)复用 `blockIndex` 但不自增,后续再开块会与它撞索引。
  改法:`try/finally` 统一收口;索引分配收敛成一个 `nextIndex()`。

- [x] **P1-6 `/health` 太哑:插件无法确认"在跑的是哪一套后端、哪一套配置"** —— 已修,见「P1 落地记录」
  证据:实测 `GET /health` 只返回 `{"ok":true}`。本次真机会话用的后端是**我手工起的** PID 11192
  (父进程是 shell,不是 DSH),因此插件 `spawnServer` 注入的 `DS_TOOL_REASONING`/`DS_TOOLS`(`server.js:72-74`)
  **在真机链路上从未被执行过**;会话日志也无法证明当时跑的是 clean 还是 hidden
  (反代默认是 `hidden`,见 `config/env.ts:61`),我只能靠探针数推理增量段数才反推出来是 clean。
  改法:反代 `/health` 返回 `{ok,version,toolReasoning,toolCalls,upstreamOk,sessionAge}`;
  插件 `ensure()` 比对自己的配置,不一致就 `logger.warn`(或 `strictBackend:true` 时拒绝复用、改为重启),
  并把后端 version 与 `minBackendVersion` 对照(见 P3-3)。

- [x] **P1-7 插件侧几乎零日志,反代已经算好的诊断没被用上** —— 已修,见「P1 落地记录」
  证据:`ctx.logger` 只在 spawn 时用了一次(`server.js:109/122`);每轮的 ttft、chunk 数、finish_reason、
  是否重试、协议形态全都没有落日志。反代其实已经算了 `protocolShape`/`protocolTruncated`
  并在最终 chunk 带了 `conversation`(实测 `conv=4a9cdaf8-…`),插件一律忽略。
  改法:反代把诊断塞进最终 chunk;插件每轮 `logger.debug` 一行
  (`ttft/chunks/reasonChars/contentChars/toolCalls/protocolShape/finish/conversation`),
  并像 `tail()` 一样保留环形缓冲,便于"跑完就能复盘"。当初那个 bug 要是有这行日志,一眼就能定位。

- [x] **P1-8 后端日志只在内存里,崩溃现场拿不到** —— 已修(可选 `logFile`),见「P1 落地记录」
  证据:`server.js:53-57` 的 `recentLogs` 上限 50 行、只存内存,`tail()` 仅拼进启动失败的错误串;
  插件没有对外暴露任何诊断入口。
  改法:可选 `logFile` 配置(默认写到插件目录下 `logs/backend.log`,轮转),并把 `tail()` 通过一个诊断命令/工具暴露出来。

---

## P2 —— 进程生命周期、安全与可移植性

- [x] **P2-1 `dispose()` 只杀直接子进程,headless Chrome 变孤儿** —— 已修,见「P2 落地记录」
  原证据:Chrome PID 13136(监听 CDP 9333)的 `ParentProcessId=19508`,而 19508 是**早已被杀掉的旧后端**;
  它至今存活,新后端靠 `data/chrome.cdp` 复用它。`child.kill()` 在 Windows 上不成树。

- [x] **P2-8(新发现)托管 stdio 让后端被拉起者的退出以 EPIPE 方式牵连杀死** —— 已修(改成显式 `detach`),见「P2 落地记录」
  原证据:`live_e2e.mjs` 跑完退出后,8787 直接 connection refused——后端不是因为"宿主 dispose"优雅收的,
  而是因为父进程没了、stdout 管道断裂、写日志时 EPIPE 未捕获而自杀。行为"碰巧对",但既不可控也难诊断,
  一次性脚本会被误伤。

- [x] **P2-2 spawn 继承整个 `process.env`** —— 已修(白名单),见「P2 落地记录」第 5 条
- [x] **P2-3 API Key 每请求同步读盘,缺失时静默** —— 已修(mtime 缓存 + 一次性可操作告警),见「P2 落地记录」第 6 条

- [ ] **P2-4 到处硬编码 `C:\Users\Admin\...`,换机器即废**
  证据:`provider.js:40` DEFAULTS.serverDir、`cordis.patch.yml:18`、`install.ps1` 里的 `$backendDir` 全是绝对路径。
  改法:支持环境变量(如 `DSH_DEEPSEEK_WEB_API_DIR`)/相对仓库根解析 + 常见位置探测,失败时给可操作报错;
  文档里把"必须改这三处"写清楚。

- [x] **P2-5 插件目录自带嵌套 `.git`,外层 `dsh-client-config` 无法追踪其文件** —— **这是有意设计，不要"修"**
  用户 2026-10-20 明确：本插件故意做成独立仓（`banyeshuiwujiao/dsh-deepseek-web-api`），与配置仓分开提交，
  避免被 `git add -A` 一并卷进 `dsh-client-config` 的提交。所以：**不删嵌套 `.git`，不折进外层仓，不做 submodule。**
  配套已落定（外层提交 `0fd2771`）：`.gitignore` 的「嵌套的独立 git 仓库」段补上 `plugins/dsh-deepseek-web-api/`，
  并 `git rm --cached` 掉 4f22dad 时代误跟踪的 `package.json`（文件留在磁盘，本仓从 `fdba50d` 起一直跟踪它）。
  留下的规矩：以后本插件目录整体只在本仓提交；外层仓只提交 `profiles/**`；新独立的插件仓都要在同一段 .gitignore 里登记，
  别再出现"半跟踪"状态。任何后续 agent 看到外层 `?? plugins/dsh-deepseek-web-api/...` 属正常，不是待办。

- [ ] **P2-6 配置快照一次性,改了要重启客户端**
  证据:`apply(ctx, config)`(`provider.js:445-450`)在加载时合并一次 config;
  `registerConfigurableProviders` 声明了 `settingsPath:['providers','deepseek-web-api']`,但没有订阅变更。
  改法:监听配置变更 → 重建 manager/adapter(注意别把正在跑的请求打断),或至少在文档里写明"改配置需重启"。

- [x] **P2-7 模型能力表与 thinking 判定各自为政** —— `resolveThinkingEnabled()` 已改为查 `KNOWN_MODELS.thinking`，只有未知模型才回退名字匹配；smoke 断言 flash/thinking/reasoner 三种判定。`effort` 档位仍只是布尔（反代只认开关），未动。
  证据:`KNOWN_MODELS` 已经有 `thinking` 字段,但 `:219-221` 用的是
  `model.includes('pro') || model.includes('reasoner')` 这种字符串猜测;
  另外 `reasoning:{effort:'medium'}` 在反代侧只被当作真假开关(`models.ts:33-35` 仅判 none/off/0/false/disabled),
  "medium" 这个档位并不存在。
  改法:`isThinking` 从 `KNOWN_MODELS` 查表,未知模型给出显式策略(默认关思考 + warn);
  去掉误导性的 effort 档位,或推动反代真正支持档位。

---

## P3 —— 测试、CI 与版本文档

- [x] **P3-1 smoke 覆盖面不够** —— 已扩到 9 段：分片 tool_calls 合成、单块双调用与 id 兜底、abort→ABORTED、401/429/502 码分流与 Retry-After、真实 usage 只发一块、无 usage 时的估算口径、system/developer 透传与未知角色告警、多行描述完整上线、归因头确实带出、错误路径 block 闭合、探活 TTL、diffHealth。
  仍缺：泄漏闸门行为（等 P1-3 一起做）、`logFile` 轮转（目前只在 live_e2e 真机侧验过）。
  现状:`test/smoke.mjs` 已有 `[5/5]` 两例(泄漏 → `PROTOCOL_LEAK`;正文里出现 parameter 样式文本 → 正常 `stop`)。
  待补:单 chunk 多调用、分片 `tool_calls` 按 index 累积、abort → `ABORTED`、401 不可重试、
  真实 usage 存在时不发估算、messages 含 system 角色、多行 description 完整透传、错误路径仍补 `block-end`。

- [ ] **P3-2 没有 CI**
  证据:仓库无 `.github/`;`package.json` 的 `test` 只跑 smoke,`preparecall_regression.mjs` 需要真实 DSH 运行时(CI 跑不了)。
  改法:加 workflow 跑 `node --check lib/*.js` + `node test/smoke.mjs`;把 prepareCall 回归标为"仅本地",
  并在 README 写清两者的分工。

- [ ] **P3-3 插件与后端的版本契约没有锁**
  证据:插件 0.1.0 的正确性依赖反代未发布的那批提交(`25c39de`…`e117a84`:DSML 解析、`DS_TOOLS`、截断重试、推理流式)。
  跑一个旧 `dist` 会**静默退回到最初那个 bug**(协议文本当正文、回合判为 completed)。
  现状:P1-6 之后 `/health` 会自述 version 与开关，旧构建(不自述)已被 `diffHealth` 判为 stale 并告警——**能发现，但不会拦**。
  待做:把"必须满足的能力下界"写成断言(例如要求 `/health` 里出现 `toolCalls` 字段，缺失即拒绝复用而不是只 warn)，
  或给反代发一个真正的版本号(现在恒为 0.1.0，分辨不出新旧)。

- [ ] **P3-4 `install.ps1` 校验太弱**
  证据:只判断 `dist/index.js` **是否存在**(过期 dist 也算通过),只复制 `lib`/`package.json`/`README.md`,
  不比对版本、不提示后端 git 版本、不重启客户端。
  改法:比对源与运行时镜像的 `version`;`dist` 的 mtime 早于 `src` 最新文件时强制重建;
  结束时打印后端 `git rev-parse --short HEAD` 与 `/health` 的 version,便于事后追责。

- [ ] **P3-5 文档要补的三件事**
  ① 双协议设计(反代文档化文本协议 vs 网页原生 DSML)与"为什么正文在工具回合要缓冲";
  ② `PROTOCOL_LEAK` 兜底的触发条件与用户可见表现;
  ③ 本次真机会话里两个**不是本插件问题**的失败要写进 troubleshooting,避免误判归因:
  `camofox POST /tabs HTTP 500 (browserType.launch ENOENT)` 与 `HTTP 400 Blocked URL scheme: file:`。

---

## 附:P2 落地记录(进程生命周期批次)

新增 `lib/process.js`（把"怎么起、怎么收"从 server.js 里拆出来，便于单测），`lib/server.js` 负责按配置选用。

1. **进程树回收**：`killProcessTree(pid)` 在 Windows 走 `taskkill /PID <pid> /T /F`，POSIX 先打进程组
   `-pid`，拿不到进程组时退化成单进程信号（不比旧行为差）；`isAlive()` 用 `signal 0` 探测，`EPERM` 算活着。
   `dispose()` 默认 `killTreeOnDispose: true` → 后端起的 headless Chrome 一起收，不再留占 CDP 端口的孤儿。
   幂等：目标已自行退出时按成功处理（`taskkill` 的"没有这样的进程"不报错）。
   测试 `[11/12]` 用真进程复现"父起孙"的形状（后端 → Chrome 就是这个形状），断言两代都消失；
   并断言无效 PID/已退出 PID 不抛。
2. **两种显式语义，取代"靠 EPIPE 碰巧对"**：
   - 托管（默认）：`stdio: ['ignore','pipe','pipe']`，插件能 tail 与落盘；拉起者被强杀 → 管道断裂 → 后端 EPIPE 退出。
     这条耦合现在是**被测试锁住的行为**，而不是意外事故。
   - `detach: true`：`detached` 新进程组 + `stdio` 落 `logFile`（没配就 ignore）+ `unref()`，
     `child` 置空，`dispose()` 明确不碰它（只打一行 info 说明保留 PID）。
   测试 `[12/12]` 用桩"后端"（监听 `PORT` + 每 120ms 写心跳）分别验证：detach 下包装进程退出后
   `GET /health` 仍通；托管下它必然死掉。断言失败信息里写明"说明 stdio 选择逻辑变了，请同步 README"。
   顺带修掉一个真 bug：detach 下 `child` 故意为 null，`ensure()` 的就绪轮询原来按 `child === null`
   判"进程已退出"，会把主动解耦误报成启动失败——现在按 PID 存活判断。
3. **可诊断性**：`manager.pid()` 暴露 PID；拉起时 `logger.info` 打 `PID=… 模式=托管|detach`；
   回收时打 `method=taskkill ok=true/false`；日志目录不存在会先建（`writeLogFile` 与 detach fd 都补了 `mkdirSync`）。
4. **有意不做**（避免误伤，留作后续）：
   - **不自动回收陈旧 PID 文件里的进程**。理由是 Windows 上 PID 会被复用，且当前 8787 上很可能就是
     用户手工起的 `node dist/index.js start`——按一个残留 PID 去 `taskkill /T` 有可能杀掉无关进程。
     要做也得先校验命令行与端口再动，收益不抵风险。
   - **不杀"不是自己起的" Chrome**。复用已有 Chrome 是后端的既有设计（保住登录态与 CDP 会话），
     插件只负责自己那条进程树。

5. **环境变量白名单（P2-2）**：新增 `buildChildEnv(source, {inject, extraKeys})`，只放行
   `ENV_BASE_ALLOWLIST`（PATH/PATHEXT/SYSTEMROOT/WINDIR/COMSPEC/USERPROFILE/APPDATA/LOCALAPPDATA/
   PROGRAMFILES/TEMP/HOME/TZ/LANG…，跑 Node 与 Chrome 够用，按反代 `src/config/env.ts` 实际读取项核对过）
   + `DS_` 命名空间（后端自己声明的 `DS_DATA_DIR`/`DS_AUTH_FILE`/`DS_CDP`/`DS_CHROME_PATH`/`DS_DEBUG`/`DS_POW_JS`…）
   + 插件显式 `inject`（`PORT`/`DS_TOOL_REASONING`/`DS_TOOLS`，优先级最高）+ `opts.env`。
   其余（`npm_config_*`、`VIRTUAL_ENV`、`PYTHONPATH`、别的插件的 `CAMOFOX_PORT`、`DEEPSEEK_API_KEY`）一律不进子进程。
   额外收益：宿主的 `HOST=0.0.0.0` 也不再能把反代从"只绑回环"变成监听全网卡——smoke `[13/14]` 专门断言了这一点，
   并断言白名单里没有未登记项、`passEnvKeys` 点名才放行。逃生口是 `passEnvKeys`（只写变量名）与 `opts.env`。
   拉起时 `logger.debug` 打印**放行后的变量名清单**（不打印值），渗不透也看得见。
6. **API Key 解析（P2-3）**：`resolveApiKey(opts, logger)` 保持"配置 → `DS_API_KEY` → `data/.api-key`"优先级，
   改为**按 mtime 缓存**（一次 13 步会话不再同步读盘 13 次），mtime 前进就重读；
   文件或内容为空时给**一次性**可操作告警（指出三个来源与 `pnpm login`），任何日志都不回显密钥本体。
   smoke `[14/14]` 用 `utimesSync` 把 mtime 钉到整秒时间戳，分别证明"mtime 不变不重读""mtime 前进必须见新值"
   "缺失只 warn 一次""空文件同样告警""告警里不含 sk-"。本段临时摘掉宿主 `DS_API_KEY` 并在 finally 复原，保证与调用环境无关。

**P2 剩下的**：P2-4（绝对路径硬编码三处）、P2-6（改配置要重启）。P2-1/P2-8 本批已修，P2-5 属有意设计已关闭。



## 附:P1 落地记录(本轮第二批,含真机复验)

1. **P1-1 工具调用按 `index` 累积**:改为 `Map<index,{id,name,args}>` 收分片,流收尾时统一
   `block-start → tool-call-delta → block-end` 整块下发;缺 id 用 `call_dsh_<ts>_<seq>` 自增兜底。
   smoke `[8/12]` 两个用例:同 index 分两片合成一个完整 `{"command":"ls"}`;一个 chunk 两个调用各自成块且 id 不撞。
2. **P1-4 探活缓存 + 空闲超时**:`/health` 结果按 `healthTtlMs`(默认 30s)缓存,`ensure()` 命中缓存不再发请求
   (smoke `[9/12]` 断言三次 ensure 只打一次 `/health`);读流用 `Promise.race` 包一层 `streamIdleTimeoutMs`
   (默认 120s),超时抛 `failureCode:'TIMEOUT'` → 归一为可重试的 `TIMEOUT`,不再永久挂着(smoke 实测 300ms 触发)。
3. **P1-6 后端可辨识**:`/health` 现在回 `version/toolReasoning/toolCalls/authReady/authAgeMs`
   (反代侧新增 `src/server/health.ts`,每次现读);插件 `diffHealth()` 比对自身配置,
   旧构建或开关不一致就 `logger.warn`(不阻断,复用可能有意为之)。
   真机复验:插件自己 spawn 新 dist 后拿到 `{version:"0.1.0",toolReasoning:"clean",toolCalls:"text",authReady:true,authAgeMs:1315711}`,
   `mismatches=0`;这条恰好把 P1-6 当初的疑点关掉了——现在能证明当时跑的到底是哪套配置。
4. **P1-7 每轮一行统计**:`logger.debug` 打 `model/ms/ttft/reasonChars/contentChars/toolCalls/usage/conversation/outcome`,
   失败路径按 warn。真机实测:`ms=4482 ttft=4019ms reasonChars=215 toolCalls=1 usage=0/671 outcome=tool-calls`,
   其中 `671` 是上游真实累计输出 token(不再是字符估算),`conversation` 可拿去反查网页会话血缘。
5. **P1-8 日志落盘**:`logFile` 配置后子进程输出按行追加(带 ISO 时间戳),超 2MB 轮转 `.1`;
   内存环形缓冲从 50 行提到 200 行。真机复验:跑完一轮日志文件 7 行。
6. **P1-5 补完**:错误/提前 return 路径统一走 `closeOpenBlock()`,smoke 断言 `block-start` 与 `block-end` 数量相等。

**P1 剩下的两条(都需要设计取舍,没动)**:
- **P1-2 工具回合正文仍全量缓冲**:实测 `write` 那种 38474 字符的大参数回合,界面 75s 只见思考不见正文。
  反代已有 `ProtocolTextGate` 只扣"可能是标记开头"的尾巴,理论可接上增量下发,但要重新论证
  "半截协议永不外泄"这条不变量,并补跨 chunk 切断标记的用例——是设计变更,不是补丁。
- **P1-3 泄漏闸门前移到 text-delta**:现在泄漏仍要在流末尾才发现(先给用户看脏文本,再重试一轮)。
  另:检测口径目前只硬扫 `｜DSML｜` 与 `tool_call` 两族标记,反代侧新协议形态若再变,这里要同步。



## 附:本次真机会话原始数据(便于复查)

- 会话:`session-969ec5e0-85de-47ea-b01a-a0799cbacf37`,turn 1,13 步,总时长 169565ms,`reason=completed`。
- 工具调用序列:`web_search` → `web_fetch` → `web_search` → `web_search` → `write`(38474 字符)
  → `read`×3 → `camofox`(失败)→ `pwsh` → `camofox`(失败)→ `pwsh`×2,参数全部完整。
- 每步耗时:6650 / 9261 / 7391 / **75602** / 6509 / 2073 / 4217 / 6541 / 11226 / 17157 / 5620 / 5628 / 11252 ms。
- 每步推理字符:273 / 2093 / 948 / 23874 / 1824 / 155 / 383 / 365 / 3589 / 805 / 1526 / 516 / 839。
- 正文:仅第 12 步 34 字符、第 13 步 1220 字符(其余为纯工具回合),**无协议残留**。
- 请求规模:system 17235 字符;52 个工具 schema 50553 字符;本轮工具结果累计 57628 字符。
- 后端进程:8787 → PID 11192(手工启动,`node dist/index.js start`);9333 → Chrome PID 13136(父进程 19508 已死)。
- 流式探针(单工具、极简提示):推理 22 段自 +3940ms 起,`tool_calls` 与 `finish_reason` 同在 +4297ms,
  `usage=null`,`conversation=4a9cdaf8-310f-4f54-9ae0-b52febf862d8`。

## 附:P0 落地记录(本轮已修,含验证口径)

代码分布:反代 `git-repo/deepseek-web-api`(usage 那半边)+ 本插件 `lib/openai.js`(新)、`lib/kernel.js`(新)、`lib/provider.js`。

1. **P0-1 usage**
   - 反代:`stream_options.include_usage` 为真时,最后一个 chunk 挂 `usage`(上游 `accumulated_token_usage` →
     `completion_tokens`/`total_tokens`,`prompt_tokens` 保持 0);不开启时行为与之前完全一致。plain 与 tool 两条流式路径都覆盖,
     工具重试后报的是真正下发那一次的计数。
   - 插件:请求体固定带 `stream_options:{include_usage:true}`;usage 只记录不即时下发,**整轮只发一个 usage 块**
     (内核 `addUsage` 会把多个 usage 块相加,重复发=重复计费)。
   - 输出口径:有真实值就用真实值;输入口径上游永远不报,所以**始终按真正上线的载荷估算**
     (`system + 历史 + 工具 schema` 的 JSON),估算函数改为 CJK 1 字符 1 token、其余 4 字符 1 token(旧的一律 /3)。
   - 验证:smoke `[5/12]` 与 `[6/12]` 断言"真实 usage 存在 → 恰好 1 个 usage 块且等于 `{12,25}`"、
     "无 usage → 输入估算 > 10(证明 system/tools 已计入)且输出等于 `estimateTokens(正文)`"。
2. **P0-2 工具描述**:默认完整透传;新增 `toolDescriptionMaxChars`(默认 0=不裁剪,>0 才裁并加省略号)。
   smoke 断言上线请求体里 `tools[0].function.description` 等于原始多行文本。
3. **P0-3 maxTokens**:默认值 8192 → **32768**,并在 README/patch 注释里写明"上游不强制,仅用于向 DSH 申报单轮输出预留
   (内核 `reservedCompletionTokens` 按它留水位)";DSH 传来的 `options.maxTokens` 现在会透传成 `max_tokens`(反代记录但不强制)。
   `preparecall_regression` 实测真实 LlmRuntime 的 `config.maxTokens` 已变成 32768。
4. **P0-4 中止**:读流循环检查 `signal.aborted`;所有异常统一走 `transportFailure()`,
   `signal.aborted` 或 `AbortError` → `kind:'aborted'` + `ABORTED`(不在 `retryableCodes` 里);`finally` 里 `reader.cancel()` 释放连接。
   smoke 用"挂住不结束的响应 + 80ms 后 abort"实测到 `aborted`。
5. **P0-5 错误码**:新增 `failureCodeForStatus()` 对齐内核词表 —— 401/403 `AUTH`、402 `QUOTA`、429 `RATE_LIMIT`、
   400/413/422 `INVALID_REQUEST`、命中上下文超长措辞 `CONTEXT_WINDOW_EXCEEDED`、5xx `SERVER`、其余 `HTTP_<status>`;
   `failure` 带 `status`,429 透传 `Retry-After` 为 `providerRetryAfterMs`。
   `retryableCodes` 收敛为 `EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT / PROTOCOL_LEAK`,
   smoke 显式断言 `AUTH/QUOTA/INVALID_REQUEST/CONTEXT_WINDOW_EXCEEDED` **不在**其中。
6. **P0-6 消息保真**:`system`/`developer` 角色一律透传,未知角色告警后跳过(不再静默吞);
   缺失 `id` 的工具调用改用自增兜底 id(`call_dsh_N`),避免同一毫秒撞号。smoke 断言角色序列与两条兜底 id 不相同。
7. **P0-7 非文本 block**:`collectText()` 返回 `{text, skipped}`,图片等被丢弃的 block 类型会通过 `ctx.logger.warn`
   明确告警(网页反代只支持纯文本);`inputModalities` 仍为 `['text']`,如实申报。
8. **P0-8(审计时新发现)归因头**:适配器契约要求"每个 provider HTTP 请求都带 `attributionHeaders()`",旧实现完全没带。
   新增 `lib/kernel.js` 接缝(全插件唯一允许 import `@deepseek-ai/*` 的地方,惰性 + 缓存 + 字面量兜底,
   与 `dsh-our-free-model/adapter/kernel.js` 同一套做法)。smoke 从 mock server 侧断言上线请求确实带 `user-agent`。
9. **顺手修掉 P1-5 的一半**:错误/提前 return 路径现在也会补 `block-end`(`closeOpenBlock()`),
   smoke 用"流中途报错"断言 `block-start` 与 `block-end` 数量相等;索引分配收敛成一个 `nextIndex()` 仍待做。
10. **顺手加固(原 bug 同类)**:整轮零产出(无正文、无思考、无调用)不再静默 `stop`,改报 `EMPTY_RESPONSE`
    交给内核重试;协议残留检测同时覆盖"只有推理、推理里全是协议标记"的形态。
11. **思考开关**:`resolveThinkingEnabled()` 改为查 `KNOWN_MODELS.thinking`,只有未知模型才回退到名字匹配
    (旧的 `model.includes('pro')` 会把任何带 pro 字样的模型误开思考)。

**真机验证(`test/live_e2e.mjs`,2026-10-20 19:15)**:这次是**插件自己 spawn 后端**(PID 由 `createBackendManager` 拉起,
`isRunning=true`),P1-6 里"env 注入路径从未被真机执行过"的疑点已消除。一次真实工具回合:
首个推理增量 +2676ms、35 段推理增量实时下发(证明 `DS_TOOL_REASONING=clean` 生效)、
结构化 `pwsh` 调用参数完整、正文无协议残留、`finish=tool-calls`、总耗时 3058ms;
`usage` 恰好一个块 `{inputTokens:116, outputTokens:673}` —— 673 是上游真实累计输出 token(不再是字符估算),
116 是输入估算(上游 `prompt_tokens` 恒为 0,只能估)。
另:`preparecall_regression` 实测真实 LlmRuntime 的 `config.maxTokens` 已从 8192 变为 32768。

**仍未做(P1 起)**:tool_calls 按 `index` 累积、工具回合正文增量下发、探活缓存与请求级超时、
泄漏闸门前移、`/health` 版本与配置回显、插件侧每轮日志、日志落盘。



- [x] 反代支持 DSML 解析并与文本协议按文档顺序合并(`dsmlCalls.ts` / `toolCalls.ts`)。
- [x] 不完整协议片段不再被当作可信调用:标记 `protocolTruncated` 并触发后端重试(`toolOutcome.ts`)。
- [x] 工具回合的推理增量实时下发(`DS_TOOL_REASONING=clean` + `toolStream.ts#ProtocolTextGate`)。
- [x] 插件侧泄漏兜底 `PROTOCOL_LEAK` 进 `retryableCodes`,并注入 `DS_TOOL_REASONING`/`DS_TOOLS`。
- [x] `profiles/desktop/cordis.patch.yml` 增补 `toolReasoning: 'clean'` / `tools: 'text'` 并已 `sync-profiles.py` 同步。
- [x] smoke `[5/5]` 两例 + 真实 DSH `prepareCall` 回归通过;运行时镜像与源一致。
