# dsh-deepseek-web-api TODO —— 第二次真机长时程复盘（证据：DSH 会话 `session-7f8ab623`）

> 上一份 TODO（P0-1…P3-5 共 34 条 + 各批落地记录）已全部闭环，正文被本轮替换；原文可查 `git show e4bc542:TODO.md`。
> 落地记录里那些"为什么这么做"的论证仍然有效（能力契约为何不信版本号、托管/detach 的 EPIPE 语义、环境变量白名单、指针文件为何存在…），
> 需要时按那条路径回读，不要在本文重复。本文只保留**结论指针**，正文换成这条链在真实任务里**新暴露**的缺口。
> 口径不变：每条 = 代码位置 + 实测证据（seq/时间）+ 改法 + 验收；写作标准仍是"新机器上也能照着敲"。
> 分工不变：插件只做协议翻译与进程托管，解析与重试的权威在反代后端。
>
> 那次任务是什么：用户让 DSH（跑在 **本插件 + `deepseek-web-thinking`** 上）克隆并接入 minimax 网页反代，
> 中途要它把 MiniMax 的**微信扫码登录二维码**发给用户。00:46 起跑，跨 8 小时，turn 1–5 全程走本插件、500+ 次工具调用。
> **它始终没能把那张图"看"懂一次**：反复"我再创一条设备码"（`seq 1905/1912/1919/1926`），4 次 `read_image` 全灭，
> 最后在 09:12（本地）把模型选择器切到第三方（`magpie/auto/*`、`kilo/minimax/minimax-m3.1-flash:free`）才用 `present` 把二维码发出去。
> 那 5 小时的绕行不是模型笨，是这条链在"图像"上是**死路，而且没人向模型交代这是死路**。这是本轮审计的主线。

---

## 0. 本轮已闭环的（不要重复劳动）

| 事项 | 结论 |
|---|---|
| 指针 `gitRev` 过期永不回写 | 提交 `fb4f25f`：`lib/paths.js` 新增 `shouldRefreshPointer()` + install.ps1 pointer 分支回写 + smoke 断言；实测输出 `指针 gitRev 已过期，回写: … 168c46e -> 71db820` |
| "超长提示词导致空返回"的错误定性 | 提交 `71db820`（新 capability `empty-stream-attribution`）：streamWatch 给 `upstream-not-started / upstream-silent / parser-dropped-content` |
| 运行态换代 | 旧 detach 后端 `8544` 已按树回收，现 `13072`；`/health` = 8 条能力位含 `empty-stream-attribution`；真实回合 `ms=4433 ttft=1555ms reasonChars=174 toolCalls=1 usage=0/672 outcome=tool-calls`、零告警 |
| 上一份 TODO | P0 全 8 条、P1-1…P1-8、P2-1…P2-8、P3-1…P3-5 已落地；**但 P0-7 的前提被本轮推翻，见 P0-A1** |

---

## P0-A —— 图像通路：本次事故的正身

- [x] **P0-A1 图片在到达插件之前就被内核换成占位文本，所以 P0-7 的"丢弃告警"在真实链路上永不触发。** —— 已修，见文末「本轮落地记录」
  内核取证（直读 `app.asar`，逐字）：`textOnlyImageText(ref)` →
  `[image omitted because this model accepts text only; attachment sha256:xxxxxxxx]`。
  插件侧的对应物是 `lib/openai.js:96-99` 的 `skipped` 分支（"消息中的 … 内容无法经网页反代转发，已丢弃（仅支持纯文本）"），
  它只在 **raw image block 真的进了 messages** 时才可能触发。实测本会话 turn 1–5（跑在本插件上）**没有任何一条记录含 `image` block**，
  模型反复读到的是那句占位符（`seq 1277`、`1292`）：它只知道"图被省略了"，**不知道图是什么、存在哪、能怎么办**。代价是 5 小时绕圈。
  改法（纯插件侧，不动后端）：
  ① `collectText()` 除返回 `skipped` 类型外，把 block 上的**可定位信息**（路径 / 文件名 / attachment id）一并带出；
  ② `formatOpenAiMessages` 认出 `[image omitted …]` 时补一句稳定提示："本模型无图像输入；要让用户看到这张图就用 present 工具、或把**文件路径**写进正文；要图中内容就请用户用文字描述。"
  这条提示有实据：本会话 `seq 1742` 截图工具本来就返回纯文本
  `截图已保存：C:\…\camofox-screenshot-2026-10-21T01-04-01-487Z.png（要看图请用 read_image 读这个路径…）`
  —— **路径一直在消息里**，缺的只是"没有视觉时该拿路径做什么"这一句。
  验收：mock 一条含占位符的 tool 结果 → 断言插件送出的 prompt 同时含"无图像能力 / 路径 / 下一步"三要素；smoke 加用例。

