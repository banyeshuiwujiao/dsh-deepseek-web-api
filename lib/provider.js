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
//
// 分工：本文件只负责流式编排与 DSH 块协议；纯函数转换在 lib/openai.js，
// 内核归因头在 lib/kernel.js，后端进程托管在 lib/server.js。

import { resolveAttributionHeaders } from './kernel.js'
import {
  clampDescription,
  collectText,
  countImageOmissions,
  describeErrorBody,
  estimateInputTokens,
  estimateTokens,
  failureCodeForStatus,
  formatOpenAiMessages,
  formatOpenAiTools,
  hasProtocolLeak,
  imageOmissionHint,
  retryAfterMs,
  textOf,
} from './openai.js'
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
  // 后端目录不再写死绝对路径：解析顺序为 配置 serverDir → 环境变量
  // DSH_DEEPSEEK_WEB_API_DIR → ~/.dsh/deepseek-web-api.json 指针（install.ps1 写）
  // → 插件同级（源码形态）→ home 下常见位置。详见 lib/paths.js。
  serverDir: '',
  pointerFile: '',
  autoStart: true,
  startTimeoutMs: 60000,
  maxContextWindow: 128000,
  // 注意：网页端上游不接受 max_tokens，这个值不会真的限制输出，它只是向 DSH 申报
  // "单轮最多可能吐多少 token"（内核 reservedCompletionTokens 会按它预留上下文水位）。
  // 实测单轮可产出 6 万字符（约 2 万 token）以上，原先写 8192 会让压缩决策过于乐观。
  defaultMaxTokens: 32768,
  nodePath: '',
  // 后端反代的工具相关开关：clean 让 DSH 拿到实时深度思考增量，text 是最稳的工具协议形态。
  toolReasoning: 'clean',
  tools: 'text',
  // buffered = 工具回合正文等解析完一次下发（默认，最保真）；live = 正文走闸门实时出字。
  streamContent: 'buffered',
  // 0 = 不裁剪工具描述（默认）。反代会把工具定义原样注入提示词，裁剪等于让模型看不到。
  toolDescriptionMaxChars: 0,
  // /health 结果缓存，避免 13 步会话里每步都探活一次；0 = 每次都探活。
  healthTtlMs: 30000,
  // 上游连续多少毫秒不吐字节就按 TIMEOUT 中止（可重试）；0 = 不设空闲超时。
  streamIdleTimeoutMs: 120000,
  // 设置后把后端子进程输出落到该文件（超过 2MB 轮转一份 .1），便于事后取证。
  logFile: '',
  // true：后端独立存活，插件退出/卸载都不动它。托管模式的 stdio 是管道，宿主一退管道断裂，
  // 后端会因为 EPIPE 自己死掉——对 DSH 是正确的，对一次性脚本是误伤。
  detach: false,
  // 托管模式下 dispose 是否连带回收后端的子进程（headless Chrome）。false 只杀直接子进程。
  killTreeOnDispose: true,
  // 需要透传给后端的额外环境变量**名**（值仍从本进程环境取）。
  // 反代自己认的 DS_* 与 OS 必需项已经默认放行，一般不需要动这里。
  passEnvKeys: [],
  // 能力契约：后端 /health 必须自述这些能力，否则拒绝复用（旧 dist 会静默退回
  // "协议文本当正文、回合判为已完成"那个原始故障）。默认清单见 lib/contract.js。
  requiredCapabilities: [],
  minBackendVersion: '',
  // true：能力不足直接报错停止；false：只告警继续用（明知后端旧还想跑，就这里关）。
  strictBackend: true,
}

/** 是否开启深度思考：优先查模型表，未知模型才回退到名字猜测。 */
export function resolveThinkingEnabled(model) {
  const known = KNOWN_MODELS.find((m) => m.id === model)
  if (known) return known.thinking === true
  return /(?:^|[^a-z])(?:pro|reasoner|thinking)(?:[^a-z]|$)/i.test(String(model))
}

/**
 * 影响后端进程与探活的配置项：只有这些变了才需要重建 manager（重建意味着杀掉旧子进程，
 * 纯请求侧的取值变化不该付这个代价）。
 */
