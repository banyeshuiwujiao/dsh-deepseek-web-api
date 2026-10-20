import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  PROVIDER_ID,
  PROVIDER_LABEL,
  KNOWN_MODELS,
  DeepSeekWebApiAdapter,
  apply,
  formatOpenAiMessages,
  formatOpenAiTools,
  textOf,
  collectText,
  clampDescription,
  estimateTokens,
  estimateInputTokens,
  failureCodeForStatus,
  retryAfterMs,
  resolveThinkingEnabled,
} from '../lib/provider.js'
import { createBackendManager, diffHealth, resolveApiKey, resetApiKeyCache } from '../lib/server.js'
import { ENV_BASE_ALLOWLIST, buildChildEnv, buildSpawnPlan, isAlive, killProcessTree } from '../lib/process.js'
import { PROVIDER_ID as CONFIG_PROVIDER_ID, REQUIRED_KEYS, check as checkConfig, checkSampleHygiene } from './config_check.mjs'
import { expandHome, readGitRev, readPointer, resolveLogFile, resolveServerDir, shouldRefreshPointer, writePointer } from '../lib/paths.js'
import { checkContract, compareVersions } from '../lib/contract.js'

/** 满足能力契约的探活响应：新校验下，mock 后端必须自述能力才不会被判旧构建。 */
const HEALTH_OK = { ok: true, version: '0.2.0', toolReasoning: 'clean', toolCalls: 'text', streamContent: 'buffered', authReady: true, authAgeMs: 1, capabilities: ['dsml-tool-calls', 'protocol-switches', 'include-usage', 'health-self-description', 'live-tool-content'] }

const loggerProbe = { info() {}, warn: (m) => probeWarnings.push(m), debug() {} }
const probeWarnings = []

console.log('=== [1/18] 基础格式化：文本抽取与工具转换 ===')
assert.equal(textOf('hello'), 'hello')
assert.equal(textOf([{ type: 'text', text: 'part 1' }, { type: 'text', text: 'part 2' }]), 'part 1\npart 2')

// 非文本 block 必须被报告出来，不能静默变空串
const collected = collectText([{ type: 'text', text: '看图' }, { type: 'image', bytes: 12 }])
assert.equal(collected.text, '看图')
assert.deepEqual(collected.skipped, ['image'])

const formattedMsgs = formatOpenAiMessages({
  system: '你是助手',
  messages: [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '我在', toolCalls: [{ id: 'tc1', name: 'search', arguments: { q: 'dsh' } }] },
    { role: 'tool', toolCallId: 'tc1', content: '搜索结果' },
  ],
})
assert.equal(formattedMsgs.length, 4)
assert.equal(formattedMsgs[0].role, 'system')
assert.equal(formattedMsgs[1].role, 'user')
assert.equal(formattedMsgs[2].role, 'assistant')
assert.equal(formattedMsgs[2].tool_calls?.[0]?.function?.name, 'search')
assert.equal(formattedMsgs[3].role, 'tool')
assert.equal(formattedMsgs[3].role === 'tool' ? formattedMsgs[3].tool_call_id : '', 'tc1')

// P0-6：历史里的 system/developer 角色必须透传，未知角色必须告警而不是静默丢掉
const warnings = []
const roleMsgs = formatOpenAiMessages(
  {
    system: '外层系统提示',
    messages: [
      { role: 'system', content: '内层系统提示' },
      { role: 'developer', content: '开发者提示' },
      { role: 'user', content: '你好' },
      { role: 'mystery', content: '我是谁' },
    ],
  },
  (message) => warnings.push(message),
)
assert.deepEqual(
  roleMsgs.map((m) => m.role),
  ['system', 'system', 'system', 'user'],
)
assert.equal(roleMsgs[1].content, '内层系统提示')
assert.equal(roleMsgs[2].content, '开发者提示')
assert.equal(warnings.length, 1)
assert.match(warnings[0], /mystery/)

// 缺少 id 的工具调用要拿到互不相同的兜底 id
const idMsgs = formatOpenAiMessages({
  messages: [
    { role: 'assistant', content: '', toolCalls: [{ name: 'a' }, { name: 'b' }] },
  ],
})
const ids = idMsgs[0].tool_calls.map((c) => c.id)
assert.equal(new Set(ids).size, 2, `兜底 tool_call id 撞号: ${ids.join(',')}`)

// P0-2：工具描述默认完整透传（反代原样注入提示词，砍掉=模型看不到）
const multiLine = '执行 PowerShell\n第二行：支持管道'
const formattedTools = formatOpenAiTools([{ name: 'pwsh', description: multiLine, parameters: { type: 'object' } }])
assert.equal(formattedTools.length, 1)
assert.equal(formattedTools[0].function.name, 'pwsh')
assert.equal(formattedTools[0].function.description, multiLine)
assert.equal(formatOpenAiTools([]), undefined)
// 需要控体积时才按预算裁剪
assert.equal(clampDescription(multiLine, 8), '执行 PowerShell'.slice(0, 8) + '…')
assert.equal(formatOpenAiTools([{ name: 'x', description: multiLine }], 6)[0].function.description, '执行 Pow…')

console.log('=== [2/18] Token 估算与错误码归一 ===')
// 中文不再被 /3 低报：CJK 按 1 字符 1 token
assert.equal(estimateTokens('中文测试'), 4)
assert.equal(estimateTokens('abcd'), 1)
assert.equal(estimateTokens(''), 0)
assert.ok(estimateInputTokens([{ role: 'user', content: '中文提示' }], [{ type: 'function' }]) > 0)

// 与内核/参考适配器同一套稳定码
assert.equal(failureCodeForStatus(401), 'AUTH')
assert.equal(failureCodeForStatus(403), 'AUTH')
assert.equal(failureCodeForStatus(402), 'QUOTA')
assert.equal(failureCodeForStatus(429), 'RATE_LIMIT')
assert.equal(failureCodeForStatus(400), 'INVALID_REQUEST')
assert.equal(failureCodeForStatus(413), 'INVALID_REQUEST')
assert.equal(failureCodeForStatus(400, 'maximum context length exceeded'), 'CONTEXT_WINDOW_EXCEEDED')
assert.equal(failureCodeForStatus(503), 'SERVER')
assert.equal(failureCodeForStatus(418), 'HTTP_418')
assert.equal(retryAfterMs('2'), 2000)
assert.equal(retryAfterMs(''), undefined)
assert.equal(retryAfterMs('not-a-date'), undefined)
assert.ok(retryAfterMs(new Date(Date.now() + 5000).toUTCString()) > 3000)

// 深度思考开关查模型表，不再靠 includes('pro') 猜
assert.equal(resolveThinkingEnabled('deepseek-web-thinking'), true)
assert.equal(resolveThinkingEnabled('deepseek-web-flash'), false)
assert.equal(resolveThinkingEnabled('deepseek-reasoner'), true)
assert.equal(resolveThinkingEnabled('my-flash-clone'), false)

console.log('=== [3/18] Provider 契约与 Cordis apply 注册 ===')
const fakeCtx = {
  llm: {
    registeredProviders: null,
    adapter: null,
    configurable: null,
    registerAdapter(providers, adapter) {
      this.registeredProviders = providers
      this.adapter = adapter
      return () => { this.adapter = null }
    },
    registerConfigurableProviders(entries) {
      this.configurable = entries
    },
  },
  logger: { warn() {}, info() {}, debug() {} },
  events: {},
  on(event, fn) {
    this.events[event] = fn
  },
}

apply(fakeCtx, {
  baseUrl: 'http://127.0.0.1:8787',
  autoStart: false,
})

