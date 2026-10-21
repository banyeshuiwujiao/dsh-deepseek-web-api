/**
 * 从 ImageBlock 读取真实图片字节，转成 OpenAI image_url 使用的 data URL。
 *
 * 依据（2026-10-21 从内核 app.asar 的正式文档段落与本机实证双重确认）：
 *   - 布局：`<DSH_HOME>/attachments/v1/objects/<sha256前2位>/<sha256>`，
 *     "Objects land at <DSH_HOME>/attachments/v1/objects/<sha256-prefix>/<sha256>;
 *      equal bytes deduplicate to one object and one sha256: id."
 *   - 文件名即内容 sha256（本机抽样：Get-FileHash == 文件名），ContentBlock 的
 *     attachmentId 形如 `sha256:<digest>`，去掉前缀就是文件名。
 *   - 存的是原始图片字节（magic bytes 直接是 PNG/JPEG 头），mediaType 已随 block 提供。
 *
 * 失效模式刻意温和：读不到、超限、digest 形态不对，一律返回 null 让调用方回落到
 * 现有的文字占位符行为——这个插件已经被上游协议漂移咬过两次，这里不再引入硬依赖。
 *
 * @module lib/attachments.js
 */

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 与反代侧 MAX_ATTACHMENT_BYTES（12 MiB）对齐的本地预检上限：超限不发请求，走占位符。 */
export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024

/** 内核只允许这四种媒体类型（ImageMediaType），多余的一律不信。 */
const ALLOWED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** mediaType → 扩展名不一致时的最小校验表：文件 magic 必须与声明一致才可信。 */
const MAGIC_BY_MEDIA_TYPE = [
  ['image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff])],
  ['image/gif', Buffer.from([0x47, 0x49, 0x46, 0x38])],
  ['image/webp', Buffer.from('RIFF', 'ascii')],
]

/** `sha256:<hex>` → 纯 hex；其余形态（含路径穿越尝试）一律拒绝。 */
export function digestOf(attachmentId) {
  if (typeof attachmentId !== 'string') return null
  const match = /^sha256:([0-9a-f]{64})$/i.exec(attachmentId.trim())
  return match ? (match[1] ?? '').toLowerCase() : null
}

/** 附件对象存储根：默认 `~/.dsh`，测试可注入覆盖。 */
export function attachmentsRoot(dshHome) {
  const base = typeof dshHome === 'string' && dshHome.trim() !== '' ? dshHome.trim() : join(homedir(), '.dsh')
  return join(base, 'attachments', 'v1')
}

/** 由 digest 推导对象文件的确定性路径。 */
export function objectPath(root, digest) {
  return join(root, 'objects', digest.slice(0, 2), digest)
}

/** magic bytes 与声明的 mediaType 一致才返回 true：内容寻址已经保证了完整性，这是第二道闸。 */
export function magicMatches(mediaType, bytes) {
  const entry = MAGIC_BY_MEDIA_TYPE.find(([type]) => type === mediaType)
  if (!entry) return false
  const magic = entry[1]
  return bytes.length >= magic.length && magic.every((byte, index) => bytes[index] === byte)
}

/**
 * 把一个 image block 转成 OpenAI `image_url` part；任何失败都返回 null（调用方回落占位符）。
 *
 * @param {unknown} block 内核传来的 { type:'image', attachment:{ attachmentId, mediaType, bytes, ... } }
 * @param {{ root?: string, maxBytes?: number, readFile?: typeof readFile }} [io] 测试注入点
 * @returns {Promise<{ type: 'image_url', image_url: { url: string } } | null>}
 */
export async function imageDataUrlPart(block, io = {}) {
  const attachment = block?.attachment
  const mediaType = typeof attachment?.mediaType === 'string' ? attachment.mediaType : ''
  if (!ALLOWED_MEDIA_TYPES.has(mediaType)) return null

  const digest = digestOf(attachment?.attachmentId)
  if (!digest) return null

  const root = io.root ?? attachmentsRoot()
  const maxBytes = Number.isFinite(io.maxBytes) ? io.maxBytes : MAX_ATTACHMENT_BYTES
  const path = objectPath(root, digest)

  try {
    // 预检大小：stat 失败说明对象不存在（可能已被清理），同样走回落。
    const info = await stat(path)
    if (!info.isFile() || info.size <= 0 || info.size > maxBytes) return null
    const readFileImpl = io.readFile ?? readFile
    const bytes = await readFileImpl(path)
    if (!magicMatches(mediaType, bytes)) return null
    return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${bytes.toString('base64')}` } }
  } catch {
    // 文件缺失/权限/任何 IO 问题：温和回落，不把图片通路变成新的故障点。
    return null
  }
}

/**
 * 是不是内核的 image block。文件 block 走已有的路径转发机制，不归这里管。
 * @param {unknown} block
 */
export function isImageBlock(block) {
  return typeof block === 'object' && block !== null && block.type === 'image' && typeof block.attachment === 'object' && block.attachment !== null
}
