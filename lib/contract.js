/**
 * 插件对后端的契约校验。
 *
 * 为什么不用版本号当主契约：这台机器上的构建长时间停在一个标签上（DSML 解析、
 * include_usage、协议开关都落在 0.1.0 之后），只比 version 分辨不出新旧——
 * 真机上就发生过"复用了手工起的旧进程，注入的开关与 DSML 解析全部失效，
 * 但一切看起来正常"。所以硬门槛是 /health 自述的**能力清单**，版本只作次要信号。
 *
 * @module lib/contract.js
 */

/** 本插件依赖、且缺了会退回旧故障形态的能力。 */
export const REQUIRED_CAPABILITIES = Object.freeze([
  'dsml-tool-calls', // 否则网页原生标记协议会被当正文返回，回合被判"已完成"
  'protocol-switches', // 否则 DS_TOOLS / DS_TOOL_REASONING 无效，实时思考丢失
  'include-usage', // 否则流式没有 usage，宿主只能拿字符估算做上下文决策
  'health-self-description', // 否则本模块无法验证上面三条，只能瞎跑
])

/** 引入能力自述与 include_usage 的版本；低于它直接拒用。 */
export const MIN_BACKEND_VERSION = '0.2.0'

/** 解析 `x.y.z`（多余的段落忽略，预发布后缀忽略）；不合法返回 null。 */
export function parseVersion(raw) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(raw || '').trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** a < b 返回 -1，相等 0，大于 1；任一边不合法返回 null（表示"无法比较"）。 */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return null
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1
  }
  return 0
}

/**
 * 校验一次 /health 自述是否满足本插件的最低要求。
 * @param {object|null} health
 * @param {{ requiredCapabilities?: string[], minBackendVersion?: string }} [opts]
 * @returns {{ ok: boolean, problems: string[], unknown: boolean }}
 */
export function checkContract(health, opts = {}) {
  const required = Array.isArray(opts.requiredCapabilities) && opts.requiredCapabilities.length > 0
    ? opts.requiredCapabilities
    : [...REQUIRED_CAPABILITIES]
  const minVersion = typeof opts.minBackendVersion === 'string' && opts.minBackendVersion !== ''
    ? opts.minBackendVersion
    : MIN_BACKEND_VERSION

  if (!health || typeof health !== 'object') {
    return { ok: false, unknown: true, problems: ['后端 /health 没有回报能力清单（旧构建或不是本反代）'] }
  }

  const problems = []
  const capabilities = Array.isArray(health.capabilities) ? health.capabilities : []
  const unknown = capabilities.length === 0

  if (unknown) {
    problems.push(`后端不自述 capabilities，无法满足的能力：${required.join(' / ')}（多半是旧 dist，请在后端目录 pnpm build 后重启该服务）`)
  } else {
    for (const capability of required) {
      if (!capabilities.includes(capability)) problems.push(`后端缺少能力 ${capability}`)
    }
  }

  // 版本只在能力清单本身可信时参与判断：旧构建连字段都没有，比较数字没有意义。
  if (!unknown && minVersion) {
    const order = compareVersions(health.version, minVersion)
    if (order === null) {
      problems.push(`后端 version 无法解析: ${JSON.stringify(health.version)}`)
    } else if (order < 0) {
      problems.push(`后端版本 ${health.version} 低于本插件要求的 ${minVersion}`)
    }
  }

  return { ok: problems.length === 0, problems, unknown }
}

/** 拒用旧后端时的报错文本：必须同时给出"发生了什么"和"下一步敲什么命令"。 */
export function contractError(dirHint, problems) {
  return [
    'deepseek-web-api 后端不满足本插件的能力契约，已拒绝复用（避免"看起来正常但协议能力静默失效"）。',
    `缺失项：${problems.join('；')}`,
    dirHint ? `后端目录：${dirHint}` : '',
    '处理：在该目录执行 pnpm install && pnpm build 并重启服务；' +
      '或把 strictBackend 设为 false 强行复用（不推荐），也可用 requiredCapabilities 精确声明依赖。',
  ].filter(Boolean).join('\n')
}