const MANAGER_KEYS = [
  'baseUrl', 'serverDir', 'pointerFile', 'nodePath', 'autoStart', 'startTimeoutMs',
  'probeTimeoutMs', 'healthTtlMs', 'toolReasoning', 'tools', 'streamContent', 'logFile', 'detach',
  'killTreeOnDispose', 'passEnvKeys', 'env', 'strictBackend', 'requiredCapabilities', 'minBackendVersion',
]

function managerKeyOf(opts) {
  return MANAGER_KEYS.map((key) => `${key}=${JSON.stringify(opts[key] ?? '')}`).join('\u0000')
}

/**
 * 申报给内核的整数配置必须真是正整数：内核用 `Number.isInteger(...) && > 0` 校验，
 * 不合规抛 `INVALID_MODEL_CONTEXT`，把这一轮以及需要模型路由校验的工具（read_image 等）一起打死。
 * 字符串在 YAML/控制台里太容易写出来（`maxContextWindow: "128000"`），所以宁可回落默认值并留一条
 * 指名道姓的告警，也不要让异常往外冒——往外冒会被理解成"这个模型不支持图"。
 */
export function positiveIntOption(raw, key, fallback, warn) {
  const value = Number(raw)
  if (Number.isInteger(value) && value > 0) return value
  warn?.(`配置里的 ${key} 不是正整数（收到 ${JSON.stringify(raw)}），已回落到 ${fallback}；`
    + '这个值会被内核严格校验，留着非法值会让每一轮 prepareCall 直接失败')
  return fallback
}

/** LlmAdapter 实现。配置按调用时读取，不是一次性快照。 */
export class DeepSeekWebApiAdapter {
  /**
   * @param {object | (() => object)} source 配置对象，或返回配置的函数
   *   （宿主把配置写成活对象时，传函数就能直接拿到最新值）
   * @param {object | null} manager 预置的后端管理器（测试用）
   * @param {object | null} logger 宿主日志
   */
  constructor(source = {}, manager = null, logger = null) {
    this.source = source
    this.logger = logger || (source && source.logger) || null
    this._manager = manager
    this._managerKey = manager ? managerKeyOf(this._read()) : ''
    this.generation = 0
    this.opts = this._read()
  }

