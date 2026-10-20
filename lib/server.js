import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { buildSpawnPlan, isAlive, killProcessTree } from './process.js'

/**
 * deepseek-web-api 服务的后端进程生命周期管理器。
 * 类似 dsh-camofox-browser 管理 camofox 服务的机制：
 *   1. 优先复用已有实例（健康检查 GET /health，结果按 TTL 缓存，避免每一步都探活）；
 *   2. 若未运行且开启 autoStart，自动以子进程拉起 deepseek-web-api；
 *   3. 自动解析本地 API Key（优先配置/环境变量，缺省自动读取 data/.api-key）；
 *   4. 宿主退出/插件卸载时按**进程树**回收拉起的后端（连带它自己起的 headless Chrome）；
 *      `detach: true` 则相反——后端成为独立进程组，插件退出也不牵连它，用于"起了就一直在"的用法；
 *   5. 复用别人起的进程时，比对 /health 回报的构建版本与协议开关，不一致就告警
 *      （真机上吃过亏：跑的是手工起的旧进程，插件注入的开关从未生效，日志也证明不了）。
 */

const DEFAULT_HEALTH_TTL_MS = 30000
const LOG_FILE_MAX_BYTES = 2 * 1024 * 1024

export function resolveApiKey(opts = {}) {
  if (typeof opts.apiKey === 'string' && opts.apiKey.trim() !== '') {
    return opts.apiKey.trim()
  }
  if (process.env.DS_API_KEY && process.env.DS_API_KEY.trim() !== '') {
    return process.env.DS_API_KEY.trim()
  }
  const keyFile = join(opts.serverDir || '', 'data', '.api-key')
  if (existsSync(keyFile)) {
    try {
      const content = readFileSync(keyFile, 'utf8').trim()
      if (content) return content
    } catch {
      // 忽略文件读取异常
    }
  }
  return ''
}

/** 探活并取回 /health 的自述信息；不在线或形状不对返回 null。 */
export async function probe(opts = {}) {
  const url = `${opts.baseUrl || 'http://127.0.0.1:8787'}/health`
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(Number(opts.probeTimeoutMs || 3000)),
    })
    if (!res.ok) return null
    const data = await res.json().catch(() => null)
    return data && data.ok === true ? data : null
  } catch {
    return null
  }
}

/** 兼容旧调用点：只关心在不在跑。 */
export async function ping(opts = {}) {
  return (await probe(opts)) !== null
}

/**
 * 比对复用实例自述的配置与插件期望。
 * @returns {{ stale: boolean, mismatches: string[] }}
 */export function diffHealth(health, opts = {}) {
  const mismatches = []
  if (!health || typeof health !== 'object') return { stale: true, mismatches: ['旧构建：/health 不自述版本与协议开关'] }
  if (typeof health.version !== 'string') mismatches.push('旧构建：/health 没有 version 字段')
  if (opts.toolReasoning && health.toolReasoning && health.toolReasoning !== opts.toolReasoning) {
    mismatches.push(`DS_TOOL_REASONING 实际是 ${health.toolReasoning}，插件配置是 ${opts.toolReasoning}`)
  }
  if (opts.tools && health.toolCalls && health.toolCalls !== opts.tools) {
    mismatches.push(`DS_TOOLS 实际是 ${health.toolCalls}，插件配置是 ${opts.tools}`)
  }
  if (health.authReady === false) mismatches.push('后端还没有可用的登录凭据快照（authReady=false）')
  return { stale: mismatches.length > 0 && mismatches[0].startsWith('旧构建'), mismatches }
}

