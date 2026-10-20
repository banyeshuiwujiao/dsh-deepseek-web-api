# 工具协议：两种形态、一处缓冲

> 面向维护者。用户视角的说明在 `README.md`；故障定位看 `docs/troubleshooting.md`。

## 1. 为什么会同时存在两种协议

DSH 不自带"文本工具协议"的提示词，它按原生 function calling 的形态把工具表交给适配器。
而反代对接的是 **chat.deepseek.com 的私有网页接口**，它没有原生 function 通道，只能把工具表以文本形式
写进 prompt，再靠模型在自由文本里"照着格式吐"。于是同一件事有两种产出形态：

| 形态 | 来源 | 长什么样（不写原文，避免复制即污染） | 谁负责解析 |
|---|---|---|---|
| 文档化文本协议 | 反代在 prompt 里注入的 `[Tool compatibility]` 策略 | 成对的调用标记 + 一段 JSON（`name` / `arguments`） | 反代 `toolCalls.ts` |
| 网页原生 DSML | 模型自己的训练产物，未经提示词要求就可能冒出来 | 带 `｜DSML｜` 立杠的 `calls` / `invoke` / `parameter` 三层嵌套标记，参数值按 `string="true|false"` 区分类型 | 反代 `dsmlCalls.ts` |

关键点：**两种都会被解析**，插件侧不需要关心后端选了哪种措辞（`tools: 'text' | 'native'` 只改提示词措辞）。
但历史故障恰恰出在只认第一种：DSML 被当成正文返回，`finish_reason` 是 `stop`，
DSH 于是把回合判成 `completed` 且一个工具都没执行——**而且全程没有 warn/error**，
一次真实会话里表现为 50 秒首字 + 一次性吐完一万多 token + `toolMs 0`。

## 2. 为什么工具回合的正文要"缓冲后一次性下发"

反代的 `ProtocolTextGate` 能做到"只扣住可能是标记开头的尾巴"，因此**推理**是实时流式的
（`DS_TOOL_REASONING=clean`，由插件注入）。但**正文**在工具回合仍然缓冲，理由是：

1. 判定"这段文本是正文还是协议"的权威只有解析器，而解析要看到完整片段才能定；
2. 上游会把一个标记切成好几个 chunk 送来，逐字转发就可能先把 `<`、`｜｜DSML` 这类残片当正文显示出去；
3. 一旦脏文本进了 UI，后面的重试会在用户面前留下"脏文本 + 重来一遍"的双份内容，比多等几秒更糟。

代价是可感知的：大参数工具调用（真机见过一次 `write` 38474 字符、整步 75.6 秒）期间，
界面只有思考气泡在动、正文要等收尾。要改成"正文也增量下发"必须重新论证上面第 2 条不变量，
并补"标记被跨 chunk 切断"的用例——那是设计变更，不是打补丁。（TODO 里记为 P1-2，明确暂不做。）

## 3. 不完整载荷的处理

DSML 被截断时（常见于上游把长参数吐到一半结束），宁可判"这轮不可用"并触发一次自动重试，
也不要把残缺载荷当成 `arguments: {}` 的空调用交给宿主执行——真机早期版本就这么产生过一次
`write` 空调用。判定条件在 `dsmlCalls.ts`：载荷要么完整闭合、要么至少存在一个已闭合的 `parameter`，
且解析出非空参数；否则记 `truncated`，由 `toolOutcome.ts` 折算成可重试。

## 4. 能力自述：为什么不信版本号

`/health` 回报 `capabilities` 而不是让插件比版本数字。真机抓到过决定性反例：
一个**旧 dist** 的进程自述 `version: 0.2.0`（因为版本号是每次请求现读 `package.json` 的），
但没有 `capabilities` 字段——按版本号判断会直接放行它。
所以硬门槛是能力清单：`dsml-tool-calls`、`protocol-switches`、`include-usage`、`health-self-description`
（缺任一项即 `BACKEND_STALE`，不可重试；`strictBackend: false` 可降级为告警）。