- [x] **P0-A2 `context.contextWindow` 不做类型强制：一个字符串值会同时打断模型路由与图像工具。已本地复现。** —— 已修，见文末「本轮落地记录」
  内核校验（逐字）：
  `if (context !== void 0 && (!Number.isInteger(context.contextWindow) || context.contextWindow <= 0)) throw new LlmError('adapter returned invalid context metadata for provider "…" model "…"', 'INVALID_MODEL_CONTEXT')`
  插件（`lib/provider.js:223`）：`context: { contextWindow: opts.maxContextWindow }` —— **原样透传，不 coerce**；
  `_read()` 只做 `{ ...DEFAULTS, ...raw }`，`apply(ctx, config)`（`lib/provider.js:632-638`）把 cordis 配置对象当活源直接接进来。
  复现（本轮实跑，用运行时镜像里同一份 `lib/provider.js`）：
  ```
  maxContextWindow: "128000"  →  context.contextWindow 类型 string → 内核判 INVALID_MODEL_CONTEXT
  走 DEFAULTS（数值 128000）  →  number，正常
  ```
  会话里的形态完全吻合：4 次 `read_image` 全在**发起后 8ms 内**失败（`seq 1069→1070`、`1273→1274`、`1283→1284`、`1758`），
  `isError:true`，正文 `Error: adapter returned invalid context metadata for provider "deepseek-web-api" model "deepseek-web-thinking"`，
  `error.code = INVALID_MODEL_CONTEXT` —— 工具**根本没执行**，模型连"图片多大、什么格式"都拿不到，只能得出"我完全看不了图"。
  为什么一直没被抓到：smoke 全用数值（`test/smoke.mjs:191` `assert.ok(resolved.context?.contextWindow > 0)`、`:1059`、`:1075`），
  而 YAML / 控制台设置里写 `maxContextWindow: "128000"` 完全合法 —— `'128000' > 0` 同样为 true，现有断言拦不住。
  改法：`resolveModel` 内统一 `Number(...)` + `Number.isInteger(x) && x > 0` 校验；非法就 `warn` 一条**可定位**告警并**回落 `DEFAULTS.maxContextWindow`**，
  绝不让 `prepareCall` 把异常抛给内核（抛出去表现为 `INVALID_MODEL_CONTEXT`，用户只会以为"这个模型不能看图"）。
  `defaultMaxTokens` 同样补正整数约束（现在只有 `Number.isFinite`）。
  验收：smoke 两条（字符串配置 → 必须得到正整数；无法解析 → 必须回落并留告警）；
  `docs/troubleshooting.md` 症状表加一行："`read_image`/`prepareCall` 秒失败 + `INVALID_MODEL_CONTEXT` = 申报值类型不对，不是模型不支持图"。

- [x] **P0-A3 `inputModalities: ['text']` 申报是对的，但它换来的是"图片消失"，不是"图片可替代"。** —— ①②已落地、③给了结论，见文末「本轮落地记录」
  现状：`lib/provider.js:209`（`listModels`）与 `:222`（`resolveModel`）都申报 `['text']`。
  内核另一处（逐字）：`if (info.inputModalities === void 0 || !info.inputModalities.includes("image")) throw new AcpContentError('model "…" does not declare image input','invalid')`
  —— **假装支持图像只会把失败换一个错误码**，不能治本。要补的是替代路径，按成本三档，**先做 ①②**：
  ① **无视觉也能把图交付**：真正救场的是 `present` 把 `minimax-wechat-qr.png` 发给用户（`seq 2059`、`2064`）。
     这不需要图像能力 —— 在 `KNOWN_MODELS`（`lib/provider.js:39-56`）的 `description` 里写清"无图像输入；要给用户看文件请用 present / 给出路径"，
     让模型**第一轮就想到**，而不是先绕 5 小时。
  ② **本地把图变文字（专治二维码）**：二维码里唯一有用的信息就是一段文本。给一条可选的本地解码路径（zxing / pyzbar，走后端已有的 Python 环境；
     **插件保持零依赖**，别把解码库塞进 `package.json`，CI 的零依赖断言会红）。本会话直到 `seq 2292` 才把设备码链接当文字念出来
     （`…/oauth-authorize?user_code=HU7R-PFV4`），而从页面 DOM 直接取这个 URL 早就能成 —— **"扫码"这件事本来可以完全不经过视觉**。
  ③ **真给上游喂图（工作量大，本轮只要求给可行性结论）**：反代 `src/deepseek/completion.ts:44` 发的是 `"ref_file_ids": []` —— 硬编码空数组，
     而网页版聊天本身支持附件。要做先探清 `chat.deepseek.com` 的上传接口与 file 对象结构（红线：只读探测、凭据不落日志、不新增远端），
     再决定支持与否；落地就把能力位加进 `/health` 并同步 `inputModalities`。
  验收：①②进 README/docs 并有可执行示例；③要么留"上游不支持 / 需要 X 步"的明确结论，要么实现并有一次真实回合。

