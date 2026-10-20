/**
 * DSH 词汇与 OpenAI Chat Completions 词汇之间的纯函数转换。
 * 全部无副作用、可单测；流式编排在 provider.js 里。
 *
 * @module lib/openai.js
 */

/**
 * 未解析的工具协议残留：反代正常时会把 DSML 与文本协议都转成结构化 tool_calls，
 * 出现这些标记说明这一回合并没有真正产出调用，必须当可重试错误而不是正常回答。
 */
const PROTOCOL_LEAK = new RegExp(
  [
    '\uFF5C{1,2}\\s*DSML', // DeepSeek 网页原生标记协议残留
    '<\\s*/?\\s*(?:tool[_-]?call|_call)\\b', // 反代文档化的文本协议
    '<\\s*/?\\s*(?:calls|invoke)\\b[^>]*\\bname\\s*=', // 带 name 属性的调用标记
  ].join('|'),
  'i',
)

/** 上游/反代用来表达"上下文超长"的常见措辞。 */
const CONTEXT_OVERFLOW = /context[\s_-]?(?:length|window)[\s_-]?(?:exceed|overflow|limit)|(?:prompt|input|messages?)\s+(?:is\s+|are\s+)?too\s+(?:large|long)|maximum context/i

/** 判断正文是否残留未解析的工具协议文本。 */
export function hasProtocolLeak(text) {
  return typeof text === 'string' && text !== '' && PROTOCOL_LEAK.test(text)
}

/**
 * 估算 token 数：CJK 按 1 字符 1 token，其余按 4 字符 1 token。
 * 上游网页端从不报输入 token，插件只能估；原先一律除以 3，中文场景低报约 3 倍。
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text === '') return 0
  let wide = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef)) {
      wide += 1
    }
  }
  return Math.ceil(wide + (text.length - wide) / 4)
}

/** 按真正上线的载荷估算输入 token（system + 历史 + 工具 schema 都算进去）。 */
export function estimateInputTokens(messages, tools) {
  const payload = JSON.stringify({ messages: Array.isArray(messages) ? messages : [], tools: tools ?? [] })
  return estimateTokens(payload)
}

/**
 * 抽出消息里的纯文本，并报告被丢弃的 block 类型。
 * 网页反代只支持文本输入，图片等 block 无法转发，必须显式告警而不是静默变空串。
 */
export function collectText(content) {
  if (typeof content === 'string') return { text: content.trim(), skipped: [] }
  if (!Array.isArray(content)) return { text: '', skipped: [] }
  const parts = []
  const skipped = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    const type = typeof block?.type === 'string' ? block.type : 'unknown'
    if (type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
      continue
    }
    if (!skipped.includes(type)) skipped.push(type)
  }
  return { text: parts.join('\n').trim(), skipped }
}

/** 兼容旧签名：只要文本。 */
export function textOf(content) {
  return collectText(content).text
}

/**
 * DSH 消息历史 → OpenAI messages。
 * system/developer 角色一律透传（旧实现只认 options.system，历史里的 system 会被静默丢掉）；
 * 未知角色告警后跳过，不再无声吞掉。
 * @param {{ system?: string, messages?: unknown[] }} options
 * @param {(message: string) => void} [warn]
 */
export function formatOpenAiMessages(options, warn) {
  const messages = []
  const system = typeof options?.system === 'string' ? options.system.trim() : ''
  if (system !== '') messages.push({ role: 'system', content: system })

  const list = Array.isArray(options?.messages) ? options.messages : []
  let callSeq = 0
  for (const msg of list) {
    const role = String(msg?.role || '')
    const { text, skipped } = collectText(msg?.content)
    if (skipped.length > 0) {
      warn?.(`消息中的 ${skipped.join('/')} 内容无法经网页反代转发，已丢弃（仅支持纯文本）`)
    }

    if (role === 'system' || role === 'developer') {
      if (text !== '') messages.push({ role: 'system', content: text })
      continue
    }
    if (role === 'user') {
      messages.push({ role: 'user', content: text })
      continue
    }
    if (role === 'assistant') {
      const item = { role: 'assistant', content: text }
      const calls = Array.isArray(msg?.toolCalls) ? msg.toolCalls : []
      if (calls.length > 0) {
        item.tool_calls = calls.map((tc) => {
          callSeq += 1
          const id = typeof tc?.id === 'string' && tc.id !== '' ? tc.id : `call_dsh_${callSeq}`
          return {
            id,
            type: 'function',
            function: {
              name: String(tc?.name || ''),
              arguments: typeof tc?.arguments === 'string' ? tc.arguments : JSON.stringify(tc?.arguments ?? {}),
            },
          }
        })
      }
      messages.push(item)
      continue
    }
    if (role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: String(msg?.toolCallId || msg?.id || 'call_0'),
        content: text,
      })
      continue
    }
    warn?.(`未知消息角色 "${role || '(空)'}" 已跳过`)
  }
  return messages
}

/** 描述裁剪：默认 0 = 不裁剪（反代会把定义原样注入提示词，砍掉的就是模型看不到的部分）。 */
export function clampDescription(text, maxChars) {
  const max = Number(maxChars)
  if (!Number.isFinite(max) || max <= 0 || text.length <= max) return text
  return `${text.slice(0, max)}…`
}

/** DSH tools → OpenAI function tools。 */
export function formatOpenAiTools(tools, maxDescriptionChars = 0) {
  const list = Array.isArray(tools) ? tools : []
  if (list.length === 0) return undefined
  return list.map((t) => ({
    type: 'function',
    function: {
      name: String(t?.name || ''),
      description: clampDescription(String(t?.description || ''), maxDescriptionChars),
      parameters: t?.parameters || { type: 'object', properties: {} },
    },
  }))
}

/**
 * HTTP 状态码 → 内核的稳定错误码词汇（与 llm-pi-ai 适配器一致）：
 * AUTH(401/403)、QUOTA(402)、RATE_LIMIT(429)、CONTEXT_WINDOW_EXCEEDED、INVALID_REQUEST(400/413/422)、
 * SERVER(5xx)、其余 HTTP_<status>。只有可重试码才该进 retryableCodes。
 */
export function failureCodeForStatus(status, detail = '') {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 402) return 'QUOTA'
  if (status === 429) return 'RATE_LIMIT'
  if (CONTEXT_OVERFLOW.test(detail)) return 'CONTEXT_WINDOW_EXCEEDED'
  if (status === 400 || status === 413 || status === 422) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/** 解析 Retry-After（秒数或 HTTP 日期）为毫秒，拿不到就 undefined。 */
export function retryAfterMs(headerValue) {
  const raw = typeof headerValue === 'string' ? headerValue.trim() : ''
  if (raw === '') return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000))
  const at = Date.parse(raw)
  if (Number.isFinite(at)) return Math.max(0, at - Date.now())
  return undefined
}

/** 从错误响应体里尽量取出人类可读的 message。 */
export function describeErrorBody(status, rawBody) {
  const text = typeof rawBody === 'string' ? rawBody.trim() : ''
  let message = `HTTP ${status}${text ? `: ${text}` : ''}`
  try {
    const parsed = JSON.parse(text)
    const candidate = parsed?.error?.message ?? parsed?.message
    if (typeof candidate === 'string' && candidate !== '') message = candidate
  } catch {
    // 非 JSON 响应体，沿用状态行
  }
  return { message, detail: text }
}
