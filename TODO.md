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

- [ ] **P0-1 usage 全链路缺失,插件用错误口径估算顶替**
  证据:实测探针里最终 chunk `usage=null`;反代 `chatCompletions.ts` 流式分支只写 `[DONE]`,
  `chatStream.ts#finalChunk` 只带 `conversation`/`previous_response_id`,**从不带 usage**;
  插件 `provider.js:384` 的 `if (chunkData?.usage)` 因此永远不成立,100% 走 `:404` 的兜底估算。
  而兜底估算 `JSON.stringify(options.messages).length/3` 漏掉了 system(17235 字符)与 52 个工具 schema(50553 字符),
  且中文按 /3 折算,单轮真实输入被低报数倍 —— DSH 的上下文水位与压缩决策全部建立在错数上。
  改法:①插件请求体加 `stream_options:{include_usage:true}`;②反代把已经统计到的 `accumulated_token_usage`
  (`updates.ts:75`)写进 `finalChunk.usage`;③插件加 `sawUsage` 标志,**只在没收到真实 usage 时**才发估算,
  并把 system+tools 计入估算基数。

- [ ] **P0-2 工具 description 被砍成首行,`workflow` 丢了 81% 的说明**
  证据:`provider.js:133` `String(t.description||'').split('\n')[0]`;真机 52 个工具共 13393 字符说明,
  插件只保留 12043,**丢 1350 字符(10.1%),其中 `workflow` 1667 → 317**。
  反代 `promptBuild.ts:196` 是把工具定义原样注入提示词的,所以这里砍掉的就是模型永远看不到的部分。
  改法:默认不截断(反代已按指纹缓存,重复注入不额外花钱);若要控体积,改成"按总预算裁剪 + 记录被裁工具名 + 可配置",
  并在 smoke 里断言 `workflow` 的多行说明完整透传。

- [ ] **P0-3 `defaultMaxTokens: 8192` 是个假承诺**
  证据:插件请求体(`provider.js:225`)**不含 `max_tokens`**;反代全仓 `grep max_tokens` 零命中(只有 `models.ts` 解析 thinking)。
  真机第 4 步一次吐出 38474 字符的 `write` 参数(远超 8192 token),说明上限既没传也没生效。
  改法:二选一并写进文档 —— 要么插件透传 `options.maxTokens`、反代映射到上游;
  要么 `resolveModel` 不再返回 `defaultMaxTokens`,避免 DSH 按 8192 规划截断/压缩。

- [ ] **P0-4 用户中止被上报成可重试的 TRANSPORT**
  证据:`signal` 只传给了 `fetch`(`:247`),读流循环(`:287`)不检查 `signal.aborted`;
  中止时 `reader.read()` 抛错落到 `:434` 的通用 catch,产出 `code:'TRANSPORT'` —— 而 `TRANSPORT` 在
  `providerRetryPolicy.retryableCodes`(`:154`)里,`maxRetries:2`。用户点"停止"可能触发重试。
  改法:catch 里先判 `signal?.aborted === true` → `kind:'aborted'`;并在 `finally` 里 `reader.cancel()`/`releaseLock()`
  释放连接(现在 `PROTOCOL_LEAK` 提前 return 也会把 HTTP body 挂着)。

- [ ] **P0-5 所有非 2xx 都当 SERVER 重试,401/400 白烧两轮**
  证据:`provider.js:261-272` 统一产出 `code:'SERVER'`(可重试)。API Key 轮换失效(401)、请求体非法(400)
  都会被重试 2 次(1.5s→5s 退避),最后给用户一句无关痛痒的报错。
  改法:按状态码分流 —— 401/403 → `AUTH`(不可重试,提示"检查 `data/.api-key`"),400/422 → `INVALID_REQUEST`(不可重试),
  429 → `RATE_LIMIT`(可重试,退避拉长),5xx/502 → `SERVER`。反代的 `HttpError` 已带状态码,透传即可。

- [ ] **P0-6 `messages` 里的 system 角色会被静默丢弃(待确认 + 加固)**
  证据:`formatOpenAiMessages`(`:95-121`)只处理 `user`/`assistant`/`tool` 三种 role,其余**直接跳过**;
  真机日志里存在独立的 `system/message` 事件(seq 15,17235 字符)。目前无法从会话日志证明它走的是 `options.system`
  还是 `messages[]` —— 一旦是后者,整段系统提示词不会到达模型,而插件不会有任何报错。
  改法:`role==='system'` 时并入前导 system(或原样透传),并在 smoke 里加一条"messages 含 system 角色"的断言。
  顺带:未知 role 至少要 `logger.warn`,不要静默吞。