---

## P0-B —— 空回合归因的后续（上一轮的尾巴，别再靠猜）

- [ ] **P0-B1 等一次真实空回合样本，按 `emptyVerdict` 分流错误码。** —— 分流本身已随 P0-B2 落地，**仍缺真实样本验证**
  归因已上线（`71db820`），但**新字段至今零样本**：`~/.dsh/logs/deepseek-web-api.log` 里还没有任何 `emptyVerdict` 行（最近一轮是 01:12 的成功 `tool-calls`）。
  务必别再写反的定性：15:18–15:36 UTC 的 `promptChars=301902 / 305013` **成功**（retry 1 后 `protocolShape:dsml` 恢复），
  15:43:40–15:49:14 UTC 窗口内 `634 / 4695 / 28213 / 79634 / 125238 / 257158 / 332109` **全空**
  —— 提示词大小不是分类器，那是一段窗口里上游整体不应答（本轮复核日志时先用宽泛关键词统计出"88 处失败"，也是同类错误，见文末附 2）。
  分流口径：`upstream-not-started` / `upstream-silent` → 可重试（`SERVER`/`TIMEOUT`），文案写"上游未响应"；
  `parser-dropped-content` → 修我们的正常化；只有真拿到上游超限措辞才 `CONTEXT_WINDOW_EXCEEDED`
  （该码在 `lib/provider.js:196` 的 `retryableCodes` 里**故意不可重试**，用错会让人去砍对话历史）。
- [x] **P0-B2 `EMPTY_TOOL_RESPONSE_TEXT` 仍在伪装成正常正文。** —— 已修，见文末「本轮落地记录」
  `src/deepseek/toolOutcome.ts:5` + `src/deepseek/client.ts:81/111`：判空后把兜底串当 `content` 下发，DSH 于是看到"有正文的一轮"，
  用户读到 `DeepSeek Web did not produce a usable tool call or final answer after one automatic retry.`，
  而插件 `lib/provider.js:577-584` 的 `EMPTY_RESPONSE` 分支永远走不到。
  改法：判空轮次**不带正文**，改抛 `HttpError(504, 归因文案)`；并且**流内错误要带 `error.status`** ——
  `src/api/chatCompletions.ts:65-68` 现在只写 `{error:{message}}`，插件 `lib/provider.js:453-459` 拿不到 ≥400 的 status 就判成 `TRANSPORT`。
  验收：重放一次空上游（可用 P1-4 的 mock 后端），界面出现带原因的错误码而不是正文，日志错误码与 `emptyVerdict` 一致。

---

## P1 —— 本轮实测暴露的健壮性/运维缺口

- [ ] **P1-1 复用 8787 之前不校验"是不是我要的这一代"。** 今天真实发生：改后端 + `pnpm build` 之后只重启客户端，
  新客户端仍复用旧 PID `8544`（`/health` 只有 7 条能力），因为新增 capability **没进 `REQUIRED_CAPABILITIES`** 就不参与契约。
  这正是 P3-3 落地记录里写下的"能发现但不拦"的缺口在现实里咬人。
  改法：把"本轮必须存在"的能力加进契约（或用 `requiredCapabilities` 在 profile 里点名）；
  否则"版本号会骗人、能力位不会"这条经验只在你手动查 `/health` 时才成立。