assert.deepEqual(fakeCtx.llm.registeredProviders, [PROVIDER_ID])
assert.ok(fakeCtx.llm.adapter, '未注册 adapter')
assert.equal(fakeCtx.llm.configurable?.[0]?.provider, PROVIDER_ID)
assert.equal(fakeCtx.llm.configurable?.[0]?.displayName, PROVIDER_LABEL)

const adapter = fakeCtx.llm.adapter
assert.equal(adapter.providerInfo(PROVIDER_ID).id, PROVIDER_ID)
assert.equal(adapter.providerInfo(PROVIDER_ID).name, PROVIDER_LABEL)
assert.equal(typeof adapter.providerRetryPolicy, 'function')

// 不可重试的码绝不能混进 retryableCodes，否则 401/400 也要白等两轮退避
const policy = adapter.providerRetryPolicy()
assert.equal(policy.mode, 'normal')
for (const code of ['AUTH', 'QUOTA', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED']) {
  assert.ok(!policy.retryableCodes.includes(code), `${code} 不该可重试`)
}
for (const code of ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'PROTOCOL_LEAK']) {
  assert.ok(policy.retryableCodes.includes(code), `${code} 应可重试`)
}
// 内核读的是扁平 backoff 字段，不是嵌套对象
assert.ok(Number.isFinite(policy.initialDelayMs) && Number.isFinite(policy.maxDelayMs))

console.log('=== [4/18] 模型列表与 resolveModel / prepareCall ===')
const models = await adapter.listModels(PROVIDER_ID)
assert.ok(models.length >= 2, '模型列表数量不足')
assert.ok(models.some((m) => m.id === 'deepseek-web-flash'))
assert.ok(models.some((m) => m.id === 'deepseek-web-thinking'))

const resolved = await adapter.resolveModel(PROVIDER_ID, 'deepseek-web-flash')
assert.equal(resolved.id, 'deepseek-web-flash')
assert.equal(resolved.provider, PROVIDER_ID)
assert.ok(resolved.context?.contextWindow > 0)
// P0-3：申报的输出预留必须大于实测单轮产出（约 2 万 token），不能再用 8192 骗宿主
assert.ok(resolved.defaultMaxTokens >= 32768, `defaultMaxTokens 太小: ${resolved.defaultMaxTokens}`)

const prepared = await adapter.prepareCall(PROVIDER_ID, 'deepseek-web-flash')
assert.equal(prepared.model.id, 'deepseek-web-flash')
assert.equal(typeof prepared.stream, 'function')

// 已经中止的 signal 不该再发起请求
await assert.rejects(() => adapter.prepareCall(PROVIDER_ID, 'deepseek-web-flash', { aborted: true }))

console.log('=== [5/18] SSE 增量 → DSH StreamChunk（Mock Server）===')

