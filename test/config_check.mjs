/**
 * 配置样板的结构自检（不依赖任何第三方 YAML 解析器，CI 可直接跑）。
 *
 * 为什么需要它：`cordis.patch.yml` 是宿主插件的唯一装配入口，缩进或键名写错时
 * cordis 不会给出有用的报错，最坏情况是插件静默不加载（用户只会觉得"模型没了"）。
 * 2026-10-20 还发生过另一类事故：整文件提交时把工作副本里别人的在途删除一起卷走，
 * 所以这里同时钉住"必须存在的键"，缺了就红。
 *
 * @module test/config_check.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PROVIDER_ID = 'dsh-deepseek-web-api-provider'
export const MODULE_NAME = 'dsh-deepseek-web-api/provider'

/** 这些键必须存在；取值可以因地制宜（本机路径、开关值另有校验）。 */
export const REQUIRED_KEYS = Object.freeze([
  'baseUrl',
  'serverDir',
  'autoStart',
  'startTimeoutMs',
  'maxContextWindow',
  'defaultMaxTokens',
  'toolDescriptionMaxChars',
  'toolReasoning',
  'tools',
  'healthTtlMs',
  'streamIdleTimeoutMs',
  'logFile',
  'detach',
  'killTreeOnDispose',
  'passEnvKeys',
])

/** 后端认识的开关取值，写错会让反代直接启动失败。 */
const ENUMS = Object.freeze({
  toolReasoning: ['clean', 'hidden'],
  tools: ['text', 'native'],
})

const indentOf = (line) => line.length - line.trimStart().length
/** 去掉行首缩进与列表短横后的内容：样板里是 `- id: ...`，不能按整行相等去比。 */
const bare = (line) => line.trim().replace(/^-\s+/, '')

/**
 * 逐行检查缩进：禁止 Tab，缩进必须是偶数宽（本项目约定 2 空格一级）。
 * @param {string} text
 * @returns {string[]}
 */
export function checkIndentation(text) {
  const problems = []
  text.split(/\r?\n/).forEach((line, index) => {
    const where = `第 ${index + 1} 行`
    if (line.includes('\t')) problems.push(`${where} 含 Tab，YAML 缩进必须用空格`)
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const indent = indentOf(line)
    if (indent % 2 !== 0) problems.push(`${where} 缩进 ${indent} 空格，不是 2 的倍数`)
  })
  return problems
}

/**
 * 取出某个 insert 条目下 `config:` 的键名列表。
 * 键的绝对缩进宽度不写死：按该文件里 `config:` 自身的缩进推下一级，
 * 这样样板改缩进也不会误报（真文件里刚栽过一次）。
 * @param {string[]} lines
 * @param {number} configLineIndex
 * @returns {{ keys: string[], end: number }}
 */
export function readConfigKeys(lines, configLineIndex) {
  const keys = []
  const baseIndent = indentOf(lines[configLineIndex])
  const keyIndent = baseIndent + 2
  for (let i = configLineIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('#')) continue
    const indent = indentOf(line)
    if (indent < keyIndent) break // 出了这一段
    if (indent === keyIndent) {
      const match = trimmed.match(/^([A-Za-z][A-Za-z0-9_]*):/)
      if (match) keys.push(match[1])
    }
  }
  return { keys, end: lines.length }
}

/**
 * 检查 provider 块的存在、装配入口、必需键、取值与 baseUrl 安全边界。
 * @param {string} text
 * @returns {{ problems: string[], keys: string[] }}
 */
export function checkProviderBlock(text) {
  const problems = []
  const lines = text.split(/\r?\n/)

  if (!lines.some((line) => line.trim() === '- insert:')) problems.push('缺少 `- insert:` 装配入口')
  const idIndex = lines.findIndex((line) => bare(line) === `id: ${PROVIDER_ID}`)
  if (idIndex === -1) problems.push(`缺少 id: ${PROVIDER_ID}`)
  const nameIndex = lines.findIndex((line) => bare(line) === `name: ${MODULE_NAME}`)
  if (nameIndex === -1) problems.push(`缺少 name: ${MODULE_NAME}`)

  let keys = []
  const configIndex = lines.findIndex((line, i) => i > idIndex && bare(line) === 'config:')
  if (idIndex >= 0 && configIndex === -1) {
    problems.push(`${PROVIDER_ID} 条目下缺少 config: 段`)
  } else if (configIndex >= 0) {
    keys = readConfigKeys(lines, configIndex).keys
    for (const key of REQUIRED_KEYS) {
      if (!keys.includes(key)) problems.push(`config 里缺少键 ${key}`)
    }
    for (const [key, allowed] of Object.entries(ENUMS)) {
      const value = lines.find((l) => l.trim().startsWith(`${key}:`))?.trim().slice(key.length + 1).trim()
      const bare = value?.replace(/^['"]|['"]$/g, '')
      if (bare && !allowed.includes(bare)) problems.push(`${key} 取值非法: ${bare}（只能 ${allowed.join(' / ')}）`)
    }
  }

  // baseUrl 必须只绑回环：这个反代携带网页登录态，暴露到网络等于交出账号
  const baseUrls = [...text.matchAll(/baseUrl:\s*'([^']+)'/g)].map((m) => m[1])
  if (baseUrls.length === 0) problems.push('缺少 baseUrl')
  for (const raw of baseUrls) {
    let host = ''
    try {
      host = new URL(raw).hostname
    } catch {
      problems.push(`baseUrl 不是合法 URL: ${raw}`)
      continue
    }
    const loopback = host === 'localhost' || host === '::1' || host.startsWith('127.')
    if (!loopback) problems.push(`baseUrl 必须只绑回环（当前 host=${host}）：反代携带网页登录态，暴露到网络等于交出账号`)
  }

  return { problems, keys }
}

/** 一次跑完全部检查。 */
export function check(text) {
  const block = checkProviderBlock(text)
  return { problems: [...checkIndentation(text), ...block.problems], keys: block.keys }
}

function main() {
  const text = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')
  const { problems, keys } = check(text)
  if (problems.length > 0) {
    console.error('❌ cordis.patch.yml 结构检查未通过:')
    for (const problem of problems) console.error('  - ' + problem)
    process.exit(1)
  }
  console.log(`✅ cordis.patch.yml 结构检查通过（${keys.length} 个配置键齐全，baseUrl 只绑回环，开关取值合法）`)
}

// 直接执行才自检；被 import 时只暴露纯函数。判定必须走 pathToFileURL——
// Windows 上手拼 file:// 盘符路径比不上，会让整个检查静默不跑（真发生过）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