- [ ] **P0-7 非文本 block 被静默压成空串,图片能力名不副实**
  证据:`textOf`(`:71-85`)只收 `type==='text'`;DSH 工具表里有 `read_image`,`listModels`/`resolveModel`
  又只声明 `inputModalities:['text']`。图片内容会被丢掉且无提示。
  改法:短期 —— 遇到 image/其他 block 时 `logger.warn` 并明确告知"网页反代不支持图片输入";
  长期 —— 反代支持后再打通,并同步更新 `inputModalities`。

---

## P1 —— 流式体验、健壮性与可观测性

- [ ] **P1-1 `tool_calls` 不按 `index` 累积,依赖"后端一次给全"的隐含假设**
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

- [ ] **P1-4 每一步都 `/health` 探活,且没有请求级超时**
  证据:`:211` 每次 `stream()` 都 `await this.manager.ensure()`(内含 3s 超时探针),真机 13 步 = 13 次探活;
  同时 fetch 只受 DSH 的 signal 约束,上游卡死就会永久挂着(反代侧也没有 inactivity timeout)。
  改法:健康状态缓存 30s(或仅在传输失败后重新探活);加"连续 N 秒无字节 → `TIMEOUT`(可重试)"与总时长上限。

- [ ] **P1-5 错误路径不关闭已打开的 block**
  证据:`PROTOCOL_LEAK` 提前 return(`:427`)与 catch 分支(`:436`)都没有补 `block-end`;
  收尾处的 `block-end`(`:399`)复用 `blockIndex` 但不自增,后续再开块会与它撞索引。
  改法:`try/finally` 统一收口;索引分配收敛成一个 `nextIndex()`。

- [ ] **P1-6 `/health` 太哑:插件无法确认"在跑的是哪一套后端、哪一套配置"**
  证据:实测 `GET /health` 只返回 `{"ok":true}`。本次真机会话用的后端是**我手工起的** PID 11192
  (父进程是 shell,不是 DSH),因此插件 `spawnServer` 注入的 `DS_TOOL_REASONING`/`DS_TOOLS`(`server.js:72-74`)
  **在真机链路上从未被执行过**;会话日志也无法证明当时跑的是 clean 还是 hidden
  (反代默认是 `hidden`,见 `config/env.ts:61`),我只能靠探针数推理增量段数才反推出来是 clean。
  改法:反代 `/health` 返回 `{ok,version,toolReasoning,toolCalls,upstreamOk,sessionAge}`;
  插件 `ensure()` 比对自己的配置,不一致就 `logger.warn`(或 `strictBackend:true` 时拒绝复用、改为重启),
  并把后端 version 与 `minBackendVersion` 对照(见 P3-3)。

- [ ] **P1-7 插件侧几乎零日志,反代已经算好的诊断没被用上**
  证据:`ctx.logger` 只在 spawn 时用了一次(`server.js:109/122`);每轮的 ttft、chunk 数、finish_reason、
  是否重试、协议形态全都没有落日志。反代其实已经算了 `protocolShape`/`protocolTruncated`
  并在最终 chunk 带了 `conversation`(实测 `conv=4a9cdaf8-…`),插件一律忽略。
  改法:反代把诊断塞进最终 chunk;插件每轮 `logger.debug` 一行
  (`ttft/chunks/reasonChars/contentChars/toolCalls/protocolShape/finish/conversation`),
  并像 `tail()` 一样保留环形缓冲,便于"跑完就能复盘"。当初那个 bug 要是有这行日志,一眼就能定位。

- [ ] **P1-8 后端日志只在内存里,崩溃现场拿不到**
  证据:`server.js:53-57` 的 `recentLogs` 上限 50 行、只存内存,`tail()` 仅拼进启动失败的错误串;
  插件没有对外暴露任何诊断入口。
  改法:可选 `logFile` 配置(默认写到插件目录下 `logs/backend.log`,轮转),并把 `tail()` 通过一个诊断命令/工具暴露出来。

---

## P2 —— 进程生命周期、安全与可移植性

- [ ] **P2-1 `dispose()` 只杀直接子进程,headless Chrome 变孤儿**
  证据:当前 Chrome PID 13136(监听 CDP 9333)的 `ParentProcessId=19508`,而 19508 是**早已被杀掉的旧后端**;
  它至今存活,新后端靠 `data/chrome.cdp` 复用它。`server.js:141` 的 `child.kill()` 在 Windows 上不成树。
  改法:Windows 用 `taskkill /PID <pid> /T /F`(或显式结束 CDP 拉起的 Chrome),加配置开关
  `killTreeOnDispose`(默认真),并在文档里写清"复用已有 Chrome 是有意为之"。