- [ ] **P1-2 9333 上的 Chrome 已定性为上一代孤儿**（实测，非推测；上一份 TODO 的 P2-1 只把"父进程 19508 已死"当背景事实记下，没形成检查）：
  后端 `13072` 的子进程里没有它，它的父进程 `19508` 已不存在，而它的 `--user-data-dir` 正是本仓 `data/chrome-profile`。
  dispose 走进程树回收 → 树上没有它 → 永远带不走，而启动日志照旧"已连接 Chrome CDP"照单复用。
  改法：连 CDP 前比对 `--user-data-dir` 是否等于自己的 profile；不等则自起一个，并让 `/health` 报 `cdp: reused-foreign | owned`。
  注意与 P2-2"不杀不是自己起的 Chrome"的既有取舍并存：那是**登录态**，别顺手 kill。
- [ ] **P1-3 会话被截断时本地没有任何证据。** `session-7f8ab623` 最后一条是 `tool/call`（`job/registered=78` vs `settled=77`），
  既无 `tool/result` 也无 `turn/end`，插件日志对应时段也没有错误行 —— 现场只能靠猜。
  改法：`stream` 的抛错/中止路径保证**至少一行**含 `conversation` + `outcome` 的日志落盘；`docs/troubleshooting.md` 补"会话被截断怎么取证"。
- [ ] **P1-4 把 streamWatch 字段写进文档，并让 Responses 路径同样暴露。** `src/deepseek/mapResponses.ts` 已带 `emptyVerdict/streamEvidence`，
  但 `docs/api.md` 与 README 特性清单还没描述；真实空回合样本一到，日志口径要能查表而不是现场猜字段含义。

---

## 附：取证方法（下次排障直接抄）

1. **DSH 会话转录解码**：`~/.dsh/sessions/--C-Users-Admin-DeepSeek-Harness--/session-<uuid>/session.v4.jsonl.zstd`
   —— **每条记录是一个独立 zstd 帧**（magic `28 b5 2f fd`）。对整文件调 Node 的 `zlib.zstdDecompressSync` 只会拿到第一条（214 字节的 session 头），
   必须按 magic 切帧逐帧解；切到"下一帧起点"偶尔会截断该帧，把切片末尾加宽 1–8MB 重试（本轮 1283 帧 → 2358 条记录全解出）。
   文件是活的，读到 ENOENT 多半撞上重写，先 `cp` 快照再解。
   ⚠ `docs/troubleshooting.md` 里"一分钟取清单"那条 zstd 说明要按此更正——整文件解只得到头部，极易被误判成"这个会话是空的"。
2. **区分真错误与关键词噪声**：只看 `isError:true` / 正文以 `Error:` 开头 / 含 `Traceback`。宽泛正则（`error|404|failed`）会捞出 88% 的正常结果
   —— 本轮踩过一次，差点据此得出"那次任务有 88 处失败"的结论（真实只有 6 处，其中只有 P0-A2 那条伤到了本插件）。
3. **内核侧事实靠直读 `app.asar`**（182MB 二进制 grep；本轮有效的检索词：`textOnlyImageText`、`accepts text only`、`INVALID_MODEL_CONTEXT`、
   `does not declare image input`、`detachedModalities`）。别再猜 `LlmAdapter` 契约 —— 上一轮就是因为猜，把 `defaultMaxTokens`（预留）当成真实上限写进了文档。
4. 插件日志 `~/.dsh/logs/deepseek-web-api.log` 时间戳是 **UTC**（本地 = +8），与会话对齐时先换算。

---

## 附：本轮落地记录（P0-A / P0-B，2026-10-21）

1. **P0-A2 申报值收口（插件）**：`lib/provider.js` 新增导出 `positiveIntOption(raw, key, fallback, warn)`，
   `resolveModel` 里 `maxContextWindow` 与 `defaultMaxTokens` 都过它 —— 非法值**回落 + 一条指名道姓的告警**，
   而不是让 `prepareCall` 把异常抛给内核（内核那句 `INVALID_MODEL_CONTEXT` 会连带打死 `read_image`，
   看起来完全像"这个模型不支持图"）。smoke 新增：`'128000'` → 必须得到数字 128000 且**不告警**；`'abc'`/`0` → 回落 128000 且告警点名 `maxContextWindow`。
