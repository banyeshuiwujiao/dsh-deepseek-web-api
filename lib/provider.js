// dsh-deepseek-web-api —— 把 deepseek-web-api 网页私有 API 反代接入 DSH 模型选择器。
//
// 架构说明（参考 dsh-eagent/README.md 与 cordis.patch.yml 契约）：
//   1. 模型选择器的数据源 = ctx.llm.listProviders() × listModels()；
//   2. 插件注册为 provider 路由（使用 ctx.llm.registerAdapter），不注册为工具；
//   3. 支持自动检测/拉起 git-repo/deepseek-web-api 后端服务，并自动读取 data/.api-key；
//   4. 与真实网页版深度对齐：
//      - deepseek-web-flash：极速模式（显式传入 thinking_enabled: false，秒回纯文本）
//      - deepseek-web-thinking：深度思考模式（显式传入 thinking_enabled: true，生成完整思维链）
//   5. 完整实现 OpenAI Chat Completions SSE 增量到 DSH StreamChunk 规范的流式映射：
//      支持 reasoning-delta（深度思考过程）、text-delta（正文）与 tool-call-delta（原生工具调用）。

import { createBackendManager, resolveApiKey } from './server.js'

export const name = 'dsh-deepseek-web-api-provider'
export const inject = ['llm']

/** provider 路由 id（模型选择器中展示的分组）。 */
export const PROVIDER_ID = 'deepseek-web-api'
export const PROVIDER_LABEL = 'DeepSeek Web API (反代)'

export const KNOWN_MODELS = [
  {
    id: 'deepseek-web-flash',
    name: 'DeepSeek 网页版 · 极速模式',
    description: '通过网页私有 API 调用的 DeepSeek 极速模式（关闭深度思考，低延迟响应）',
    thinking: false,
  },
  {
    id: 'deepseek-web-thinking',
    name: 'DeepSeek 网页版 · 深度思考',
    description: '通过网页私有 API 调用的 DeepSeek 深度思考模式（开启深度思考，输出完整思维链）',
    thinking: true,
  },
]

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:8787',
  apiKey: '',
  serverDir: 'C:\\Users\\Admin\\DeepSeek_Harness\\git-repo\\deepseek-web-api',
  autoStart: true,
  startTimeoutMs: 60000,
  maxContextWindow: 128000,
  defaultMaxTokens: 8192,
  nodePath: '',
  // 后端反代的工具相关开关：clean 让 DSH 拿到实时深度思考增量，text 是最稳的工具协议形态。
  toolReasoning: 'clean',
  tools: 'text',
}

/**
 * 兜底检测：反代已支持把 DeepSeek 网页模型的 DSML 标签工具调用解析成结构化 tool_calls，
 * 但若上游吐出新的协议形态，未解析的协议文本会作为正文返回，DSH 会把这个回合误判为“已完成”。
 * 这里识别残留协议标记，把它当作可重试错误，而不是静默结束回合。
 */
const PROTOCOL_LEAK = new RegExp(
  [
    '\uFF5C{1,2}\\s*DSML', // DeepSeek 网页原生标记协议残留
    '<\\s*/?\\s*(?:tool[_-]?call|_call)\\b', // 反代文档化的文本协议
    '<\\s*/?\\s*(?:calls|invoke)\\b[^>]*\\bname\\s*=', // 带 name 属性的调用标记
  ].join('|'),
  'i',
)

/** 判断正文是否残留未解析的工具协议文本。 */
export function hasProtocolLeak(text) {
  return typeof text === 'string' && text !== '' && PROTOCOL_LEAK.test(text)
}

/** 把 message.content（字符串或 block 数组）提取为纯文本。 */
export function textOf(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const out = []
  for (const block of content) {
    if (typeof block === 'string') {
      out.push(block)
      continue
    }
    if (block?.type === 'text' && typeof block.text === 'string') {
      out.push(block.text)
    }
  }
  return out.join('\n').trim()
}

/** 把 DSH 消息历史转成 OpenAI Chat Completions 消息格式。 */
export function formatOpenAiMessages(options) {
  const messages = []
  if (typeof options?.system === 'string' && options.system.trim() !== '') {
    messages.push({ role: 'system', content: options.system.trim() })
  }

  const list = Array.isArray(options?.messages) ? options.messages : []
  for (const msg of list) {
    const role = String(msg?.role || '')
    const content = textOf(msg?.content)

    if (role === 'user') {
      messages.push({ role: 'user', content })
    } else if (role === 'assistant') {
      const item = { role: 'assistant', content: content || '' }
      if (Array.isArray(msg?.toolCalls) && msg.toolCalls.length > 0) {
        item.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id || `call_${Date.now()}`,
          type: 'function',
          function: {
            name: tc.name,
            arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
          },
        }))
      }
      messages.push(item)
    } else if (role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: msg?.toolCallId || msg?.id || 'call_0',
        content: content,
      })
    }
  }
  return messages
}