/** 起一个 mock 反代：记录上线请求，按给定 SSE 行回放。 */
async function withMockServer(lines, run, options = {}) {
  const seen = { headers: null, body: null }
  const srv = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(HEALTH_OK))
      return
    }
    if (options.hang === true) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      res.write('data: {"choices":[{"delta":{"content":"卡住"}}]}\n\n')
      return // 不结束响应，用于验证中止
    }
    const chunks = []
    req.on('data', (buf) => chunks.push(buf))
    req.on('end', () => {
      seen.headers = req.headers
      try {
        seen.body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        seen.body = null
      }
      res.writeHead(options.status ?? 200, {
        'Content-Type': options.status ? 'application/json' : 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...(options.retryAfter ? { 'Retry-After': options.retryAfter } : {}),
      })
      if (options.status) {
        res.end(options.rawBody ?? JSON.stringify({ error: { message: 'boom' } }))
        return
      }
      for (const line of lines) res.write(line)
      res.end()
    })
  })
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${srv.address().port}`
  try {
    const client = new DeepSeekWebApiAdapter({ baseUrl: base, autoStart: false, ...options.opts })
    const out = []
    for await (const chunk of client.stream(options.model ?? 'deepseek-web-thinking', run)) out.push(chunk)
    return { chunks: out, seen }
  } finally {
    await new Promise((resolve) => srv.close(resolve))
  }
}

const mockSseLines = [
  'data: {"choices":[{"delta":{"reasoning_content":"思考中..."}}]}\n\n',
  'data: {"choices":[{"delta":{"reasoning_content":"完成思考。"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"你好！"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"我是 DeepSeek。"}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}\n\n',
  'data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":25}}\n\n',
  'data: [DONE]\n\n',
]

const streamed = await withMockServer(
  mockSseLines,
  {
    system: '你是助手',
    messages: [{ role: 'user', content: '测试' }],
    tools: [{ name: 'pwsh', description: multiLine, parameters: { type: 'object' } }],
    maxTokens: 4096,
  },
  { opts: { apiKey: 'sk-test' } },
)
const chunks = streamed.chunks
const chunkTypes = chunks.map((c) => c.type)
console.log('收到 Chunks 类型序列:', chunkTypes.join(' -> '))

for (const type of ['block-start', 'reasoning-delta', 'text-delta', 'tool-call-delta', 'block-end', 'usage', 'finish']) {
  assert.ok(chunkTypes.includes(type), `缺少 ${type}`)
}
assert.equal(chunks.find((c) => c.type === 'reasoning-delta').text, '思考中...')
assert.equal(chunks.find((c) => c.type === 'text-delta').text, '你好！')
const toolCallChunk = chunks.find((c) => c.type === 'tool-call-delta')
assert.equal(toolCallChunk.name, 'read_file')
assert.equal(toolCallChunk.argumentsDelta, '{"path":"a.txt"}')
assert.equal(chunks.find((c) => c.type === 'finish').reason.kind, 'tool-calls')

// P0-1b：真实 usage 存在时只发一个 usage 块，且用真实值（内核会把多个 usage 块相加）
const usageChunks = chunks.filter((c) => c.type === 'usage')
assert.equal(usageChunks.length, 1, `usage 块数量应为 1，实际 ${usageChunks.length}`)
assert.deepEqual(usageChunks[0].usage, { inputTokens: 12, outputTokens: 25 })

// 上线请求体：include_usage 开关、完整工具描述、max_tokens 透传、思考开关
const wire = streamed.seen.body
assert.deepEqual(wire.stream_options, { include_usage: true })
assert.equal(wire.tools[0].function.description, multiLine, '工具描述被截断了')
assert.equal(wire.max_tokens, 4096)
assert.equal(wire.thinking_enabled, true)
assert.equal(wire.messages[0].role, 'system')

// P0-8：归因头必须在真实 HTTP 请求上（内核 helper 不可用时用字面量兜底）
const userAgent = streamed.seen.headers['user-agent'] || ''
assert.ok(userAgent.length > 0, '请求缺少 user-agent 归因头')
assert.equal(streamed.seen.headers['content-type'], 'application/json')
assert.equal(streamed.seen.headers.authorization, 'Bearer sk-test')
console.log('✅ 归因头已上线:', userAgent.slice(0, 60))

// 没有真实 usage 时按上线载荷估算，输入侧必须把 system + 工具 schema 算进去
const estimated = await withMockServer(
  [
    'data: {"choices":[{"delta":{"content":"中文回答"}}]}\n\n',
    'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ],
  { system: '你是助手', messages: [{ role: 'user', content: '测试' }], tools: [{ name: 'pwsh', description: multiLine }] },
)
const estimatedUsage = estimated.chunks.filter((c) => c.type === 'usage')
assert.equal(estimatedUsage.length, 1)
assert.ok(estimatedUsage[0].usage.inputTokens > 10, `输入估算漏算了 system/tools: ${estimatedUsage[0].usage.inputTokens}`)
assert.equal(estimatedUsage[0].usage.outputTokens, estimateTokens('中文回答'))
assert.equal(estimated.chunks.find((c) => c.type === 'finish').reason.kind, 'stop')
assert.ok(!('max_tokens' in estimated.seen.body), '未指定时不该硬塞 max_tokens')

console.log('=== [6/18] 兜底：协议残留 / 空回合 / 状态码 / 中止 ===')
const BAR = String.fromCharCode(0xff5c)
const LEAK = `${BAR}${BAR}DSML${BAR}${BAR}`

const oneTool = [{ name: 'pwsh', description: '执行命令', parameters: { type: 'object' } }]

const leaked = await withMockServer(
  [
    'data: {"choices":[{"delta":{"content":"我先建目录。\\n<' + LEAK + ' invoke name=\\"pwsh\\">"}}]}\n\n',
    'data: {"choices":[{"finish_reason":"stop"}],"diagnostics":{"protocolShape":"dsml","protocolTruncated":false,"toolCallCount":0}}\n\n',
    'data: [DONE]\n\n',
  ],
  { messages: [{ role: 'user', content: '测试' }], tools: oneTool },
)
const leakFinish = leaked.chunks.find((c) => c.type === 'finish')
assert.equal(leakFinish.reason.kind, 'error')
assert.equal(leakFinish.reason.failure.code, 'PROTOCOL_LEAK')
// 报错必须自带定位线索：哪个通道漏的、后端把这一轮判成了什么
assert.match(leakFinish.reason.failure.message, /通道=content/)
assert.match(leakFinish.reason.failure.message, /后端判定=dsml/)
console.log('✅ 带工具时残留协议文本被识别为可重试错误:', leakFinish.reason.failure.code)

// 收窄：本轮没带工具（如会话标题请求）时，协议样式文本是合法正文，不许当错误白烧重试
const leakedWithoutTools = await withMockServer(
  [
    'data: {"choices":[{"delta":{"content":"协议长这样：<' + LEAK + ' invoke name=\\"pwsh\\">，把它拆开看。"}}]}\n\n',
    'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ],
  { messages: [{ role: 'user', content: '解释一下标记协议' }] },
)
assert.equal(leakedWithoutTools.chunks.find((c) => c.type === 'finish').reason.kind, 'stop')
assert.ok(leakedWithoutTools.chunks.some((c) => c.type === 'text-delta'), '无工具时正文被错误吞掉了')
console.log('✅ 无工具的回合里协议样式文本按正常正文放行')

// 反代的解析结论要进每轮日志（旧后端没这个字段时写 unknown，不能留空）
{
  const lines = []
  const debugLogger = { debug: (m) => lines.push(String(m)), info: () => {}, warn: () => {} }
  const withDiag = await withMockServer(
    [
      'data: {"choices":[{"delta":{"content":"好的，先读文件。"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}],"diagnostics":{"protocolShape":"json","protocolTruncated":true,"toolCallCount":0}}\n\n',
      'data: [DONE]\n\n',
    ],
    { messages: [{ role: 'user', content: 'x' }], tools: oneTool },
    { opts: { logger: debugLogger } },
  )
  assert.equal(withDiag.chunks.find((c) => c.type === 'finish').reason.kind, 'stop')
  const line = lines.find((l) => l.includes('outcome=stop'))
  assert.ok(line, '没有打出每轮统计行')
  assert.match(line, /protocolShape=json/)
  assert.match(line, /protocolTruncated=true/)

  const withoutDiag = await withMockServer(
    ['data: {"choices":[{"delta":{"content":"旧后端"}}]}\n\n', 'data: {"choices":[{"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n'],
    { messages: [{ role: 'user', content: 'x' }] },
    { opts: { logger: debugLogger } },
  )
  assert.equal(withoutDiag.chunks.find((c) => c.type === 'finish').reason.kind, 'stop')
  assert.match(lines[lines.length - 1], /protocolShape=unknown/, '旧后端没带诊断时应显式写 unknown')
  console.log('✅ 后端解析结论进入每轮日志，缺失时显式 unknown')
}

const clean = await withMockServer(
  [
    'data: {"choices":[{"delta":{"content":"示例代码里写成 <parameter value=1> 或 calls 数组都算正常正文。"}}]}\n\n',
    'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ],
  // 带工具：证明"合法正文里带尖括号字样"不会被误判成泄漏
  { messages: [{ role: 'user', content: '测试' }], tools: oneTool },
)
assert.equal(clean.chunks.find((c) => c.type === 'finish').reason.kind, 'stop')
assert.ok(clean.chunks.some((c) => c.type === 'text-delta'))
console.log('✅ 带工具时正常正文仍按 stop 结束，不误判为泄漏')

// 整轮零产出 → EMPTY_RESPONSE（可重试），不再静默 stop
const empty = await withMockServer(
  ['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n'],
  { messages: [{ role: 'user', content: '测试' }] },
)
const emptyFinish = empty.chunks.find((c) => c.type === 'finish')
assert.equal(emptyFinish.reason.kind, 'error')
assert.equal(emptyFinish.reason.failure.code, 'EMPTY_RESPONSE')
console.log('✅ 空回合上报 EMPTY_RESPONSE 而不是静默完成')

// P0-5：401 → AUTH（不可重试），并带上 status
const unauthorized = await withMockServer([], { messages: [{ role: 'user', content: 'x' }] }, {
  status: 401,
  rawBody: JSON.stringify({ error: { message: 'Invalid API key' } }),
})
const authFinish = unauthorized.chunks.find((c) => c.type === 'finish')
assert.equal(authFinish.reason.kind, 'error')
assert.equal(authFinish.reason.failure.code, 'AUTH')
assert.equal(authFinish.reason.failure.status, 401)
assert.match(authFinish.reason.failure.message, /Invalid API key/)

// 429 → RATE_LIMIT，并透传 Retry-After
const limited = await withMockServer([], { messages: [{ role: 'user', content: 'x' }] }, {
  status: 429,
  retryAfter: '3',
  rawBody: JSON.stringify({ error: { message: 'slow down' } }),
})
const limitFailure = limited.chunks.find((c) => c.type === 'finish').reason.failure
assert.equal(limitFailure.code, 'RATE_LIMIT')
assert.equal(limitFailure.providerRetryAfterMs, 3000)

// 500 → SERVER（可重试）
const broken = await withMockServer([], { messages: [{ role: 'user', content: 'x' }] }, { status: 502 })
assert.equal(broken.chunks.find((c) => c.type === 'finish').reason.failure.code, 'SERVER')
console.log('✅ 状态码分流: 401=AUTH / 429=RATE_LIMIT+Retry-After / 502=SERVER')

// 流中途报错 → 按错误体归类，且已打开的 block 要收尾
const midError = await withMockServer(
  [
    'data: {"choices":[{"delta":{"content":"写到一半"}}]}\n\n',
    'data: {"error":{"message":"Invalid API key","status":401}}\n\n',
  ],
  { messages: [{ role: 'user', content: 'x' }] },
)
const midFinish = midError.chunks.find((c) => c.type === 'finish')
assert.equal(midFinish.reason.kind, 'error')
assert.equal(midFinish.reason.failure.code, 'AUTH')
const opens = midError.chunks.filter((c) => c.type === 'block-start').length
const closes = midError.chunks.filter((c) => c.type === 'block-end').length
assert.equal(opens, closes, `block 未收尾: start=${opens} end=${closes}`)

// P0-4：用户中止必须是 ABORTED（不可重试），不能被当成 TRANSPORT 再重试
const controller = new AbortController()
const abortedRun = withMockServer([], { messages: [{ role: 'user', content: 'x' }], signal: controller.signal }, { hang: true })
setTimeout(() => controller.abort(), 80)
const aborted = (await abortedRun).chunks.find((c) => c.type === 'finish')
assert.equal(aborted.reason.kind, 'aborted', `中止被误判为 ${JSON.stringify(aborted.reason)}`)
assert.equal(aborted.reason.failure.code, 'ABORTED')
console.log('✅ 中止上报 ABORTED，且不进重试码表')

// 起点就已中止
const preAborted = new DeepSeekWebApiAdapter({ baseUrl: 'http://127.0.0.1:1', autoStart: false })
const preChunks = []
for await (const chunk of preAborted.stream('deepseek-web-flash', { messages: [], signal: { aborted: true } })) {
  preChunks.push(chunk)
}
assert.equal(preChunks[0].reason.kind, 'aborted')

console.log('=== [7/18] 后端不可用时的错误口径 ===')
const offline = new DeepSeekWebApiAdapter({ baseUrl: 'http://127.0.0.1:1', autoStart: false })
const offlineChunks = []
for await (const chunk of offline.stream('deepseek-web-flash', { messages: [{ role: 'user', content: 'x' }] })) {
  offlineChunks.push(chunk)
}
const offlineFinish = offlineChunks.find((c) => c.type === 'finish')
assert.equal(offlineFinish.reason.kind, 'error')
assert.ok(['TRANSPORT', 'SERVER'].includes(offlineFinish.reason.failure.code))
console.log('✅ 后端不可达:', offlineFinish.reason.failure.code)

console.log('=== [8/18] 工具调用按 index 累积 / 流空闲超时 ===')

// 反代今天一个 chunk 给完整数组；若上游改成标准分片（同 index 多次追加），必须合成一个完整调用。
const fragmented = await withMockServer(
  [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"pwsh","arguments":"{\\"com"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"mand\\":\\"ls\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ],
  { messages: [{ role: 'user', content: '列目录' }] },
)
const fragCalls = fragmented.chunks.filter((c) => c.type === 'tool-call-delta')
assert.equal(fragCalls.length, 1, `分片没有被合成: ${JSON.stringify(fragCalls.map((c) => c.argumentsDelta))}`)
assert.equal(fragCalls[0].id, 'call_a')
assert.equal(fragCalls[0].name, 'pwsh')
assert.equal(fragCalls[0].argumentsDelta, '{"command":"ls"}')
assert.equal(fragmented.chunks.find((c) => c.type === 'finish').reason.kind, 'tool-calls')

// 一个 chunk 里两个调用：各自成块，且缺 id 时不许撞号
const multi = await withMockServer(
  [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read","arguments":"{\\"p\\":1}"}},{"index":1,"function":{"name":"write","arguments":"{\\"p\\":2}"}}]}}]}\n\n',
    'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ],
  { messages: [{ role: 'user', content: 'x' }] },
)
const multiCalls = multi.chunks.filter((c) => c.type === 'tool-call-delta')
assert.deepEqual(multiCalls.map((c) => c.name), ['read', 'write'])
assert.equal(new Set(multiCalls.map((c) => c.id)).size, 2, '兜底 id 撞号')
assert.deepEqual(multiCalls.map((c) => c.argumentsDelta), ['{"p":1}', '{"p":2}'])

// 上游卡住不发数据：按空闲超时中止，报可重试的 TIMEOUT，不能永久挂着
{
  const srv = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(HEALTH_OK))
      return
    }
    // 只发一头就不结束，逼出空闲超时路径
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    res.write('data: {"choices":[{"delta":{"content":"开头"}}]}\n\n')
  })
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const client = new DeepSeekWebApiAdapter({
    baseUrl: `http://127.0.0.1:${srv.address().port}`,
    autoStart: false,
    streamIdleTimeoutMs: 300,
  })
  const out = []
  for await (const chunk of client.stream('deepseek-web-thinking', { messages: [{ role: 'user', content: 'x' }] })) out.push(chunk)
  const finish = out.find((c) => c.type === 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'TIMEOUT')
  assert.ok(out.some((c) => c.type === 'block-end'), '超时路径没闭合 block')
  srv.closeAllConnections?.()
  await new Promise((resolve) => srv.close(resolve))
  console.log('✅ 流空闲超时上报 TIMEOUT（可重试）')
}

