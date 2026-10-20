import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * 后端目录与日志路径的解析。
 *
 * 为什么要单独一层：插件此前把 `C:\Users\Admin\DeepSeek_Harness\git-repo\deepseek-web-api`
 * 硬编码在三个地方（DEFAULTS、样板 yml、install.ps1），换台机器就三处都要手改，
 * 漏一处就是"模型能选但一调就挂"。这里把顺序固定下来，配置文件不再需要写绝对路径。
 *
 * @module lib/paths.js
 */

/** 指针文件：install.ps1 写入，记录本机后端真实位置。 */
export const DEFAULT_POINTER_FILE = '~/.dsh/deepseek-web-api.json'

/** 允许用户不改配置文件就指定后端目录的环境变量。 */
export const ENV_SERVER_DIR = 'DSH_DEEPSEEK_WEB_API_DIR'

/** 没找到后端时的常见候选位置（相对 home），按命中概率排序。 */
export const FALLBACK_CANDIDATES = Object.freeze([
  'DeepSeek_Harness/git-repo/deepseek-web-api',
  'DeepSeek_Harness/deepseek-web-api',
  'git-repo/deepseek-web-api',
  'deepseek-web-api',
  'Desktop/DeepSeek_Harness/git-repo/deepseek-web-api',
  'Documents/DeepSeek_Harness/git-repo/deepseek-web-api',
])

/** 源码形态下（未装到运行时镜像时）插件自身往上找的位置。 */
export const SIBLING_CANDIDATES = Object.freeze([
  '../../../git-repo/deepseek-web-api',
  '../../git-repo/deepseek-web-api',
  '../deepseek-web-api',
])

/** 把 `~` 或 `~/x` 展开成用户主目录下的路径；绝对路径原样返回。 */
export function expandHome(raw, home = homedir()) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return ''
  if (text === '~') return home
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(home, text.slice(2))
  return text
}

/** 判定"这是一个可用的反代后端目录"：必须有构建产物 dist/index.js。 */
export function isBackendDir(dir, exists = existsSync) {
  if (!dir) return false
  return exists(join(dir, 'dist', 'index.js'))
}

/** 读指针文件；任何异常都当作"没有指针"，不让日志/配置读取打断推理链路。 */
export function readPointer(file, io = { existsSync, readFileSync }) {
  const path = expandHome(file)
  if (!path || !io.existsSync(path)) return null
  try {
    const parsed = JSON.parse(io.readFileSync(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && typeof parsed.serverDir === 'string') {
      return { serverDir: parsed.serverDir, gitRev: typeof parsed.gitRev === 'string' ? parsed.gitRev : null }
    }
  } catch {
    // 指针坏了就当没有，回落到候选发现
  }
  return null
}

/** 写指针文件（install.ps1 调用；目录不存在会创建）。 */
export function writePointer(file, serverDir, gitRev = null, io = { mkdirSync, writeFileSync }) {
  const path = expandHome(file)
  io.mkdirSync(dirname(path), { recursive: true })
  io.writeFileSync(path, `${JSON.stringify({ serverDir, gitRev, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  return path
}

/**
 * 解析后端目录。优先级：配置 > 环境变量 > 指针文件 > 插件同级（源码形态）> home 下常见位置。
 *
 * 注意配置项的处理：显式写了但目录里没有 dist，不再直接失败，而是**继续往下找**并把这件事记进
 * `notes`——因为"配置文件里的绝对路径属于另一台机器"正是本模块要解决的故障；
 * 让过期配置一票否决，等于把可移植性又锁回了手改。
 *
 * @param {{ serverDir?: string, pointerFile?: string }} opts
 * @param {{ env?: Record<string,string|undefined>, home?: string, pluginDir?: string, exists?: (p:string)=>boolean, read?: (p:string)=>string }} [io]
 * @returns {{ dir: string, source: string, notes: string[] }}
 */
export function resolveServerDir(opts = {}, io = {}) {
  const env = io.env || process.env
  const home = io.home || homedir()
  const exists = io.exists || existsSync
  const read = io.read || ((p) => readFileSync(p, 'utf8'))
  const notes = []

  const configured = expandHome(opts.serverDir, home)
  if (configured) {
    if (isBackendDir(configured, exists)) return { dir: configured, source: 'config', notes }
    notes.push(`配置里的 serverDir 没有 dist/index.js，已忽略并继续探测: ${configured}`)
  }

  const fromEnv = expandHome(env[ENV_SERVER_DIR], home)
  if (fromEnv) {
    if (isBackendDir(fromEnv, exists)) return { dir: fromEnv, source: `env:${ENV_SERVER_DIR}`, notes }
    notes.push(`环境变量 ${ENV_SERVER_DIR} 指向的目录没有 dist/index.js: ${fromEnv}`)
  }

  const pointer = readPointer(opts.pointerFile || DEFAULT_POINTER_FILE, { existsSync: exists, readFileSync: read })
  if (pointer && isBackendDir(pointer.serverDir, exists)) {
    return { dir: pointer.serverDir, source: 'pointer', notes: [...notes, ...(pointer.gitRev ? [`指针记录的后端 git 版本 ${pointer.gitRev}`] : [])] }
  }

  if (io.pluginDir) {
    for (const rel of SIBLING_CANDIDATES) {
      const candidate = resolve(join(io.pluginDir, rel))
      if (isBackendDir(candidate, exists)) return { dir: candidate, source: 'sibling', notes }
    }
  }

  for (const rel of FALLBACK_CANDIDATES) {
    const candidate = join(home, rel)
    if (isBackendDir(candidate, exists)) return { dir: candidate, source: 'discover', notes }
  }

  const searched = [configured, fromEnv, expandHome(opts.pointerFile || DEFAULT_POINTER_FILE, home)]
    .filter(Boolean)
    .concat(FALLBACK_CANDIDATES.map((rel) => join(home, rel)))
  return {
    dir: '',
    source: 'none',
    notes: [...notes, `已尝试：${searched.join(' | ')}`],
  }
}

/** 解析日志文件路径（支持 `~`）；空值表示不落盘。 */
export function resolveLogFile(raw, home = homedir()) {
  const text = expandHome(raw, home)
  if (text === '') return ''
  if (text.startsWith('~')) return join(home, text.slice(2))
  return text
}

/** 读后端目录的 git 短版本（仅用于诊断与指针记录；不是 git 仓库就返回 null）。 */
export function readGitRev(dir) {
  if (!dir) return null
  try {
    // 只在确实需要时同步取一次；失败不影响推理链路。
    const result = spawnSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', windowsHide: true })
    const text = String(result.stdout || '').trim()
    return result.status === 0 && text !== '' ? text : null
  } catch {
    return null
  }
}