- [ ] **P2-2 spawn 继承整个 `process.env`**
  证据:`server.js:69` `...process.env`。DSH 进程里任何 `DS_*`/`PORT` 都会渗进后端;
  目前只因 `opts.env` 最后展开才没被覆盖,插件不认识的变量则完全失控。
  改法:改成白名单(PATH/HOME/USERPROFILE/APPDATA/TEMP/SYSTEMROOT + 显式 DS_*),其余不传。

- [ ] **P2-3 API Key 每请求同步读盘,缺失时静默**
  证据:`resolveApiKey`(`server.js:14-31`)每次 `stream()` 都 `readFileSync`;找不到就返回 `''`,
  请求不带 Authorization → 反代 401 → 按 P0-5 白重试两轮,用户看不到"密钥没配"这个真因。
  改法:按 mtime 缓存;为空时 `logger.warn` 给出明确指引(`data/.api-key` 路径 + 如何生成);任何日志都不得打印密钥本体。

- [ ] **P2-4 到处硬编码 `C:\Users\Admin\...`,换机器即废**
  证据:`provider.js:40` DEFAULTS.serverDir、`cordis.patch.yml:18`、`install.ps1` 里的 `$backendDir` 全是绝对路径。
  改法:支持环境变量(如 `DSH_DEEPSEEK_WEB_API_DIR`)/相对仓库根解析 + 常见位置探测,失败时给可操作报错;
  文档里把"必须改这三处"写清楚。

- [ ] **P2-5 插件目录自带嵌套 `.git`,外层 `dsh-client-config` 无法追踪其文件**
  证据:`plugins/dsh-deepseek-web-api/.git` 存在,remote 为 `git@github.com:banyeshuiwujiao/dsh-deepseek-web-api.git`;
  同级 `dsh-eagent` 等插件都是外层仓库的普通文件。
  改法:**需要用户决策** —— 保留为独立仓/子模块,或删掉嵌套 `.git` 折进外层仓(删除属破坏性操作,不擅自做)。

- [ ] **P2-6 配置快照一次性,改了要重启客户端**
  证据:`apply(ctx, config)`(`provider.js:445-450`)在加载时合并一次 config;
  `registerConfigurableProviders` 声明了 `settingsPath:['providers','deepseek-web-api']`,但没有订阅变更。
  改法:监听配置变更 → 重建 manager/adapter(注意别把正在跑的请求打断),或至少在文档里写明"改配置需重启"。

- [ ] **P2-7 模型能力表与 thinking 判定各自为政**
  证据:`KNOWN_MODELS` 已经有 `thinking` 字段,但 `:219-221` 用的是
  `model.includes('pro') || model.includes('reasoner')` 这种字符串猜测;
  另外 `reasoning:{effort:'medium'}` 在反代侧只被当作真假开关(`models.ts:33-35` 仅判 none/off/0/false/disabled),
  "medium" 这个档位并不存在。
  改法:`isThinking` 从 `KNOWN_MODELS` 查表,未知模型给出显式策略(默认关思考 + warn);
  去掉误导性的 effort 档位,或推动反代真正支持档位。

---

## P3 —— 测试、CI 与版本文档

- [ ] **P3-1 smoke 覆盖面不够**
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
  改法:配合 P1-6 的 `/health.version`,`ensure()` 里校验 `minBackendVersion`,不满足就明确报错并提示 `pnpm build`。

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

## 附:本轮已完成(不要再改)

- [x] 反代支持 DSML 解析并与文本协议按文档顺序合并(`dsmlCalls.ts` / `toolCalls.ts`)。
- [x] 不完整协议片段不再被当作可信调用:标记 `protocolTruncated` 并触发后端重试(`toolOutcome.ts`)。
- [x] 工具回合的推理增量实时下发(`DS_TOOL_REASONING=clean` + `toolStream.ts#ProtocolTextGate`)。
- [x] 插件侧泄漏兜底 `PROTOCOL_LEAK` 进 `retryableCodes`,并注入 `DS_TOOL_REASONING`/`DS_TOOLS`。
- [x] `profiles/desktop/cordis.patch.yml` 增补 `toolReasoning: 'clean'` / `tools: 'text'` 并已 `sync-profiles.py` 同步。
- [x] smoke `[5/5]` 两例 + 真实 DSH `prepareCall` 回归通过;运行时镜像与源一致。