console.log('=== [9/18] 探活缓存与复用实例的配置比对 ===')
// /health 自述信息与插件配置比对：不一致必须报出来，旧构建要判为 stale
assert.equal(diffHealth(null, { toolReasoning: 'clean' }).stale, true)
assert.deepEqual(diffHealth({ version: '0.1.0' }, {}).mismatches, [])
const mismatch = diffHealth(
  { version: '0.1.0', toolReasoning: 'hidden', toolCalls: 'native', streamContent: 'buffered', authReady: false },
  { toolReasoning: 'clean', tools: 'text', streamContent: 'live' },
)
assert.ok(mismatch.mismatches.some((m) => m.includes('DS_TOOL_REASONING')))
assert.ok(mismatch.mismatches.some((m) => m.includes('DS_TOOLS')))
assert.ok(mismatch.mismatches.some((m) => m.includes('DS_STREAM_CONTENT')))
assert.ok(mismatch.mismatches.some((m) => m.includes('authReady')))
// 旧后端不自述 streamContent：不能因为它没有这个字段就误报不一致
assert.deepEqual(
  diffHealth({ ...HEALTH_OK, streamContent: undefined }, { streamContent: 'live' }).mismatches,
  [],
)
assert.ok(
  diffHealth({ ...HEALTH_OK, streamContent: 'live' }, { streamContent: 'live' }).mismatches.length === 0,
  '配置与后端自述一致时不该有任何告警',
)

