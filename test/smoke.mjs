import assert from 'node:assert/strict'
import { createServer } from 'node:http'
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

console.log('=== [1/7] 基础格式化：文本抽取与工具转换 ===')
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

console.log('=== [2/7] Token 估算与错误码归一 ===')
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

console.log('=== [3/7] Provider 契约与 Cordis apply 注册 ===')
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

console.log('=== [4/7] 模型列表与 resolveModel / prepareCall ===')
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

console.log('=== [5/7] SSE 增量 → DSH StreamChunk（Mock Server）===')

/** 起一个 mock 反代：记录上线请求，按给定 SSE 行回放。 */
async function withMockServer(lines, run, options = {}) {
  const seen = { headers: null, body: null }
  const srv = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
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

console.log('=== [6/7] 兜底：协议残留 / 空回合 / 状态码 / 中止 ===')
const BAR = String.fromCharCode(0xff5c)
const LEAK = `${BAR}${BAR}DSML${BAR}${BAR}`

const leaked = await withMockServer(
  [
    'data: {"choices":[{"delta":{"content":"我先建目录。\\n<' + LEAK + ' invoke name=\\"pwsh\\">"}}]}\n\n',
    'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ],
  { messages: [{ role: 'user', content: '测试' }] },
)
const leakFinish = leaked.chunks.find((c) => c.type === 'finish')
assert.equal(leakFinish.reason.kind, 'error')
assert.equal(leakFinish.reason.failure.code, 'PROTOCOL_LEAK')
console.log('✅ 残留协议文本被识别为可重试错误:', leakFinish.reason.failure.code)

const clean = await withMockServer(
  [
    'data: {"choices":[{"delta":{"content":"示例代码里写成 <parameter value=1> 或 calls 数组都算正常正文。"}}]}\n\n',
    'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ],
  { messages: [{ role: 'user', content: '测试' }] },
)
assert.equal(clean.chunks.find((c) => c.type === 'finish').reason.kind, 'stop')
assert.ok(clean.chunks.some((c) => c.type === 'text-delta'))
console.log('✅ 正常正文仍按 stop 结束')

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

console.log('=== [7/7] 后端不可用时的错误口径 ===')
const offline = new DeepSeekWebApiAdapter({ baseUrl: 'http://127.0.0.1:1', autoStart: false })
const offlineChunks = []
for await (const chunk of offline.stream('deepseek-web-flash', { messages: [{ role: 'user', content: 'x' }] })) {
  offlineChunks.push(chunk)
}
const offlineFinish = offlineChunks.find((c) => c.type === 'finish')
assert.equal(offlineFinish.reason.kind, 'error')
assert.ok(['TRANSPORT', 'SERVER'].includes(offlineFinish.reason.failure.code))
console.log('✅ 后端不可达:', offlineFinish.reason.failure.code)

// 触发 dispose
fakeCtx.events.dispose?.()

console.log('✅ 全部 Smoke 单元测试通过！')