export function createBackendManager(opts = {}, logger) {
  let child = null
  let starting = null
  let cachedHealth = null
  let healthyUntil = 0
  let lastPid = 0
  const recentLogs = []

  const note = (level, message) => {
    const text = `deepseek-web-api: ${message}`
    if (typeof logger?.[level] === 'function') logger[level](text)
  }

  function writeLogFile(line) {
    if (!opts.logFile) return
    try {
      mkdirSync(dirname(opts.logFile), { recursive: true })
      appendFileSync(opts.logFile, `${new Date().toISOString()} ${line}\n`, 'utf8')
      if (statSync(opts.logFile).size > LOG_FILE_MAX_BYTES) {
        const rotated = `${opts.logFile}.1`
        if (existsSync(rotated)) unlinkSync(rotated)
        appendFileSync(`${opts.logFile}.1`, readFileSync(opts.logFile), 'utf8')
      }
    } catch {
      // 日志落盘失败不该影响推理链路
    }
  }

  function remember(line) {
    if (!line) return
    for (const row of String(line).split('\n')) {
      if (!row) continue
      recentLogs.push(row)
      if (recentLogs.length > 200) recentLogs.shift()
      writeLogFile(row)
    }
  }

  function spawnServer() {
    const distEntry = join(opts.serverDir || '', 'dist', 'index.js')
    if (!opts.serverDir || !existsSync(distEntry)) {
      throw new Error(
        `找不到 deepseek-web-api 服务入口: ${distEntry}。\n` +
        `请先在 ${opts.serverDir || '(未配置)'} 下执行 pnpm install && pnpm build。`
      )
    }

    const env = {
      ...process.env,
      PORT: String(new URL(opts.baseUrl || 'http://127.0.0.1:8787').port || 8787),
      // clean：工具回合也推送 reasoning 增量，DSH 的深度思考气泡才能实时流式显示。
      DS_TOOL_REASONING: opts.toolReasoning || 'clean',
      // text：沿用 JSON 文本工具协议（native 会改为要求网页原生标记协议）。
      DS_TOOLS: opts.tools || 'text',
      ...(opts.env || {}),
    }

    const nodeBin = opts.nodePath || process.execPath
    // detach 模式下 stdio 不能是 pipe：父进程一旦退出，管道断裂会让后端写 stdout 时 EPIPE 自杀
    // （真机上就是这么把 8787 弄没的）。所以要么落文件，要么直接 ignore。
    const fds = opts.detach === true && opts.logFile ? openLogFileStreams(opts.logFile) : {}
    const plan = buildSpawnPlan({ ...opts, cwd: opts.serverDir }, fds)
    const proc = spawn(nodeBin, [distEntry, 'start'], { ...plan, env })
    lastPid = proc.pid
    note('info', `已拉起后端 PID=${proc.pid} 模式=${opts.detach === true ? 'detach' : '托管'}`)

    if (proc.stdout) proc.stdout.on('data', (buf) => remember(String(buf).trimEnd()))
    if (proc.stderr) proc.stderr.on('data', (buf) => remember(String(buf).trimEnd()))
    proc.on('exit', (code) => {
      remember(`[deepseek-web-api 退出] code=${code}`)
      if (child === proc) child = null
      cachedHealth = null
      healthyUntil = 0
    })
    proc.on('error', (error) => remember(`[deepseek-web-api 进程错误] ${error?.message || error}`))

    if (opts.detach === true) {
      // 不再拖住宿主的退出；此后后端的生命线与插件解耦。
      child = null
      proc.unref?.()
    } else {
      child = proc
    }
    return proc
  }

  /** 探活 + 配置比对；比对不一致只告警，不阻断（复用可能是有意为之）。 */
  async function freshHealth() {
    const health = await probe(opts)
    if (health) {
      cachedHealth = health
      healthyUntil = Date.now() + Number(opts.healthTtlMs || DEFAULT_HEALTH_TTL_MS)
      const { mismatches } = diffHealth(health, opts)
      for (const item of mismatches) note('warn', `复用的后端与插件配置不一致：${item}`)
      if (mismatches.length === 0) {
        note('debug', `后端自述 version=${health.version} toolReasoning=${health.toolReasoning} toolCalls=${health.toolCalls}`)
      }
    } else {
      cachedHealth = null
      healthyUntil = 0
    }
    return health
  }

  async function ensure() {
    const ttl = Number(opts.healthTtlMs || DEFAULT_HEALTH_TTL_MS)
    if (ttl > 0 && cachedHealth && Date.now() < healthyUntil) return cachedHealth
    const alive = await freshHealth()
    if (alive) return alive
    if (!opts.autoStart) {
      throw new Error(
        `deepseek-web-api 服务未在 ${opts.baseUrl} 运行，且 autoStart=false。\n` +
        `请手动启动服务或在配置中开启 autoStart: true。`
      )
    }

    if (starting) return starting

    starting = (async () => {
      note('info', `正在启动后端反代服务: ${opts.serverDir}`)
      spawnServer()

      const timeoutMs = Number(opts.startTimeoutMs || 60000)
      const deadline = Date.now() + timeoutMs

      while (Date.now() < deadline) {
        // detach 模式下 child 被刻意置空（不与宿主绑定），判存活只能看 PID：
        // 否则就绪轮询会把"我们主动解耦"误读成"进程崩了"。
        if (lastPid !== 0 && !isAlive(lastPid)) {
          const where = opts.logFile ? `详见日志文件 ${opts.logFile}` : '(无最近日志)'
          throw new Error(
            `deepseek-web-api 服务启动失败（PID=${lastPid} 已退出）。${where}\n` +
            `最近日志:\n${recentLogs.slice(-30).join('\n')}`
          )
        }
        const ready = await freshHealth()
        if (ready) {
          note('info', `后端服务已就绪 (${opts.baseUrl})`)
          return ready
        }
        await new Promise((r) => setTimeout(r, 600))
      }

      throw new Error(
        `deepseek-web-api 服务在 ${timeoutMs}ms 内未就绪。最近日志:\n${recentLogs.slice(-30).join('\n')}`
      )
    })().finally(() => {
      starting = null
    })

    return starting
  }

  function dispose() {
    // detach 模式下后端是有意留给宿主之外的一直在跑的进程，dispose 不该动它。
    if (opts.detach === true) {
      note('info', `detach 模式：保留后端 PID=${lastPid}，不由插件回收`)
      cachedHealth = null
      healthyUntil = 0
      return
    }
    const target = child?.pid || (isAlive(lastPid) ? lastPid : 0)
    if (target) {
      const killTree = opts.killTreeOnDispose !== false
      if (killTree) {
        const result = killProcessTree(target, { force: true })
        note('info', `回收后端进程树 PID=${target} method=${result.method} ok=${result.ok}${result.detail ? ` (${result.detail})` : ''}`)
        if (!result.ok) note('warn', `进程树回收未确认：${result.detail}`)
      } else {
        try {
          child?.kill()
          note('info', `仅回收直接子进程 PID=${target}（killTreeOnDispose=false）`)
        } catch {
          // 忽略可能已退出的异常
        }
      }
    }
    child = null
    cachedHealth = null
    healthyUntil = 0
  }

  return {
    ensure,
    dispose,
    health: () => cachedHealth,
    pid: () => (child?.pid || lastPid) ?? 0,
    tail: () => recentLogs.slice(-20).join('\n'),
    get isRunning() {
      return child !== null || isAlive(lastPid)
    },
  }
}

/** detach + logFile 组合下把后端 stdio 直接接到日志文件上。 */
function openLogFileStreams(logFile) {
  try {
    mkdirSync(dirname(logFile), { recursive: true })
    return {
      stdout: openSync(logFile, 'a'),
      stderr: openSync(logFile, 'a'),
    }
  } catch {
    return {}
  }
}