{
  let healthHits = 0
  const srv = createServer((req, res) => {
    if (req.url === '/health') {
      healthHits++
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(HEALTH_OK))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const manager = createBackendManager({ baseUrl: `http://127.0.0.1:${srv.address().port}`, autoStart: false, healthTtlMs: 60000 }, loggerProbe)
  const first = await manager.ensure()
  assert.equal(first.version, HEALTH_OK.version)
  await manager.ensure()
  await manager.ensure()
  assert.equal(healthHits, 1, `13 步会话每次都探活的问题没解决：hits=${healthHits}`)
  manager.dispose()
  await new Promise((resolve) => srv.close(resolve))
  console.log('✅ /health 结果按 TTL 复用，探活次数 =', healthHits)
}

console.log('=== [10/18] 拉起策略：托管 pipes vs detach 解耦 ===')
assert.equal(isAlive(process.pid), true)
assert.equal(isAlive(0), false)
assert.equal(isAlive(-1), false)
assert.equal(isAlive('nope'), false)

// 托管：pipes（能 tail/落盘），dispose 时按进程树回收
const supervised = buildSpawnPlan({ serverDir: 'X:/srv' })
assert.deepEqual(supervised.stdio, ['ignore', 'pipe', 'pipe'])
assert.equal(supervised.detached, false)
assert.equal(supervised.cwd, 'X:/srv')

// detach 但不落日志：stdio 必须全 ignore，否则宿主退出时管道断裂会把后端 EPIPE 打死
const detachedQuiet = buildSpawnPlan({ serverDir: 'X:/srv', detach: true })
assert.deepEqual(detachedQuiet.stdio, ['ignore', 'ignore', 'ignore'])
assert.equal(detachedQuiet.detached, true)

// detach 且配了 logFile：直接把子进程 stdio 接到日志 fd 上
const detachedLogged = buildSpawnPlan({ serverDir: 'X:/srv', detach: true, logFile: 'X:/log.txt' }, { stdout: 7, stderr: 8 })
assert.deepEqual(detachedLogged.stdio, ['ignore', 7, 8])

console.log('=== [11/18] 进程树回收：孙进程必须一起带走 ===')
// 复现真机泄漏的形态：父进程再起一个孙进程（后端 -> headless Chrome 就是这个形状）。
// 旧的 child.kill() 只杀父，孙进程变孤儿继续占 CDP 端口。
const grandScript = 'const{spawn}=require("child_process");'
  + 'const kid=spawn(process.execPath,["-e","globalThis.x=setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true,detached:process.platform!=="win32"});'
  + 'console.log(kid.pid);globalThis.y=setInterval(()=>{},1000)'
const parent = spawn(process.execPath, ['-e', grandScript], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
let grandchildPid = 0
const waitPidLine = new Promise((resolve) => {
  parent.stdout.once('data', (buf) => resolve(Number(String(buf).split('\n')[0].trim())))
})
grandchildPid = await waitPidLine
assert.ok(grandchildPid > 0, '没拿到孙进程 PID')
await new Promise((r) => setTimeout(r, 300))
assert.equal(isAlive(parent.pid), true)
assert.equal(isAlive(grandchildPid), true, '孙进程没起来，测例无效')

const killed = killProcessTree(parent.pid, { force: true })
assert.equal(killed.method, process.platform === 'win32' ? 'taskkill' : 'process-group')
// 等它真的没了（Windows 上 taskkill 是同步的，但仍按结果断言而不是靠时序）
const deadline = Date.now() + 5000
while ((isAlive(parent.pid) || isAlive(grandchildPid)) && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 120))
}
assert.equal(isAlive(parent.pid), false, `父进程仍存活 PID=${parent.pid}`)
assert.equal(isAlive(grandchildPid), false, `孙进程成了孤儿 PID=${grandchildPid}`)
console.log(`✅ 进程树回收带走父子两代（父=${parent.pid} 孙=${grandchildPid}）`)

// 无效 PID / 已退出进程要幂等，不能抛
assert.equal(killProcessTree(0).ok, false)
assert.equal(killProcessTree('x').ok, false)
const ghost = spawn(process.execPath, ['-e', 'void 0'], { windowsHide: true })
await new Promise((r) => ghost.once('exit', r))
const ghostResult = killProcessTree(ghost.pid)
assert.equal(ghostResult.ok, true, `杀已退出的进程应幂等成功: ${ghostResult.detail}`)

console.log('=== [12/18] detach 才真解耦：托管后端会随拉起它的那个进程退出而被 EPIPE 带走 ===')
// 用一个会持续写 stdout 的桩"后端"复现真实形状（真后端 = node dist/index.js start + 心跳日志）。
// 托管模式 stdio 是管道：拉起者一退，管道断裂，桩进程因 EPIPE 自杀；detach 模式必须活下来。
const stubDir = mkdtempSync(join(tmpdir(), 'dwb-lifecycle-'))
mkdirSync(join(stubDir, 'dist'), { recursive: true })
writeFileSync(join(stubDir, 'dist', 'index.js'), [
  'import { createServer } from "node:http"',
  'const port = Number(process.env.PORT || 0)',
  'createServer((req, res) => {',
  '  res.writeHead(200, { "content-type": "application/json" })',
  '  res.end(JSON.stringify({ ok: true, version: "0.2.0-stub", toolReasoning: "clean", toolCalls: "text",',
  '    authReady: true, authAgeMs: 1, capabilities: ["dsml-tool-calls", "protocol-switches", "include-usage", "health-self-description"] }))',
  '}).listen(port, "127.0.0.1")',
  'setInterval(() => console.log("heartbeat " + Date.now()), 120)',
  '',
].join('\n'), 'utf8')

// ESM import 只认 file:// URL，Windows 盘符路径会直接 ERR_UNSUPPORTED_ESM_URL_SCHEME
const serverModule = pathToFileURL(fileURLToPath(new URL('../lib/server.js', import.meta.url))).href
const wrapperPath = join(stubDir, 'wrapper.mjs')
writeFileSync(wrapperPath, [
  'import { createBackendManager } from ' + JSON.stringify(serverModule),
  'const detach = process.argv[2] === "detach"',
  'const manager = createBackendManager({',
  '  baseUrl: "http://127.0.0.1:" + process.env.STUB_PORT,',
  '  serverDir: process.env.STUB_DIR,',
  '  autoStart: true, startTimeoutMs: 20000, healthTtlMs: 0, detach,',
  '}, null)',
  'const health = await manager.ensure()',
  'console.log("PID=" + manager.pid() + " HEALTH=" + (health && health.version))',
  'process.exit(0)',
  '',
].join('\n'), 'utf8')

async function freePort() {
  const srv = createServer()
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const port = srv.address().port
  await new Promise((resolve) => srv.close(resolve))
  return port
}

async function healthy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

function runWrapper(port, mode) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [wrapperPath, mode], {
      env: { ...process.env, STUB_PORT: String(port), STUB_DIR: stubDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let out = ''
    let err = ''
    proc.stdout.on('data', (b) => { out += String(b) })
    proc.stderr.on('data', (b) => { err += String(b) })
    proc.once('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`wrapper exit=${code} ${err}`))))
  })
}

// 任何一段断言失败都不能把桩进程留在机器上
const spawnedStubs = []
try {
  // A) detach：拉起者退出后桩后端必须还活着
  const portDetach = await freePort()
  const detachOut = await runWrapper(portDetach, 'detach')
  const detachPid = Number((detachOut.match(/PID=(\d+)/) || [])[1])
  spawnedStubs.push(detachPid)
  assert.ok(detachPid > 0, `没拿到 detach 后端的 PID: ${detachOut}`)
  assert.match(detachOut, /HEALTH=0\.2\.0-stub/)
  await new Promise((r) => setTimeout(r, 1200))
  assert.equal(await healthy(portDetach), true, 'detach 模式下后端随拉起者一起没了')
  killProcessTree(detachPid, { force: true })
  console.log('✅ detach：拉起者退出，后端 PID 仍存活并被显式回收')

  // B) 托管：拉起者退出后管道断裂，后端应当被 EPIPE 带走（这就是宿主退出=服务停的耦合语义）
  const portSupervised = await freePort()
  const supervisedOut = await runWrapper(portSupervised, 'supervised')
  const supervisedPid = Number((supervisedOut.match(/PID=(\d+)/) || [])[1])
  spawnedStubs.push(supervisedPid)
  assert.ok(supervisedPid > 0, `没拿到托管后端的 PID: ${supervisedOut}`)
  // 拉起者退出前它确实健康过（wrapper 里 ensure() 成功并回打了 version）；
  // 退出后立刻健康检查是没意义的——管道一断它就死，那正是本例要证明的耦合。
  assert.match(supervisedOut, /HEALTH=0\.2\.0-stub/)
  let died = false
  const stopAt = Date.now() + 8000
  while (Date.now() < stopAt) {
    if (!isAlive(supervisedPid) && !(await healthy(portSupervised))) { died = true; break }
    await new Promise((r) => setTimeout(r, 200))
  }
  assert.ok(died, '托管模式下后端没被 EPIPE 牵连——说明 stdio 选择逻辑变了，请同步 README 的耦合说明')
  console.log('✅ 托管：拉起者一退，后端随之退出（耦合语义与设计一致）')
} finally {
  for (const pid of spawnedStubs) {
    if (isAlive(pid)) killProcessTree(pid, { force: true })
  }
  try {
    rmSync(stubDir, { recursive: true, force: true })
  } catch {
    // 清不掉只是留下临时目录，不该让测试失败
  }
}

console.log('=== [13/18] 子进程环境变量白名单 ===')
const hostEnv = {
  PATH: 'C:\\Windows\\system32',
  SYSTEMROOT: 'C:\\Windows',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  USERPROFILE: 'C:\\Users\\me',
  TMP: 'C:\\Users\\me\\Temp',
  // 后端自己认的命名空间：必须放行
  DS_DEBUG: '1',
  DS_DATA_DIR: 'D:\\ds-data',
  DS_TOOL_REASONING: 'hidden',
  // 宿主的杂项：一律不许渗进子进程
  npm_config_registry: 'https://registry.example',
  VIRTUAL_ENV: 'E:\\venv',
  PYTHONPATH: 'E:\\py',
  CAMOFOX_PORT: '9334',
  DEEPSEEK_API_KEY: 'sk-should-not-leak',
  OTHER_DS_LIKE: 'nope',
  EMPTY: '',
  PORT: '9999',
  HOST: '0.0.0.0',
}
const built = buildChildEnv(hostEnv, {
  inject: { PORT: '8787', DS_TOOLS: 'text', DS_TOOL_REASONING: 'clean', DS_STREAM_CONTENT: 'live' },
})
assert.equal(built.env.PATH, hostEnv.PATH)
assert.equal(built.env.SYSTEMROOT, hostEnv.SYSTEMROOT)
assert.equal(built.env.DS_DEBUG, '1', 'DS_ 命名空间应当透传')
assert.equal(built.env.DS_DATA_DIR, 'D:\\ds-data')
assert.equal(built.env.DS_TOOL_REASONING, 'clean', '插件显式设定必须盖过宿主同名值')
assert.equal(built.env.PORT, '8787', '宿主的 PORT 会静默改掉后端监听端口，必须被覆盖')
assert.equal(built.env.DS_TOOLS, 'text')
assert.equal(built.env.DS_STREAM_CONTENT, 'live', '正文流式模式由插件配置决定，不能靠宿主的残留环境变量')
for (const leak of ['npm_config_registry', 'VIRTUAL_ENV', 'PYTHONPATH', 'CAMOFOX_PORT', 'DEEPSEEK_API_KEY', 'OTHER_DS_LIKE', 'EMPTY']) {
  assert.ok(!(leak in built.env), `${leak} 不该进子进程`)
}
assert.ok(!built.keys.some((k) => /npm_|PYTHON|VIRTUAL|CAMOFOX|DEEPSEEK/.test(k)), `白名单漏了: ${built.keys.join(',')}`)
assert.ok(built.keys.every((k) => ENV_BASE_ALLOWLIST.includes(k) || k.startsWith('DS_') || k === 'PORT'), '出现了未登记的放行项')
// 兜底口子：显式点名才透传
assert.equal(buildChildEnv({ WEIRD: 'v', OTHER: 'x' }, { extraKeys: ['WEIRD'] }).env.WEIRD, 'v')
assert.ok(!('OTHER' in buildChildEnv({ WEIRD: 'v', OTHER: 'x' }, { extraKeys: ['WEIRD'] }).env))

console.log('=== [14/18] API Key 解析优先级、mtime 缓存与缺失告警 ===')
// 让本段与宿主环境无关（DS_API_KEY 会参与优先级）
const savedDsKey = process.env.DS_API_KEY
delete process.env.DS_API_KEY
resetApiKeyCache()
try {
  const keyDir = mkdtempSync(join(tmpdir(), 'dwb-key-'))
  mkdirSync(join(keyDir, 'data'), { recursive: true })
  const keyFile = join(keyDir, 'data', '.api-key')
  const warns = []
  const keyLogger = { warn: (m) => warns.push(m) }

  // 1) 配置里的 apiKey 优先（并且做 trim）
  assert.equal(resolveApiKey({ apiKey: '  from-config  ' }, keyLogger), 'from-config')
  assert.equal(warns.length, 0)

  // 2) 环境变量其次
  process.env.DS_API_KEY = 'sk-from-env'
  assert.equal(resolveApiKey({ serverDir: keyDir }, keyLogger), 'sk-from-env')
  delete process.env.DS_API_KEY

  // 3) 文件解析，并按 mtime 缓存：mtime 不变就不重读盘。
  //    mtime 用 utimesSync 钉到整秒时间戳，避免文件系统亚毫秒精度让"相同 mtime"不可控。
  const stampA = new Date(Date.UTC(2021, 0, 1, 0, 0, 0))
  const stampB = new Date(Date.UTC(2021, 0, 1, 0, 1, 0))
  writeFileSync(keyFile, 'sk-first\n', 'utf8')
  utimesSync(keyFile, stampA, stampA)
  assert.equal(resolveApiKey({ serverDir: keyDir }, keyLogger), 'sk-first')
  writeFileSync(keyFile, 'sk-changed-but-same-mtime', 'utf8')
  utimesSync(keyFile, stampA, stampA)
  assert.equal(resolveApiKey({ serverDir: keyDir }, keyLogger), 'sk-first', '缓存没生效：mtime 未变却重读了盘')
  // mtime 前进一格，就必须看到新值
  utimesSync(keyFile, stampB, stampB)
  assert.equal(resolveApiKey({ serverDir: keyDir }, keyLogger), 'sk-changed-but-same-mtime')

  // 4) 文件缺失：给一次可操作告警，说一次就够，且绝不回显密钥
  resetApiKeyCache()
  warns.length = 0
  const emptyDir = mkdtempSync(join(tmpdir(), 'dwb-nokey-'))
  assert.equal(resolveApiKey({ serverDir: emptyDir }, keyLogger), '')
  assert.equal(resolveApiKey({ serverDir: emptyDir }, keyLogger), '')
  assert.equal(warns.length, 1, `缺失告警应当只说一次，实际 ${warns.length} 次`)
  assert.match(warns[0], /pnpm login/)
  assert.match(warns[0], /\.api-key/)
  assert.ok(!warns.some((w) => w.includes('sk-')), '告警里不得出现密钥内容')

  // 5) 空文件也走同一条告警，不静默
  resetApiKeyCache()
  warns.length = 0
  const blankDir = mkdtempSync(join(tmpdir(), 'dwb-blankkey-'))
  mkdirSync(join(blankDir, 'data'), { recursive: true })
  writeFileSync(join(blankDir, 'data', '.api-key'), '   ', 'utf8')
  assert.equal(resolveApiKey({ serverDir: blankDir }, keyLogger), '')
  assert.equal(warns.length, 1)

  for (const dir of [keyDir, emptyDir, blankDir]) rmSync(dir, { recursive: true, force: true })
  console.log('✅ 白名单只放行 OS 必需项与 DS_*；密钥按 mtime 缓存、缺失只说一次且不回显')
} finally {
  if (savedDsKey !== undefined) process.env.DS_API_KEY = savedDsKey
  resetApiKeyCache()
}

console.log('=== [15/18] 配置样板自检（守门员也要有人守）===')
// 正例：仓库里的样板必须无问题，且必需键齐全
const sampleText = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')
const sampleCheck = checkConfig(sampleText)
assert.deepEqual(sampleCheck.problems, [], `cordis.patch.yml 有问题:\n${sampleCheck.problems.join('\n')}`)
assert.equal(sampleCheck.keys.length, REQUIRED_KEYS.length)
for (const key of REQUIRED_KEYS) assert.ok(sampleCheck.keys.includes(key), `样板缺键 ${key}`)

// 反例：每一类错误都必须被抓住，否则这个守卫等于没有
const brokenTab = checkConfig('- insert:\n    - id: x\n\t  name: y\n')
assert.ok(brokenTab.problems.some((p) => p.includes('Tab')), 'Tab 缩进没被抓住')

const missingKeyText = sampleText.replace(/^\s*passEnvKeys:.*$/m, '')
assert.ok(
  checkConfig(missingKeyText).problems.some((p) => p.includes('passEnvKeys')),
  '缺键没被抓住（这正是一次整文件提交容易丢的东西）',
)

const noInsert = checkConfig('# 什么都没有\n')
assert.ok(noInsert.problems.some((p) => p.includes('insert')), '缺少 insert 入口没被抓住')
assert.ok(noInsert.problems.some((p) => p.includes(CONFIG_PROVIDER_ID)), '缺少 provider id 没被抓住')

// baseUrl 绑到非回环 = 把带登录态的反代暴露出去，必须红
const publicBind = checkConfig(sampleText.replace("'http://127.0.0.1:8787'", "'http://0.0.0.0:8787'"))
assert.ok(publicBind.problems.some((p) => p.includes('回环')), 'baseUrl 绑到 0.0.0.0 没被抓住')

// 开关取值非法会让反代启动即失败
const badEnum = checkConfig(sampleText.replace("toolReasoning: 'clean'", "toolReasoning: 'loud'"))
assert.ok(badEnum.problems.some((p) => p.includes('toolReasoning')), '非法 toolReasoning 没被抓住')

// 样板卫生：换机器即废的本机绝对路径、以及 serverDir/apiKey 这类机器相关键写成生效配置
assert.deepEqual(checkSampleHygiene(sampleText), [], '样板自己就不该可移植性不达标')
for (const line of [
  `serverDir: 'C:\\Users\\me\\git-repo\\deepseek-web-api'`,
  "logFile: '/home/me/.dsh/logs/a.log'",
  "apiKey: 'sk-secret'",
]) {
  assert.ok(checkSampleHygiene(line).length > 0, `本机相关内容没被拦住: ${line}`)
}
assert.deepEqual(checkSampleHygiene("logFile: '~/.dsh/logs/a.log'"), [], '~ 开头的路径不该被误拦')
assert.deepEqual(checkSampleHygiene('# serverDir: whatever'), [], '注释里的示例不该被误拦')
// 把注释里的 serverDir 变成生效配置，必须立刻红
assert.ok(checkSampleHygiene(sampleText.replace('# serverDir:', 'serverDir:')).length > 0, '生效的 serverDir 没被拦住')
console.log('✅ 配置自检：正例通过，Tab / 缺键 / 缺入口 / 公网绑定 / 非法枚举 / 本机绝对路径 全部被抓住')

console.log('=== [16/18] 后端目录与日志路径解析（可移植性）===')
{
  const root = mkdtempSync(join(tmpdir(), 'dwb-paths-'))
  const mkBackend = (rel) => {
    const dir = join(root, rel)
    mkdirSync(join(dir, 'dist'), { recursive: true })
    writeFileSync(join(dir, 'dist', 'index.js'), '// stub', 'utf8')
    return dir
  }
  const home = join(root, 'home')
  const configured = mkBackend('cfg/deepseek-web-api')
  const fromEnv = mkBackend('envside/deepseek-web-api')
  const discovered = mkBackend('home/DeepSeek_Harness/git-repo/deepseek-web-api')
  void discovered

  // 1) 配置优先
  const first = resolveServerDir({ serverDir: configured }, { home, env: {} })
  assert.equal(first.dir, configured)
  assert.equal(first.source, 'config')

  // 2) 配置指向的目录不可用时**不一票否决**：继续往下找，并把这件事记进 notes
  //    （换机器时"忘了改配置里的绝对路径"是常态，直接失败等于把可移植性锁回手改）
  const second = resolveServerDir(
    { serverDir: join(root, 'does-not-exist') },
    { home, env: { DSH_DEEPSEEK_WEB_API_DIR: fromEnv } },
  )
  assert.equal(second.dir, fromEnv)
  assert.equal(second.source, 'env:DSH_DEEPSEEK_WEB_API_DIR')
  assert.ok(second.notes.some((n) => n.includes('没有 dist/index.js')), '过期配置没有被记录')

  // 3) 指针文件（install.ps1 写的那个）
  const pointerFile = join(root, 'pointer.json')
  writePointer(pointerFile, configured, 'abc1234')
  const third = resolveServerDir({ pointerFile }, { home, env: {} })
  assert.equal(third.dir, configured)
  assert.equal(third.source, 'pointer')
  assert.ok(third.notes.some((n) => n.includes('abc1234')), '指针里的 git 版本没被带出来')
  const round = readPointer(pointerFile)
  assert.equal(round.serverDir, configured)
  assert.equal(round.gitRev, 'abc1234')

  // 4) 什么都没配 → 在 home 常见位置里发现
  //    注意 pointerFile 必须放在第一个参数里：它是 resolveServerDir 的配置项而不是 io 依赖，
  //    传错位置会回落到本机真实指针文件，测试就变成"恰好这台机器还没有指针"才通过。
  const fourth = resolveServerDir({ pointerFile: join(root, 'nope.json') }, { home, env: {} })
  assert.equal(fourth.dir, discovered)
  assert.equal(fourth.source, 'discover')

  // 5) 全都没有 → 空结果 + 把找过的位置说出来，并给出可操作报错
  const nothing = resolveServerDir(
    { serverDir: join(root, 'ghost'), pointerFile: join(root, 'none.json') },
    { home: join(root, 'empty-home'), env: {} },
  )
  assert.equal(nothing.dir, '')
  assert.equal(nothing.source, 'none')
  assert.ok(nothing.notes.some((n) => n.includes('已尝试')), '失败时没交代找过哪些位置')

  // 6) 路径展开：~ 走 home，绝对路径原样；空值表示不落盘
  assert.equal(expandHome('~/.dsh/logs/a.log', '/virtual/home'), join('/virtual/home', '.dsh/logs/a.log'))
  assert.equal(expandHome('', '/virtual/home'), '')
  assert.equal(resolveLogFile('~/x.log', '/virtual/home'), join('/virtual/home', 'x.log'))
  assert.equal(resolveLogFile('', '/virtual/home'), '')

  // 7) 不是 git 仓库的目录不该抛
  assert.equal(readGitRev(root), null)
  assert.equal(readGitRev(''), null)

  // 8) 指针里的 gitRev 过期时要能被识别出来（install.ps1 命中指针分支后靠它回写）
  //    真实事故：命中指针时脚本从不回写，指针停在 7b1eacf，而排查文档教人拿这个值判断
  //    "是不是在跑旧构建"——过期基准会把新构建冤枉成旧构建。
  assert.equal(shouldRefreshPointer('7b1eacf', '168c46e'), true, '过期指针没被识别出来')
  assert.equal(shouldRefreshPointer('168c46e', '168c46e'), false, '一致时不该改写指针')
  assert.equal(shouldRefreshPointer(null, '168c46e'), true, '指针没记版本时要补记')
  assert.equal(shouldRefreshPointer('168c46e', null), false, '读不到实际版本就动指针等于把证据擦掉')
  assert.equal(shouldRefreshPointer('', ''), false)
  const stalePointerFile = join(root, 'stale-pointer.json')
  writePointer(stalePointerFile, configured, '7b1eacf')
  assert.equal(readPointer(stalePointerFile).gitRev, '7b1eacf')
  writePointer(stalePointerFile, configured, '168c46e')
  const refreshed = readPointer(stalePointerFile)
  assert.equal(refreshed.gitRev, '168c46e', '回写后指针仍是旧版本')
  assert.equal(refreshed.serverDir, configured, '回写把后端目录写坏了')

  rmSync(root, { recursive: true, force: true })
  console.log('✅ 解析顺序：配置 → env → 指针 → 发现；过期配置只记录不否决；过期指针能被识别')
}

console.log('=== [17/18] 后端能力契约：旧构建拒绝复用而不是静默退化 ===')
{
  const full = {
    ok: true,
    version: '0.2.0',
    toolReasoning: 'clean',
    toolCalls: 'text',
    authReady: true,
    capabilities: ['dsml-tool-calls', 'protocol-switches', 'include-usage', 'health-self-description'],
  }
  assert.equal(checkContract(full).ok, true)
  assert.equal(checkContract({ ...full, capabilities: ['protocol-switches'] }).ok, false)
  assert.ok(
    checkContract({ ...full, capabilities: ['protocol-switches'] }).problems.some((p) => p.includes('dsml-tool-calls')),
    '缺失能力没被点名',
  )
  // 旧构建连 capabilities 都不自述：判为不可信，并给出 pnpm build 的下一步
  const legacy = checkContract({ ok: true, version: '0.1.0' })
  assert.equal(legacy.unknown, true)
  assert.equal(legacy.ok, false)
  assert.ok(legacy.problems.join(' ').includes('pnpm build'), '报错没给出下一步动作')
  // 版本比较：只在能力清单可信时才参与判断
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0)
  assert.equal(compareVersions('0.1.9', '0.2.0'), -1)
  assert.equal(compareVersions('0.2.1', '0.2.0'), 1)
  assert.equal(compareVersions('weird', '0.2.0'), null)
  assert.ok(checkContract({ ...full, version: '0.1.0' }).problems.some((p) => p.includes('低于')))
  // 自定义依赖清单（例如只要协议开关）要能被尊重
  assert.equal(checkContract(full, { requiredCapabilities: ['protocol-switches'], minBackendVersion: '' }).ok, true)

  // 真接一次：/health 没有 capabilities 的后端
  async function ensureAgainst(health, opts) {
    const srv = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(health))
        return
      }
      res.writeHead(404).end()
    })
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
    const manager = createBackendManager({
      baseUrl: `http://127.0.0.1:${srv.address().port}`,
      autoStart: false,
      healthTtlMs: 0,
      ...opts,
    }, { info() {}, warn() {}, debug() {} })
    try {
      return { ok: true, health: await manager.ensure() }
    } catch (error) {
      return { ok: false, error }
    } finally {
      await new Promise((resolve) => srv.close(resolve))
    }
  }

  const refused = await ensureAgainst({ ok: true, version: '0.1.0' }, {})
  assert.equal(refused.ok, false, '旧后端竟然通过了契约校验')
  assert.equal(refused.error.failureCode, 'BACKEND_STALE')
  assert.match(refused.error.message, /能力契约/)

  const tolerated = await ensureAgainst({ ok: true, version: '0.1.0' }, { strictBackend: false })
  assert.equal(tolerated.ok, true, 'strictBackend=false 时应放行（只告警）')

  const accepted = await ensureAgainst(full, {})
  assert.equal(accepted.ok, true)
  console.log('✅ 契约不满足 → BACKEND_STALE（不可重试）；strictBackend=false 可降级为告警')
}

