import { spawnSync } from 'node:child_process'

/**
 * 进程树回收。
 *
 * 背景：插件拉起的是 `node dist/index.js start`，而后端自己还会再拉起 headless Chrome（CDP 端口）。
 * `child.kill()` 在 Windows 上只杀直接子进程，Chrome 会变成孤儿继续占着 CDP 端口与用户数据目录，
 * 下一个后端起来又通过 data/chrome.cdp 把它捡走——看着"复用很顺"，其实是泄漏（真机上验证过：
 * Chrome PID 的父进程是一个早已被杀掉的后端）。
 *
 * @module lib/process.js
 */

/** 探测某个 PID 是否还活着（不发信号）。 */
export function isAlive(pid) {
  const numeric = Number(pid)
  if (!Number.isInteger(numeric) || numeric <= 0) return false
  try {
    process.kill(numeric, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * 连带子进程一起结束。
 * @param {number} pid 目标进程
 * @param {{ force?: boolean, platform?: NodeJS.Platform }} [options]
 * @returns {{ ok: boolean, method: string, detail: string }}
 */
export function killProcessTree(pid, options = {}) {
  const numeric = Number(pid)
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return { ok: false, method: 'none', detail: `无效 PID: ${pid}` }
  }
  const platform = options.platform || process.platform
  const force = options.force !== false

  if (platform === 'win32') {
    // taskkill /T 会沿父子关系往下收，Chrome 这类孙进程一起带走。
    const args = ['/PID', String(numeric), '/T']
    if (force) args.push('/F')
    const result = spawnSync('taskkill', args, { windowsHide: true, encoding: 'utf8' })
    const detail = String(result.stderr || result.stdout || '').trim()
    if (result.status === 0) return { ok: true, method: 'taskkill', detail }
    // 128/无进程：目标已经自己退了，按幂等成功处理
    const alreadyGone = /没有这样的进程|not found|No such/i.test(detail)
    return { ok: alreadyGone, method: 'taskkill', detail: detail || `exit=${result.status}` }
  }

  // POSIX：负号打的是整个进程组（要求 spawn 时 detached，见 buildSpawnPlan）。
  try {
    process.kill(-numeric, force ? 'SIGKILL' : 'SIGTERM')
    return { ok: true, method: 'process-group', detail: `pgid=${numeric}` }
  } catch (error) {
    const code = error?.code
    if (code === 'ESRCH') return { ok: true, method: 'process-group', detail: '进程组已退出' }
    // 不是组长（没 detached）时退化成单进程信号，至少不比旧行为差。
    try {
      process.kill(numeric, force ? 'SIGKILL' : 'SIGTERM')
      return { ok: true, method: 'single', detail: `进程组信号失败(${code})，退化为单进程` }
    } catch (inner) {
      return { ok: false, method: 'single', detail: String(inner?.code || inner) }
    }
  }
}

/**
 * 决定怎么拉起后端。
 * - 托管模式（默认）：pipes，插件能 tail 最近日志、能在 dispose 时收树；代价是父进程一旦被强杀，
 *   子进程写 stdout 会 EPIPE 而自己退出（对"宿主退出=服务该停"是正确行为，但一次性脚本会误伤）。
 * - detach 模式：新进程组 + stdio 落文件（配了 logFile）或忽略，父进程退出不再牵连后端。
 *
 * @param {{ detach?: boolean, logFile?: string, cwd?: string, serverDir?: string }} opts
 * @param {{ stdout?: number | import('node:fs').SyncWriteStream, stderr?: number | import('node:fs').SyncWriteStream }} [fds]
 */
export function buildSpawnPlan(opts = {}, fds = {}) {
  const detached = opts.detach === true
  // fd 号或 SyncWriteStream 都能直接给 spawn 当 stdio 用
  const useFiles = detached === true && Boolean(opts.logFile) && Boolean(fds.stdout) && Boolean(fds.stderr)
  return {
    detached,
    windowsHide: true,
    cwd: opts.cwd || opts.serverDir,
    stdio: detached
      ? useFiles ? ['ignore', fds.stdout, fds.stderr] : ['ignore', 'ignore', 'ignore']
      : ['ignore', 'pipe', 'pipe'],
  }
}

/**
 * 传给后端子进程的变量白名单。
 *
 * 原先是 `{...process.env}` 全量继承：DSH 进程里的任何变量都会渗进后端
 * （npm_config_*、VIRTUAL_ENV、PYTHONPATH、别的插件的 CAMOFOX_PORT、DEEPSEEK_API_KEY 等），
 * 其中 `PORT`、`DS_*` 这类同名变量还会**静默改变后端行为**，排查时根本看不出来。
 * 只放两类：跑起 Node 与 Chrome 必需的 OS 变量，以及后端自己声明的 `DS_` 命名空间
 * （见反代 src/config/env.ts：DS_DATA_DIR/DS_AUTH_FILE/DS_CDP/DS_CHROME_PATH/DS_DEBUG/DS_POW_JS…）。
 */
export const ENV_BASE_ALLOWLIST = Object.freeze([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'TEMP', 'TMP', 'HOME',
  'TZ', 'LANG', 'LC_ALL',
])

/** 后端认识的命名空间；其余环境变量一律不进子进程。 */
export const ENV_PASSTHROUGH_PREFIX = 'DS_'

/**
 * 组子进程环境。
 * @param {Record<string, string | undefined>} source 通常传 process.env
 * @param {{ inject?: Record<string, string | number>, extraKeys?: string[] }} [options]
 *   inject 为插件显式设定（优先级最高），extraKeys 给用户兜底自己需要透传的变量名。
 * @returns {{ env: Record<string, string>, keys: string[] }}
 */
export function buildChildEnv(source = {}, options = {}) {
  const env = {}
  for (const key of ENV_BASE_ALLOWLIST) {
    const value = source[key]
    if (typeof value === 'string' && value !== '') env[key] = value
  }
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith(ENV_PASSTHROUGH_PREFIX)) continue
    if (typeof value !== 'string' || value === '') continue
    env[key] = value
  }
  for (const key of Array.isArray(options.extraKeys) ? options.extraKeys : []) {
    const value = source[key]
    if (typeof key === 'string' && typeof value === 'string' && value !== '') env[key] = value
  }
  for (const [key, value] of Object.entries(options.inject || {})) {
    if (value === undefined || value === null || value === '') continue
    env[key] = String(value)
  }
  return { env, keys: Object.keys(env).sort() }
}
