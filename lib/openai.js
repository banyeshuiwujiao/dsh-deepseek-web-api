/**
 * DSH 词汇与 OpenAI Chat Completions 词汇之间的纯函数转换。
 * 全部无副作用、可单测；流式编排在 provider.js 里。
 *
 * @module lib/openai.js
 */

import { imageDataUrlPart, isImageBlock } from './attachments.js'

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
 * 抽出消息里的纯文本与图片 block，并报告被丢弃的 block 类型。
 * 网页反代现已支持图片输入（2026-10-21 spike 实测）：image block 由 formatOpenAiMessages
 * 异步转成 image_url part 上传给反代；仍无法转发的 block（未知类型）显式告警。
 */
export function collectText(content) {
  if (typeof content === 'string') return { text: content.trim(), skipped: [], images: [] }
  if (!Array.isArray(content)) return { text: '', skipped: [], images: [] }
  const parts = []
  const skipped = []
  const images = []
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
    if (isImageBlock(block)) {
      // 图片交给异步层读盘转换；这里只登记，不做失败判定（失败在异步层回落占位符）。
      images.push(block)
      continue
    }
    // 带上可定位信息（文件名/attachment id/尺寸）：只报"丢了个 image"等于让模型去猜，
    // 而猜的代价在真实事故里是几个小时的重试。
    const detail = [
      block?.attachment?.name,
      block?.attachment?.attachmentId,
      typeof block?.file_path === 'string' ? block.file_path : '',
      block?.source?.url,
      block?.width && block?.height ? `${block.width}x${block.height}` : '',
    ].filter(Boolean).join(' ')
    const label = detail ? `${type}(${detail})` : type
    if (!skipped.includes(label)) skipped.push(label)
  }
  return { text: parts.join('\n').trim(), skipped, images }
}


/** The kernel replaces images with a text placeholder before the plugin ever sees a block, so the only
 *  way to know how many pictures were dropped is to count that sentence. */
export function countImageOmissions(text) {
  if (typeof text !== 'string' || text === '') return 0
  return (text.match(/image omitted/g) || []).length
}

/**
 * What a text-only model should do after an image was omitted. Without this line its default move is to
 * retry the reading tool forever; in one real six-hour run it instead rebuilt the same device code over
 * and over. Wording is fixed so logs and tests can line up against it.
 */
export function imageOmissionHint(count) {
  if (!(count > 0)) return ''
  return `[no-image-input] 本轮有 ${count} 处图片被内核以文字占位符省略；本模型无图像输入，重试读图不会改变结果。`
    + '要让用户看到这张图：把文件路径写进正文或用 present 类工具发送文件。'
    + '要图中内容：换不依赖视觉的来源（页面 DOM、接口返回的文本；二维码里真正有用的那段通常就是它编码的 URL），'
    + '实在没有再请用户用文字描述。'
}

/** 兼容旧签名：只要文本。 */
export function textOf(content) {
  return collectText(content).text
}

/**
 * DSH 消息历史 → OpenAI messages。
 * system/developer 角色一律透传（旧实现只认 options.system，历史里的 system 会被静默丢掉）；
 * 未知角色告警后跳过，不再无声吞掉。
 *
 * 图片 block（内核声明 image 后原样传下）在这里读盘转成 image_url data URL；
 * 读不到/超限/类型不符时回落为占位符文本并告警——行为退化到 PR-C 之前，不会更坏。
 *
 * @param {{ system?: string, messages?: unknown[] }} options
 * @param {(message: string) => void} [warn]
 * @param {{ io?: object }} [ctx] attachments 读取的测试注入点
 * @returns {Promise<Array<object>>}
 */
export async function formatOpenAiMessages(options, warn, ctx = {}) {
  const messages = []
  const system = typeof options?.system === 'string' ? options.system.trim() : ''
  if (system !== '') messages.push({ role: 'system', content: system })

  const list = Array.isArray(options?.messages) ? options.messages : []
  let callSeq = 0
  for (const msg of list) {
    const role = String(msg?.role || '')
    const collected = collectText(msg?.content)
    let text = collected.text
    if (collected.skipped.length > 0) {
      warn?.(`消息中的 ${collected.skipped.join('/')} 内容无法经网页反代转发，已丢弃（仅支持纯文本）`)
    }
    // 图片 block → image_url part；失败的图回落占位符文本并计入 hint。
    const imageUrlParts = []
    for (const block of collected.images) {
      const part = await imageDataUrlPart(block, ctx.io)
      if (part) {
        imageUrlParts.push(part)
        continue
      }
      const name = typeof block?.attachment?.name === 'string' ? block.attachment.name : ''
      const id = typeof block?.attachment?.attachmentId === 'string' ? block.attachment.attachmentId : ''
      const label = [name, id].filter(Boolean).join(' ') || 'image'
      warn?.(`图片 ${label} 未能读取（对象缺失/超限/类型不符），已以占位符转发`)
      text = [text, imageOmissionHint(1)].filter(Boolean).join('\n\n')
    }
    // 两条路都要管：block 形态（我们自己丢的）与内核占位符形态（到插件时已经是文字）。
    const omitted = countImageOmissions(text)
    if (omitted > 0) text = [text, imageOmissionHint(omitted)].filter(Boolean).join("\n\n")

    // OpenAI 允许 content 为数组（text + image_url 混排）；纯文本消息保持字符串形态不变。
    const hasImages = imageUrlParts.length > 0
    const content = hasImages ? [{ type: 'text', text }, ...imageUrlParts] : text

    if (role === 'system' || role === 'developer') {
      if (text !== '') messages.push({ role: 'system', content })
      continue
    }
    if (role === 'user') {
      messages.push({ role: 'user', content })
      continue
    }
    if (role === 'assistant') {
      const item = { role: 'assistant', content }
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