console.log('=== [18/18] 配置活读：改配置不必重启客户端 ===')
{
  // 用同一个适配器实例，中途改配置对象，验证下一轮请求取到新值。
  const live = { baseUrl: 'http://127.0.0.1:9', autoStart: false, defaultMaxTokens: 8192, maxContextWindow: 1000 }
  let disposed = 0
  const fakeManager = {
    ensure: async () => HEALTH_OK,
    dispose: () => { disposed += 1 },
    serverDir: () => '',
    health: () => HEALTH_OK,
  }
  const liveAdapter = new DeepSeekWebApiAdapter(() => live, fakeManager, null)

  const first = await liveAdapter.resolveModel(PROVIDER_ID, 'deepseek-web-thinking')
  assert.equal(first.defaultMaxTokens, 8192)
  live.defaultMaxTokens = 4321
  live.maxContextWindow = 222
  const second = await liveAdapter.resolveModel(PROVIDER_ID, 'deepseek-web-thinking')
  assert.equal(second.defaultMaxTokens, 4321, '请求侧配置没有活读到新值')
  assert.equal(second.context.contextWindow, 222)
  assert.equal(disposed, 0, '只改请求侧配置不该重建后端管理器')

  // 改到影响后端进程的项（baseUrl）→ 旧管理器必须被回收，新的才建起来
  const managerBefore = liveAdapter.ensureManager()
  live.baseUrl = 'http://127.0.0.1:8787'
  const managerAfter = liveAdapter.ensureManager()
  assert.equal(disposed, 1, '后端相关配置变更后没有回收旧管理器')
  assert.notEqual(managerBefore, managerAfter, '没有建出新的后端管理器')

  // 代际隔离：prepareCall 之后就算配置变了，本轮请求仍用当时那一代
  const boundCfg = { autoStart: false, apiKey: 'k', maxContextWindow: 1000 }
  const boundManager = {
    ensure: async () => HEALTH_OK,
    dispose: () => {},
    serverDir: () => '',
  }
  let sawUrl = ''
  const spyServer = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(HEALTH_OK))
      return
    }
    const body = []
    req.on('data', (b) => body.push(b))
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"用当代配置完成"}}]}\n\n')
      res.write('data: {"choices":[{"finish_reason":"stop"}]}\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise((resolve) => spyServer.listen(0, '127.0.0.1', resolve))
  const boundUrl = `http://127.0.0.1:${spyServer.address().port}`
  try {
    const boundAdapter = new DeepSeekWebApiAdapter(() => ({ ...boundCfg, baseUrl: boundUrl }), boundManager, null)
    const prepared = await boundAdapter.prepareCall(PROVIDER_ID, 'deepseek-web-thinking')
    // 本轮准备完之后，配置源被改成死地址：本轮 stream 必须仍然走准备时那一代
    const original = boundAdapter.stream.bind(boundAdapter)
    boundAdapter.stream = (model, options, opts, manager) => {
      sawUrl = (opts || {}).baseUrl
      return original(model, options, opts, manager)
    }
    const out = []
    for await (const chunk of prepared.stream({ messages: [{ role: 'user', content: 'x' }] })) out.push(chunk)
    assert.equal(sawUrl, boundUrl, '本轮请求没有用上准备时那一代的配置')
    assert.equal(out.find((c) => c.type === 'finish').reason.kind, 'stop')
    assert.ok(out.some((c) => c.type === 'text-delta'))
  } finally {
    await new Promise((resolve) => spyServer.close(resolve))
  }

  // apply() 之后 dispose 事件要能回收懒建的管理器
  const applied = apply({
    llm: { registerAdapter: () => () => {}, registerConfigurableProviders: () => {} },
    logger: { info() {}, warn() {}, debug() {} },
    on: () => {},
  }, { baseUrl: 'http://127.0.0.1:9', autoStart: false })
  assert.ok(applied && typeof applied.dispose === 'function', 'apply 未返回适配器句柄')
  applied.ensureManager()
  assert.ok(applied._manager, '管理器未按需创建')
  applied.dispose()
  assert.equal(applied._manager, null, 'dispose 后仍留着管理器')
  console.log('✅ 配置按当代取用、后端相关变更重建管理器、卸载能回收')
}

// 触发 dispose
fakeCtx.events.dispose?.()

console.log('✅ 全部 Smoke 单元测试通过！')