  _read() {
    const raw = typeof this.source === 'function' ? this.source() : this.source
    return { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  }

  /**
   * 取当代配置；管理器相关字段变了就回收旧管理器（它只杀自己拉起的子进程）。
   * @returns {object}
   */
  current() {
    const opts = this._read()
    const key = managerKeyOf(opts)
    if (this._manager && key !== this._managerKey) {
      try {
        this._manager.dispose()
      } catch {
        // 旧管理器已经坏了也不能挡住新配置生效
      }
      this._manager = null
      this.warn('配置里与后端进程相关的项已变更，重建后端管理器')
    }
    if (!this._manager) this._manager = createBackendManager(opts, this.logger)
    this._managerKey = key
    this.opts = opts
    return opts
  }

  /** 取当代配置并确保管理器存在。 */
  ensureManager() {
    this.current()
    return this._manager
  }

  /**
   * 释放后端管理器。只回收**自己拉起**的子进程；
   * detach 模式或复用别人起的实例时不会动它们。
   */
  dispose() {
    try {
      this._manager?.dispose()
    } catch {
      // 已经坏掉的管理器不该让卸载失败
    }
    this._manager = null
    this._managerKey = ''
  }

  providerInfo(provider) {
    return { id: provider, name: PROVIDER_LABEL }
  }

  /**
   * 只把"重试有意义"的码列进来：AUTH/QUOTA/INVALID_REQUEST/CONTEXT_WINDOW_EXCEEDED
   * 每次都会以同样方式失败，重试只是白等退避。PROTOCOL_LEAK 是本插件自带的兜底码。
   */
  providerRetryPolicy() {
    return {
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'PROTOCOL_LEAK'],
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

  async resolveModel(provider, model, opts = this.current()) {
    const matched = KNOWN_MODELS.find((m) => m.id === model)
    const name = matched ? matched.name : `${model} · 网页反代`
    // 内核逐字校验 `Number.isInteger(context.contextWindow) && context.contextWindow > 0`，
    // 不合规就抛 INVALID_MODEL_CONTEXT —— 那不只是这一轮失败，连需要走模型路由校验的工具
    // （如 read_image）都会在几毫秒内死掉，看起来像"这个模型不能看图"。
    // YAML/控制台里写 `maxContextWindow: "128000"` 完全合法，所以这里必须自己收口。
    const contextWindow = positiveIntOption(opts.maxContextWindow, 'maxContextWindow', DEFAULTS.maxContextWindow, (message) => this.warn(message))
    const defaultMaxTokens = positiveIntOption(opts.defaultMaxTokens, 'defaultMaxTokens', DEFAULTS.defaultMaxTokens, (message) => this.warn(message))
    return {
      provider,
      id: model,
      name,
      description: matched ? matched.description : '通过 deepseek-web-api 驱动的网页版 DeepSeek 模型（只接受纯文本输入，无图像输入）',
      inputModalities: ['text'],
      context: { contextWindow },
      ...(defaultMaxTokens > 0 ? { defaultMaxTokens } : {}),
    }
  }

  /**
   * 客户端 dsh-llm 适配器必需接口：prepareCall(provider, model, signal)
   * 返回 { model, stream: (options) => ... }
   *
   * 这里是配置的取用点：每轮请求开始时读一次当代配置并记世代，
   * 把 stream 绑到这一代上——内核文档明确要求动态适配器不能让"准备时的元数据"
   * 和"派发时的配置"跨代混用。
   */
  async prepareCall(provider, model, signal) {
    if (signal?.aborted === true) throw new Error('deepseek-web-api: request aborted')
    const opts = this.current()
    const manager = this._manager
    this.generation += 1
    return {
      model: await this.resolveModel(provider, model, opts),
      stream: (options) => this.stream(model, options, opts, manager),
    }
  }

  /** 统一告警出口：没有 logger 时退回 console，保证问题不会静默。 */
  warn(message) {
    const text = `deepseek-web-api: ${message}`
    if (typeof this.logger?.warn === 'function') this.logger.warn(text)
    else console.warn(text)
  }

  /**
   * 流式生成核心逻辑：
   * 将 DSH 的调用转发给 deepseek-web-api 的 POST /v1/chat/completions (SSE)，
   * 并将 SSE 增量转换为 DSH StreamChunk 规范（reasoning-delta / text-delta / tool-call-delta / usage / finish）。
   */
  async * stream(model, options, boundOpts, boundManager) {
    // 配置与管理器都按"当代"传入；没传（直接调用/测试）时才现取。
    const opts = boundOpts || this.current()
    const manager = boundManager || this.ensureManager()
    const signal = options?.signal
    if (signal?.aborted === true) {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'request aborted', code: 'ABORTED' } } }
      return
    }

    // 确保本地反代服务处于运行状态（并按能力契约把关）
    try {
      await manager.ensure()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // BACKEND_STALE 一类的判定不是瞬态故障：重试只会在同一个旧后端上再撞一次。
      const code = typeof error?.failureCode === 'string' && error.failureCode !== '' ? error.failureCode : 'TRANSPORT'
      yield { type: 'finish', reason: { kind: 'error', failure: { message, code } } }
      return
    }

    const isThinking = resolveThinkingEnabled(model)
    const messages = formatOpenAiMessages(options, (message) => this.warn(message))
    const tools = formatOpenAiTools(options?.tools, opts.toolDescriptionMaxChars)
    // 协议残留兜底只在"本轮带了工具"时才有意义：没有工具表时模型写出协议样式文本是正常内容。
    const requestHasTools = Array.isArray(tools) && tools.length > 0
    const requestedMaxTokens = Number(options?.maxTokens)
    const body = {
      model: 'deepseek-chat',
      messages,
      stream: true,
      // 反代据此在最后一个 chunk 上挂真实 usage；拿不到时插件才用估算兜底。
      stream_options: { include_usage: true },
      thinking_enabled: isThinking,
      reasoning_enabled: isThinking,
      reasoning: { effort: isThinking ? 'medium' : 'none' },
      ...(tools ? { tools } : {}),
      // 上游不强制这个上限（docs/api.md 已说明），透传只为让反代能记录/诊断调用方意图。
      ...(Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0 ? { max_tokens: requestedMaxTokens } : {}),
    }