2. **P0-A1 + A3①② 图片可自救（插件）**：`lib/openai.js`
   ① `collectText()` 的 skipped 标签现在带可定位信息（`image(qr.png sha256:… 450x450)`）；
   ② 新增 `countImageOmissions(text)` + `imageOmissionHint(count)`：认出内核的 `[image omitted …]` 就在该条消息后补
   `[no-image-input] …` 一句，明确"重试读图不会改变结果"+三条替代路径；`KNOWN_MODELS` 两条 description 直接写"只接受纯文本，无图像输入"。
   smoke 断言指引三要素（无图像输入 / 路径 / 下一步）与告警带出文件名+attachment id。
   `docs/troubleshooting.md` 加了"文字优先"一行：真机里救场的是 `…/oauth-authorize?user_code=XXXX` 这行文字，不是像素解码；
   本机没有任何图像解码库，**纯像素解码属未验证路径**，也不许为此给插件加依赖（CI 有零依赖断言）。
3. **P0-A3③ 结论（不做）**：上游附件通路在本项目血脉里就不存在 —— 反代 `src/deepseek/completion.ts:44` 发 `"ref_file_ids": []`，
   `SPEC.md:73` 把同一个空数组写进请求契约，vendored 参考实现 `_reference/server.mjs` 全文只有这一处、**没有任何上传路径**，
   `docs/api.md` 的 Not supported 第一条就是它。要支持需要逆向了私有上传接口（鉴权 + 文件对象结构 + 会话血缘），
   属独立立项，需要授权与专门验证；本轮不动。
4. **P0-B2 空回合出真错误码**：
   - 反代 `src/deepseek/streamWatch.ts` 新增 `emptyUpstreamFailure(evidence, promptChars)`：`upstream-silent` → `HttpError(504)`、
     `upstream-not-started` → `HttpError(502)`、`parser-dropped-content` → **返回 null**（那是我们的解析漏了，说成"上游不可用"会让人白重试）。
   - 重试编排放进新模块 `src/deepseek/toolRecovery.ts`（`client.ts` 因此从 308 行回到 284 行，仍在 300 行守卫内）：
     判空且有归因时**抛出**，不再把兜底串当正文下发。
   - `src/api/chatCompletions.ts` 的流内错误帧现在带 `error.status`（响应头早已 flush，插件拿不到 status 就按可重试的 `TRANSPORT` 处理）。
   - **文案约束（踩出来的）**：客户端把 `context length … limit` 这类措辞映射成**不可重试**的 `CONTEXT_WINDOW_EXCEEDED`，
     所以失败文本连"否定它"都不能写。现在写 `unrelated to prompt size`，测试断言消息**不含** `/context\s+(length|window)/i`。
   - 验证：反代 20 个测试文件 / **166 用例**全绿（原 158 + 新增 8），`pnpm lint`（含 300 行与英文注释两道守卫）、`pnpm build`、`tsc --noEmit` 全通过；
     插件 18 段 smoke + config_check + prepareCall 回归全绿，新增两条断言（504 → 可重试 `SERVER`；错误帧文本不混进正文）。

5. **上线与复验**：反代提交 `a409146`、插件 `632c06f` + `977ea0d`(hermetic) + `7c9c7f9`(告警去重)；
   `install.ps1` 回写指针 `71db820 -> a409146` 并逐文件校验镜像一致；旧后端 13072 已按树回收，客户端重启后由新代码拉起 19076。
   真实回合复验（`test/live_e2e.mjs`）：`/health` 8 条能力位、`mismatches=0`、`ms=10530 ttft=4708ms toolCalls=1 usage=0/672 outcome=tool-calls`、零告警。
   插件 CI 全绿（structure ubuntu × smoke windows-latest，Node 20/22）。
   **CI 抓到两个本机看不到的问题**（都值得记住）：① 新增用例没传 manager，于是 `current()` 去解析后端目录 —— 本机命中指针所以安静，
   干净 runner 上多一条告警把"合法值不该告警"判失败；② 申报失败文本里写了"not a context length limit"，被插件的上下文超长措辞正则命中，
   504 空回合被判成**不可重试**的 `CONTEXT_WINDOW_EXCEEDED` —— 否定一句诊断语也一样会触发正则。**仍缺的验证**：真实空回合样本（`emptyVerdict` 上线后还没有一条），
   以及后端仓 GitHub Actions 对 `main` 的 push **没有触发任何 run**（`a409146`/`71db820`/`168c46e` 都查不到，属既有状态，非本轮引入）。

