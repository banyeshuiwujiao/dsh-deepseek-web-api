import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * deepseek-web-api 服务的后端进程生命周期管理器。
 * 类似 dsh-camofox-browser 管理 camofox 服务的机制：
 *   1. 优先复用已有实例（健康检查 GET /health）；
 *   2. 若未运行且开启 autoStart，自动以子进程拉起 deepseek-web-api；
 *   3. 自动解析本地 API Key（优先配置/环境变量，缺省自动读取 data/.api-key）；
 *   4. 宿主退出/插件卸载时回收拉起的子进程。
 */

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

export async function ping(opts = {}) {
  const url = `${opts.baseUrl || 'http://127.0.0.1:8787'}/health`
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return false
    const data = await res.json().catch(() => null)
    return Boolean(data && data.ok)
  } catch {
    return false
  }
}

export function createBackendManager(opts = {}, logger) {
  let child = null
  let starting = null
  const recentLogs = []

  function remember(line) {
    if (!line) return
    recentLogs.push(line)
    if (recentLogs.length > 50) recentLogs.shift()
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
    const proc = spawn(nodeBin, [distEntry, 'start'], {
      cwd: opts.serverDir,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    proc.stdout.on('data', (buf) => remember(String(buf).trimEnd()))
    proc.stderr.on('data', (buf) => remember(String(buf).trimEnd()))
    proc.on('exit', (code) => {
      remember(`[deepseek-web-api 退出] code=${code}`)
      if (child === proc) child = null
    })

    child = proc
    return proc
  }

  async function ensure() {
    if (await ping(opts)) return
    if (!opts.autoStart) {
      throw new Error(
        `deepseek-web-api 服务未在 ${opts.baseUrl} 运行，且 autoStart=false。\n` +
        `请手动启动服务或在配置中开启 autoStart: true。`
      )
    }

    if (starting) return starting

    starting = (async () => {
      logger?.info?.(`[deepseek-web-api] 正在启动后端反代服务: ${opts.serverDir}`)
      spawnServer()

      const timeoutMs = Number(opts.startTimeoutMs || 60000)
      const deadline = Date.now() + timeoutMs

      while (Date.now() < deadline) {
        if (child === null) {
          throw new Error(
            `deepseek-web-api 服务启动失败（进程退出）。最近日志:\n${recentLogs.join('\n')}`
          )
        }
        if (await ping(opts)) {
          logger?.info?.(`[deepseek-web-api] 后端服务已就绪 (${opts.baseUrl})`)
          return
        }
        await new Promise((r) => setTimeout(r, 600))
      }

      throw new Error(
        `deepseek-web-api 服务在 ${timeoutMs}ms 内未就绪。最近日志:\n${recentLogs.join('\n')}`
      )
    })().finally(() => {
      starting = null
    })

    return starting
  }

  function dispose() {
    if (child) {
      try {
        child.kill()
      } catch {
        // 忽略可能已退出的异常
      }
      child = null
    }
  }

  return {
    ensure,
    dispose,
    tail: () => recentLogs.slice(-20).join('\n'),
    get isRunning() {
      return child !== null
    },
  }
}
