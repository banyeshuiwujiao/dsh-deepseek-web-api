import assert from 'node:assert/strict'
import {
  PROVIDER_ID,
  PROVIDER_LABEL,
  KNOWN_MODELS,
  DeepSeekWebApiAdapter,
  apply,
  formatOpenAiMessages,
  formatOpenAiTools,
  textOf,
} from '../lib/provider.js'

console.log('=== [1/4] 验证基础格式化与工具转换 ===')
assert.equal(textOf('hello'), 'hello')
assert.equal(textOf([{ type: 'text', text: 'part 1' }, { type: 'text', text: 'part 2' }]), 'part 1\npart 2')

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
assert.equal(formattedMsgs[3].tool_call_id, 'tc1')

const formattedTools = formatOpenAiTools([
  { name: 'pwsh', description: '执行 PowerShell\n第二行', parameters: { type: 'object' } },
])
assert.equal(formattedTools.length, 1)
assert.equal(formattedTools[0].function.name, 'pwsh')
assert.equal(formattedTools[0].function.description, '执行 PowerShell')

console.log('=== [2/4] 验证 Provider 契约与 Cordis apply 注册 ===')
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

console.log('=== [3/4] 验证模型列表与 resolveModel / prepareCall ===')
const models = await adapter.listModels(PROVIDER_ID)
assert.ok(models.length >= 2, '模型列表数量不足')
assert.ok(models.some((m) => m.id === 'deepseek-web-flash'))
assert.ok(models.some((m) => m.id === 'deepseek-web-thinking'))

const resolved = await adapter.resolveModel(PROVIDER_ID, 'deepseek-web-flash')
assert.equal(resolved.id, 'deepseek-web-flash')
assert.equal(resolved.provider, PROVIDER_ID)
assert.ok(resolved.context?.contextWindow > 0)

const prepared = await adapter.prepareCall(PROVIDER_ID, 'deepseek-web-flash')
assert.equal(prepared.model.id, 'deepseek-web-flash')
assert.equal(typeof prepared.stream, 'function')

console.log('=== [4/4] 验证 SSE 增量转换到 DSH StreamChunk (Mock Server) ===')
// 构造一个模拟的 mock server 测试流式输出与 reasoning-delta
import { createServer } from 'node:http'

const mockSseLines = [
  'data: {"choices":[{"delta":{"reasoning_content":"思考中..."}}]}\n\n',
  'data: {"choices":[{"delta":{"reasoning_content":"完成思考。"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"你好！"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"我是 DeepSeek。"}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}\n\n',
  'data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":25}}\n\n',
  'data: [DONE]\n\n',
]

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }
  if (req.url === '/v1/chat/completions') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    for (const line of mockSseLines) {
      res.write(line)
    }
    res.end()
    return
  }
  res.writeHead(404).end()
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

try {
  const mockAdapter = new DeepSeekWebApiAdapter({
    baseUrl: `http://127.0.0.1:${port}`,
    autoStart: false,
  })

  const chunks = []
  for await (const chunk of mockAdapter.stream('deepseek-v4-pro', {
    messages: [{ role: 'user', content: '测试' }],
  })) {
    chunks.push(chunk)
  }

  const chunkTypes = chunks.map((c) => c.type)
  console.log('收到 Chunks 类型序列:', chunkTypes.join(' -> '))

  assert.ok(chunkTypes.includes('block-start'))
  assert.ok(chunkTypes.includes('reasoning-delta'))
  assert.ok(chunkTypes.includes('text-delta'))
  assert.ok(chunkTypes.includes('tool-call-delta'))
  assert.ok(chunkTypes.includes('block-end'))
  assert.ok(chunkTypes.includes('usage'))
  assert.ok(chunkTypes.includes('finish'))

  const reasoningChunk = chunks.find((c) => c.type === 'reasoning-delta')
  assert.equal(reasoningChunk.text, '思考中...')

  const textChunk = chunks.find((c) => c.type === 'text-delta')
  assert.equal(textChunk.text, '你好！')

  const toolCallChunk = chunks.find((c) => c.type === 'tool-call-delta')
  assert.equal(toolCallChunk.name, 'read_file')
  assert.equal(toolCallChunk.argumentsDelta, '{"path":"a.txt"}')

  const finishChunk = chunks.find((c) => c.type === 'finish')
  assert.equal(finishChunk.reason.kind, 'tool-calls')

  console.log('✅ 流式增量协议（Reasoning + Content + ToolCalls）全部校验通过！')
} finally {
  await new Promise((resolve) => server.close(resolve))
}

// 触发 dispose
fakeCtx.events.dispose?.()
console.log('✅ 全部 Smoke 单元测试通过！')
