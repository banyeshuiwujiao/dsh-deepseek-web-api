/**
 * 内核接缝：本插件唯一允许 import `@deepseek-ai/*` 的地方。
 *
 * 适配器契约要求"每个 provider HTTP 请求都带上 attributionHeaders()"。这个包由安装环境提供，
 * 插件不能锁内核版本，所以这里惰性 import：模块缺失或形状不对时退化成字面量，
 * 保证归因信息始终存在。与 dsh-our-free-model/adapter/kernel.js 同一套做法。
 *
 * @module lib/kernel.js
 */

/** 内核 helper 不可用时的兜底归因头。 */
const FALLBACK_HEADERS = Object.freeze({
  'user-agent': 'deepseek-harness/0.1.7 (+https://github.com/deepseek-ai/deepseek-harness)',
})

let cached = null

/**
 * 解析归因头（进程内只解析一次）。
 * @param {{ debug?: (msg: string, ...args: unknown[]) => void } | undefined} [logger]
 * @returns {Promise<Readonly<Record<string, string>>>}
 */
export function resolveAttributionHeaders(logger) {
  if (!cached) {
    cached = (async () => {
      try {
        const mod = await import('@deepseek-ai/dsh-llm')
        const headers = typeof mod?.attributionHeaders === 'function' ? mod.attributionHeaders() : undefined
        if (headers && typeof headers === 'object') {
          const entries = Object.entries(headers).filter(
            ([key, value]) => typeof key === 'string' && key !== '' && typeof value === 'string' && value !== '',
          )
          if (entries.length > 0) return Object.freeze(Object.fromEntries(entries))
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger?.debug?.(`deepseek-web-api: 归因头模块不可用，使用字面量兜底（${message}）`)
      }
      return FALLBACK_HEADERS
    })()
  }
  return cached
}

/** 仅测试用：清掉缓存，让下一次调用重新解析。 */
export function resetAttributionCache() {
  cached = null
}

export { FALLBACK_HEADERS }
