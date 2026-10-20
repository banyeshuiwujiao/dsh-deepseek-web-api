import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PROVIDER_ID, DeepSeekWebApiAdapter } from '../lib/provider.js'

const llmRoot = join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-llm')
const imp = (rel) => import(pathToFileURL(join(llmRoot, rel)).href)
const { LlmRuntime } = await imp('lib/index.js')
const cordisRoot = join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'cordis')
const { Context } = await import(pathToFileURL(join(cordisRoot, 'lib', 'index.js')).href)

async function withRuntime(fn) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  try {
    return await fn(ctx)
  } finally {
    await ctx.stop?.()
  }
}

await withRuntime(async (ctx) => {
  const adapter = new DeepSeekWebApiAdapter({
    baseUrl: 'http://127.0.0.1:8787',
    autoStart: false,
  })
  ctx.llm.registerAdapter([PROVIDER_ID], adapter)
  const prepared = await ctx.llm.prepareCall({ provider: PROVIDER_ID, model: 'deepseek-web-flash' })
  console.log('真实 DSH LlmRuntime prepareCall 结果:', JSON.stringify({
    config: prepared.config,
    hasStream: typeof prepared.stream === 'function',
  }))
  assert.equal(typeof prepared.stream, 'function')
  assert.equal(prepared.config.model, 'deepseek-web-flash')
  console.log('✅ 真实 DSH LlmRuntime 集成回归通过')
})
