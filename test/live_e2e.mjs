import { createBackendManager } from "../lib/server.js"
import { DeepSeekWebApiAdapter } from "../lib/provider.js"

const opts = {
  baseUrl: "http://127.0.0.1:8787",
  serverDir: "C:\\Users\\Admin\\DeepSeek_Harness\\git-repo\\deepseek-web-api",
  autoStart: true,
  startTimeoutMs: 90000,
  toolReasoning: "clean",
  tools: "text",
  defaultMaxTokens: 32768,
}

const logger = {
  info: (...a) => console.log("[info]", ...a),
  warn: (...a) => console.log("[warn]", ...a),
  debug: () => {},
}

console.log("== 1) 由插件自己拉起后端（验证 spawnServer + env 注入路径）==")
const manager = createBackendManager(opts, logger)
await manager.ensure()
console.log("ensure() ok; isRunning(spawned by us) =", manager.isRunning)

const adapter = new DeepSeekWebApiAdapter(opts, manager, logger)
const resolved = await adapter.resolveModel("deepseek-web-api", "deepseek-web-thinking")
console.log("resolveModel:", JSON.stringify(resolved.context), "defaultMaxTokens =", resolved.defaultMaxTokens)

console.log("\n== 2) 真实工具回合：验证 usage / 结构化调用 / 无协议残留 ==")
const t0 = Date.now()
const chunks = []
for await (const chunk of adapter.stream("deepseek-web-thinking", {
  system: "You are a terse assistant. Use tools when asked to run something.",
  messages: [{ role: "user", content: "用 pwsh 工具输出 hello，不要写正文。" }],
  tools: [
    {
      name: "pwsh",
      description: "Run a PowerShell command.\n第二行说明：支持管道与多行脚本。",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  ],
  maxTokens: 4096,
})) {
  chunks.push(chunk)
  if (chunk.type === "reasoning-delta" && chunks.filter((c) => c.type === "reasoning-delta").length === 1) {
    console.log(`  首个推理增量 +${Date.now() - t0}ms`)
  }
}

const types = chunks.map((c) => c.type)
console.log("  chunk 序列:", types.join(" -> "))
console.log("  usage:", JSON.stringify(chunks.filter((c) => c.type === "usage").map((c) => c.usage)))
const calls = chunks.filter((c) => c.type === "tool-call-delta")
console.log("  tool-call-delta:", JSON.stringify(calls.map((c) => ({ id: c.id, name: c.name, args: c.argumentsDelta }))))
const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("")
console.log("  正文:", JSON.stringify(text.slice(0, 200)))
console.log("  finish:", JSON.stringify(chunks.find((c) => c.type === "finish")?.reason))
console.log("  总耗时:", Date.now() - t0, "ms")

console.log("\n== 3) 保留后端进程供客户端复用（不调用 dispose）==")
// 后端子进程的 stdio 管道会挂住事件循环，脚本必须显式退出（后端本身不受影响，继续监听 8787）。
process.exit(0)