/** 把 DSH tools 转成 OpenAI function tools 格式。 */
export function formatOpenAiTools(tools) {
  const list = Array.isArray(tools) ? tools : []
  if (list.length === 0) return undefined
  return list.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: String(t.description || '').split('\n')[0],
      parameters: t.parameters || { type: 'object', properties: {} },
    },
  }))
}

/** LlmAdapter 实现。 */
export class DeepSeekWebApiAdapter {
  constructor(opts = {}, manager = null) {
    this.opts = { ...DEFAULTS, ...opts }
    this.manager = manager || createBackendManager(this.opts)
  }

  providerInfo(provider) {
    return { id: provider, name: PROVIDER_LABEL }
  }

  providerRetryPolicy() {
    return {
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: ['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'PROTOCOL_LEAK'],
      initialDelayMs: 1500,
      maxDelayMs: 5000,
      jitterRatio: 0.2,
    }
  }

  async listModels(provider) {
    return KNOWN_MODELS.map((m) => ({
      provider,
      id: m.id,
      name: m.name,
      description: m.description,
      inputModalities: ['text'],
    }))
  }

  async resolveModel(provider, model) {
    const matched = KNOWN_MODELS.find((m) => m.id === model)
    const name = matched ? matched.name : `${model} · 网页反代`
    return {
      provider,
      id: model,
      name,
      description: matched ? matched.description : '通过 deepseek-web-api 驱动的网页版 DeepSeek 模型',
      inputModalities: ['text'],
      context: { contextWindow: this.opts.maxContextWindow },
      defaultMaxTokens: this.opts.defaultMaxTokens,
    }
  }

  /**
   * 客户端 dsh-llm 适配器必需接口：prepareCall(provider, model, signal)
   * 返回 { model, stream: (options) => ... }
   */
  async prepareCall(provider, model, signal) {
    if (signal?.aborted === true) throw new Error('deepseek-web-api: request aborted')
    return {
      model: await this.resolveModel(provider, model),
      stream: (options) => this.stream(model, options),
    }
  }

  /**
   * 流式生成核心逻辑：
   * 将 DSH 的调用转发给 deepseek-web-api 的 POST /v1/chat/completions (SSE)，
   * 并将 SSE 增量转换为 DSH StreamChunk 规范（reasoning-delta / text-delta / tool-call-delta / usage / finish）。
   */
  async * stream(model, options) {
    const signal = options?.signal
    if (signal?.aborted === true) {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'request aborted', code: 'ABORTED' } } }
      return
    }

    // 确保本地反代服务处于运行状态
    try {
      await this.manager.ensure()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      yield { type: 'finish', reason: { kind: 'error', failure: { message, code: 'TRANSPORT' } } }
      return
    }

    // 核心对齐：依据选择的模型显式决定 thinking_enabled，避免反代服务默认强制开思考
    const isThinking = model === 'deepseek-web-thinking' ||
      model.includes('pro') ||
      model.includes('reasoner')

    const messages = formatOpenAiMessages(options)
    const tools = formatOpenAiTools(options?.tools)
    const body = {
      model: 'deepseek-chat',
      messages,
      stream: true,
      thinking_enabled: isThinking,
      reasoning_enabled: isThinking,
      reasoning: { effort: isThinking ? 'medium' : 'none' },
      ...(tools ? { tools } : {}),
    }

    const apiKey = resolveApiKey(this.opts)
    const headers = {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    }

    let response
    try {
      response = await fetch(`${this.opts.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const aborted = signal?.aborted === true
      yield {
        type: 'finish',
        reason: aborted
          ? { kind: 'aborted', failure: { message, code: 'ABORTED' } }
          : { kind: 'error', failure: { message, code: 'TRANSPORT' } },
      }
      return
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      let errorMsg = `HTTP ${response.status}: ${errText}`
      try {
        const parsed = JSON.parse(errText)
        if (parsed?.error?.message) errorMsg = parsed.error.message
      } catch {}
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: `deepseek-web-api 错误: ${errorMsg}`, code: 'SERVER' } },
      }
      return
    }

    // 逐行解析 SSE 响应
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let blockIndex = 0
    let currentBlockType = null // 'reasoning' | 'text' | null
    let reasoningText = ''
    let contentText = ''
    let hasToolCalls = false
    let finishReason = 'stop'

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith(':')) continue
          if (trimmed === 'data: [DONE]') {
            break
          }
          if (!trimmed.startsWith('data:')) continue

          const jsonStr = trimmed.slice(5).trim()
          let chunkData
          try {
            chunkData = JSON.parse(jsonStr)
          } catch {
            continue
          }

          if (chunkData?.error) {
            throw new Error(chunkData.error.message || 'Stream error')
          }

          const choice = chunkData?.choices?.[0]
          const delta = choice?.delta

          // 1) 深度思考增量（reasoning_content）
          if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content !== '') {
            if (currentBlockType !== 'reasoning') {
              if (currentBlockType === 'text') {
                yield { type: 'block-end', index: blockIndex, block: { type: 'text', text: contentText } }
                blockIndex++
              }
              yield { type: 'block-start', index: blockIndex, blockType: 'reasoning' }
              currentBlockType = 'reasoning'
            }
            reasoningText += delta.reasoning_content
            yield { type: 'reasoning-delta', index: blockIndex, text: delta.reasoning_content }
          }

          // 2) 正文增量（content）
          if (typeof delta?.content === 'string' && delta.content !== '') {
            if (currentBlockType === 'reasoning') {
              yield { type: 'block-end', index: blockIndex, block: { type: 'reasoning', text: reasoningText } }
              blockIndex++
              currentBlockType = null
            }
            if (currentBlockType !== 'text') {
              yield { type: 'block-start', index: blockIndex, blockType: 'text' }
              currentBlockType = 'text'
            }
            contentText += delta.content
            yield { type: 'text-delta', index: blockIndex, text: delta.content }
          }

          // 3) 工具调用增量（tool_calls）
          if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
            hasToolCalls = true
            if (currentBlockType) {
              const blkType = currentBlockType
              const textVal = blkType === 'reasoning' ? reasoningText : contentText
              yield { type: 'block-end', index: blockIndex, block: { type: blkType, text: textVal } }
              blockIndex++
              currentBlockType = null
            }

            for (const tc of delta.tool_calls) {
              const tcIndex = blockIndex++
              const tcId = tc.id || `call_${Date.now().toString(36)}`
              const tcName = tc.function?.name || ''
              const tcArgs = tc.function?.arguments || ''

              yield { type: 'block-start', index: tcIndex, blockType: 'tool-call' }
              yield {
                type: 'tool-call-delta',
                index: tcIndex,
                id: tcId,
                name: tcName,
                argumentsDelta: tcArgs,
              }
              yield {
                type: 'block-end',
                index: tcIndex,
                block: { type: 'tool-call', id: tcId, name: tcName, arguments: tcArgs },
              }
            }
          }

          if (choice?.finish_reason) {
            finishReason = choice.finish_reason
          }

          if (chunkData?.usage) {
            yield {
              type: 'usage',
              usage: {
                inputTokens: chunkData.usage.prompt_tokens ?? 0,
                outputTokens: chunkData.usage.completion_tokens ?? 0,
              },
            }
          }
        }
      }

      // 收尾最后一个打开的 block
      if (currentBlockType) {
        const textVal = currentBlockType === 'reasoning' ? reasoningText : contentText
        yield { type: 'block-end', index: blockIndex, block: { type: currentBlockType, text: textVal } }
        currentBlockType = null
      }

      // 估算 Token 兜底（若接口未回传 usage）
      yield {
        type: 'usage',
        usage: {
          inputTokens: Math.ceil((options?.messages ? JSON.stringify(options.messages).length : 10) / 3),
          outputTokens: Math.ceil((contentText.length + reasoningText.length) / 3),
        },
      }

      // 兜底：正文里仍有未解析的工具协议标记，说明这一回合并没有真正产出工具调用。
      // 报可重试错误，避免 DSH 把原始协议文本当成正常回答并把回合判定为“已完成”。
      if (!hasToolCalls && finishReason !== 'tool_calls' && hasProtocolLeak(contentText)) {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              message:
                'deepseek-web-api 返回了未解析的工具协议文本（DSML/tool_call 标记），已作为可重试错误上报。' +
                ` 片段：${contentText.slice(0, 120)}`,
              code: 'PROTOCOL_LEAK',
            },
          },
        }
        return
      }

      yield {
        type: 'finish',
        reason: { kind: hasToolCalls || finishReason === 'tool_calls' ? 'tool-calls' : 'stop' },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message, code: 'TRANSPORT' } },
      }
    }
  }
}

/** 宿主插件入口：注册 provider 路由 + 可配置 provider 条目。 */
export function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {}
  const opts = { ...DEFAULTS, ...cfg }
  const manager = createBackendManager(opts, ctx.logger)
  const adapter = new DeepSeekWebApiAdapter(opts, manager)

  const registration = ctx.llm.registerAdapter([PROVIDER_ID], adapter)

  ctx.llm.registerConfigurableProviders?.([
    {
      provider: PROVIDER_ID,
      displayName: PROVIDER_LABEL,
      settingsNs: 'deepseek-web-api',
      settingsPath: ['providers', PROVIDER_ID],
    },
  ])

  ctx.on?.('dispose', () => {
    try {
      if (typeof registration === 'function') registration()
    } catch {
      /* ignore */
    }
    manager.dispose()
  })
}

export { DEFAULTS }