    const apiKey = resolveApiKey(opts, this.logger ? { warn: (m) => this.warn(m) } : null, manager.serverDir?.() || '')
    const attribution = await resolveAttributionHeaders(this.logger)
    const headers = {
      ...attribution,
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    }

    let response
    try {
      response = await fetch(`${opts.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      yield { type: 'finish', reason: this.transportFailure(error, signal) }
      return
    }

    if (!response.ok) {
      const rawBody = await response.text().catch(() => '')
      const { message, detail } = describeErrorBody(response.status, rawBody)
      const code = failureCodeForStatus(response.status, detail)
      const retryAfter = retryAfterMs(response.headers?.get?.('retry-after'))
      if (code === 'AUTH') this.warn('反代拒绝了 API Key（401/403）；检查 data/.api-key 或配置里的 apiKey')
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: `deepseek-web-api 错误: ${message}`,
            code,
            status: response.status,
            ...(retryAfter === undefined ? {} : { providerRetryAfterMs: retryAfter }),
          },
        },
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
    let sawUsage = false
    let upstreamPromptTokens = 0
    let upstreamCompletionTokens = 0
    /** 反代最终 chunk 上的解析结论（旧后端没有该字段时为 null）。 */
    let turnDiagnostics = null
    let done = false
    /** 按 OpenAI 的 `index` 累积工具调用分片，收尾时整块下发。 */
    const pendingCalls = new Map()
    const startedAt = Date.now()
    let firstDeltaAt = 0
    let conversation = ''

    // 出错、提前 return 时也要把已打开的 block 收尾，否则宿主会渲染一个不闭合的气泡。
    const closeOpenBlock = () => {
      if (!currentBlockType) return null
      const type = currentBlockType
      const text = type === 'reasoning' ? reasoningText : contentText
      const chunk = { type: 'block-end', index: blockIndex, block: { type, text } }
      blockIndex++
      currentBlockType = null
      return chunk
    }

    // 上游卡死时不能永久挂着：连续 streamIdleTimeoutMs 没有任何字节就按 TIMEOUT 中止（该码可重试）。
    const idleMs = Number(opts.streamIdleTimeoutMs)
    const readNext = () => {
      if (!Number.isFinite(idleMs) || idleMs <= 0) return reader.read()
      let timer = null
      const idle = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error(`deepseek-web-api 流空闲超过 ${idleMs}ms 没有数据`), { failureCode: 'TIMEOUT' }))
        }, idleMs)
      })
      return Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer))
    }

    // 工具调用块统一在收尾时下发：正文/推理先闭合，再逐个给出完整参数。
    function* emitPendingCalls() {
      let seq = 0
      for (const slot of pendingCalls.values()) {
        seq += 1
        const index = blockIndex++
        const id = slot.id || `call_dsh_${Date.now().toString(36)}_${seq}`
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id, name: slot.name, argumentsDelta: slot.args }
        yield { type: 'block-end', index, block: { type: 'tool-call', id, name: slot.name, arguments: slot.args } }
      }
    }

    /** 每轮一行统计：这类失败过去是静默的，有 ttft 与通道长度才能事后复盘。 */
    const logTurn = (outcome, extra = {}) => {
      const fields = [
        `model=${model}`,
        `ms=${Date.now() - startedAt}`,
        `ttft=${firstDeltaAt === 0 ? 'none' : `${firstDeltaAt - startedAt}ms`}`,
        `reasonChars=${reasoningText.length}`,
        `contentChars=${contentText.length}`,
        `toolCalls=${pendingCalls.size}`,
        `usage=${sawUsage ? `${upstreamPromptTokens}/${upstreamCompletionTokens}` : 'estimated'}`,
        // 后端没带诊断字段（旧 dist）时明确写 unknown，而不是留空让读日志的人以为解析过。
        `protocolShape=${turnDiagnostics?.protocolShape ?? 'unknown'}`,
        `protocolTruncated=${turnDiagnostics?.protocolTruncated ?? 'unknown'}`,
        `conversation=${conversation || 'none'}`,
        `outcome=${outcome}`,
      ]
      for (const [key, value] of Object.entries(extra)) fields.push(`${key}=${value}`)
      const line = `deepseek-web-api: ${fields.join(' ')}`
      if (outcome === 'stop' || outcome === 'tool-calls') {
        if (typeof this.logger?.debug === 'function') this.logger.debug(line)
      } else if (typeof this.logger?.warn === 'function') {
        this.logger.warn(line)
      }
    }

    try {
      while (!done) {
        const read = await readNext()
        if (read.done) break
        if (signal?.aborted === true) break

        buffer += decoder.decode(read.value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith(':')) continue
          if (trimmed === 'data: [DONE]') {
            done = true
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
            const detail = typeof chunkData.error.message === 'string' ? chunkData.error.message : ''
            const status = Number(chunkData.error.status ?? chunkData.error.code ?? 0)
            const code = Number.isInteger(status) && status >= 400
              ? failureCodeForStatus(status, detail)
              : 'TRANSPORT'
            throw Object.assign(new Error(detail || 'Stream error'), { failureCode: code, failureStatus: status || undefined })
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
            if (firstDeltaAt === 0) firstDeltaAt = Date.now()
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
            if (firstDeltaAt === 0) firstDeltaAt = Date.now()
            yield { type: 'text-delta', index: blockIndex, text: delta.content }
          }

          // 3) 工具调用增量（tool_calls）：按 index 累积，收尾时整块下发。
          //    反代目前在单个 chunk 里给完整数组；若上游改成标准分片（同 index 多次追加 arguments），
          //    旧实现会产出 N 个各自残缺的调用块。
          if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
            hasToolCalls = true
            for (const tc of delta.tool_calls) {
              const key = Number.isInteger(tc?.index) ? tc.index : pendingCalls.size
              const slot = pendingCalls.get(key) || { id: '', name: '', args: '' }
              if (typeof tc?.id === 'string' && tc.id !== '') slot.id = tc.id
              if (typeof tc?.function?.name === 'string') slot.name += tc.function.name
              if (typeof tc?.function?.arguments === 'string') slot.args += tc.function.arguments
              pendingCalls.set(key, slot)
            }
          }

          if (choice?.finish_reason) {
            finishReason = choice.finish_reason
          }

          if (typeof chunkData?.conversation === 'string' && chunkData.conversation !== '') {
            conversation = chunkData.conversation
          }

          // usage 只记录不立即下发：内核会把多个 usage 块相加，重复发就是重复计费。
          if (chunkData?.usage && typeof chunkData.usage === 'object') {
            sawUsage = true
            upstreamPromptTokens = Number(chunkData.usage.prompt_tokens) || 0
            upstreamCompletionTokens = Number(chunkData.usage.completion_tokens ?? chunkData.usage.total_tokens) || 0
          }

          // 反代在最后一个 chunk 上带解析结论；留着它是为了"这轮为什么没调工具"能一行回答。
          if (chunkData?.diagnostics && typeof chunkData.diagnostics === 'object') {
            turnDiagnostics = chunkData.diagnostics
          }
        }
      }

      // 收尾最后一个打开的 block
      const closing = closeOpenBlock()
      if (closing) yield closing
      yield* emitPendingCalls()

      // Token 口径：输出优先用上游真实计数；输入上游永远不报（prompt_tokens=0），
      // 所以按真正上线的载荷（system + 历史 + 工具 schema）估算，绝不发 0 让宿主误判水位。
      const outputTokens = sawUsage && upstreamCompletionTokens > 0
        ? upstreamCompletionTokens
        : estimateTokens(contentText) + estimateTokens(reasoningText)
      const inputTokens = sawUsage && upstreamPromptTokens > 0
        ? upstreamPromptTokens
        : estimateInputTokens(messages, tools)
      yield { type: 'usage', usage: { inputTokens, outputTokens } }

      // 兜底一：正文里仍有未解析的工具协议标记，说明这一回合并没有真正产出工具调用。
      // 报可重试错误，避免 DSH 把原始协议文本当成正常回答并把回合判定为"已完成"。
      //
      // 只在"本轮确实带了工具"时判定：纯文本回合（例如会话标题请求）里出现 <calls>、
      // <parameter value=1> 这类字样是合法内容（用户就可能让模型讲协议或写这类代码），
      // 当错误报会白烧两轮重试，还会把正常答案藏掉。
      const leakWhere = hasProtocolLeak(contentText)
        ? 'content'
        : (contentText.trim() === '' && hasProtocolLeak(reasoningText) ? 'reasoning' : '')
      if (requestHasTools && !hasToolCalls && finishReason !== 'tool_calls' && leakWhere !== '') {
        const sample = (leakWhere === 'content' ? contentText : reasoningText).slice(0, 120)
        logTurn('PROTOCOL_LEAK', { leakChannel: leakWhere })
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              message:
                'deepseek-web-api 返回了未解析的工具协议文本（DSML/tool_call 标记），已作为可重试错误上报。' +
                `通道=${leakWhere}，后端判定=${turnDiagnostics?.protocolShape ?? 'unknown'}，` +
                `片段：${sample}`,
              code: 'PROTOCOL_LEAK',
            },
          },
        }
        return
      }

      // 兜底二：整轮什么都没产出（无正文、无思考、无调用）。这正是最初那个 bug 的形态：
      // 静默 stop 会让 DSH 把回合判成 completed。交给内核按 EMPTY_RESPONSE 重试。
      if (!hasToolCalls && contentText.trim() === '' && reasoningText.trim() === '') {
        logTurn('EMPTY_RESPONSE')
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { message: 'deepseek-web-api 这一轮没有产出任何内容', code: 'EMPTY_RESPONSE' },
          },
        }
        return
      }

      const outcome = hasToolCalls || finishReason === 'tool_calls' ? 'tool-calls' : 'stop'
      logTurn(outcome)
      yield {
        type: 'finish',
        reason: { kind: outcome },
      }
    } catch (error) {
      const closing = closeOpenBlock()
      if (closing) yield closing
      const reason = this.transportFailure(error, signal)
      logTurn(reason.kind === 'aborted' ? 'aborted' : reason.failure.code)
      yield { type: 'finish', reason }
    } finally {
      try {
        await reader.cancel()
      } catch {
        // 流可能已经结束，忽略
      }
    }
  }

  /** 传输层失败归一：用户中止必须是 ABORTED（不可重试），不能被当成 TRANSPORT 再重试两轮。 */
  transportFailure(error, signal) {
    const message = error instanceof Error ? error.message : String(error)
    if (signal?.aborted === true || error?.name === 'AbortError') {
      return { kind: 'aborted', failure: { message: message || 'request aborted', code: 'ABORTED' } }
    }
    const code = typeof error?.failureCode === 'string' && error.failureCode !== '' ? error.failureCode : 'TRANSPORT'
    const status = Number.isInteger(error?.failureStatus) ? error.failureStatus : undefined
    const isIdle = /timeout|timed out|idle/i.test(message)
    return {
      kind: 'error',
      failure: {
        message,
        code: code === 'TRANSPORT' && isIdle ? 'TIMEOUT' : code,
        ...(status === undefined ? {} : { status }),
      },
    }
  }
}

/** 宿主插件入口：注册 provider 路由 + 可配置 provider 条目。 */
export function apply(ctx, config) {
  const logger = ctx?.logger || null
  // 把配置当"活源"传给适配器：宿主若原地更新这个对象，下一轮请求就取到新值；
  // 宿主若改成重新装配插件（再跑一次 apply），也会得到一个新的适配器代际。
  const source = () => (config && typeof config === 'object' ? config : {})
  const adapter = new DeepSeekWebApiAdapter(source, null, logger)

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
    adapter.dispose()
  })

  return adapter
}

// 纯函数仍从入口再导出一遍，兼容既有的 import 路径与 smoke 用例。
export {
  clampDescription,
  collectText,
  countImageOmissions,
  describeErrorBody,
  estimateInputTokens,
  estimateTokens,
  failureCodeForStatus,
  formatOpenAiMessages,
  formatOpenAiTools,
  hasProtocolLeak,
  imageOmissionHint,
  retryAfterMs,
  textOf,
}
export { DEFAULTS }
